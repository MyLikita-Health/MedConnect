/**
 * B2c extension e2e proof — ADT^A01 patient-admission feeds, wired exactly
 * like `startHub`: the Hl7Gateway carries an `admissions` feed backed by the
 * hub's admission registry, and `hub.admissions` exposes the registered
 * patients. An ADT^A01 sent over MLLP registers the admission (AA ack); an
 * A03 discharge flips the status; a message that cannot be translated is
 * AR-rejected with reasons — never silently dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MllpDecoder, wrapMessage } from '@integration-hub/hl7';
import { startHub } from './index.js';
import type { Hub } from './index.js';

// Server integration tests are designed for in-memory stores. Explicitly
// unset DATABASE_URL so startHub() never silently flips into PG mode.
delete process.env.DATABASE_URL;

const ADT_A01 = [
  'MSH|^~\\&|ACME_HIS|FAC1|HUB|FAC2|20260904120000||ADT^A01|ADT-1|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'PV1|1|I|WARD-A^BED-3||||||||||||||||VIS-77',
].join('\r');

const ADT_A03 = ADT_A01.replace('ADT^A01|ADT-1', 'ADT^A03|ADT-2');

async function startHubWithHl7(t: any): Promise<Hub> {
  const hub = await startHub({ authDisabled: true, hl7Port: 0, httpPort: 0, devicePort: 0, seedDefaultAlerts: false });
  t.after(() => hub.stop());
  return hub;
}

function connect(port: number): Promise<{ socket: net.Socket; acks: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const acks: string[] = [];
      const decoder = new MllpDecoder({ onMessage: (p) => void acks.push(p) });
      socket.on('data', (c: Buffer) => decoder.feed(c));
      resolve({ socket, acks });
    });
    socket.once('error', reject);
  });
}

async function waitFor(pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

test('ADT^A01 over MLLP registers the patient admission on the hub (AA ack)', async (t) => {
  const hub = await startHubWithHl7(t);
  const { socket, acks } = await connect(hub.ports.hl7!);
  t.after(() => socket.destroy());

  socket.write(wrapMessage(ADT_A01));
  await waitFor(() => acks.length >= 1, 'ADT AA ack');
  assert.match(acks[0]!, /MSA\|AA\|ADT-1/);

  await waitFor(async () => (await hub.admissions.find('PID-1001')).length === 1, 'admission registered');
  const [admission] = await hub.admissions.find('PID-1001');
  assert.equal(admission!.patientId, 'PID-1001');
  assert.equal(admission!.name, 'Adeyemi, Tunde');
  assert.equal(admission!.dateOfBirth, '19850312');
  assert.equal(admission!.gender, 'M');
  assert.equal(admission!.visitId, 'VIS-77');
  assert.equal(admission!.status, 'admitted');
});

test('ADT^A03 discharge flips the admission status', async (t) => {
  const hub = await startHubWithHl7(t);
  const { socket, acks } = await connect(hub.ports.hl7!);
  t.after(() => socket.destroy());

  socket.write(wrapMessage(ADT_A01));
  await waitFor(async () => (await hub.admissions.find('PID-1001')).length === 1, 'admission registered');
  socket.write(wrapMessage(ADT_A03));
  await waitFor(() => acks.length >= 2, 'A03 AA ack');
  assert.match(acks[1]!, /MSA\|AA\|ADT-2/);

  await waitFor(async () => (await hub.admissions.find('PID-1001'))[0]!.status === 'discharged', 'status discharged');
  assert.equal((await hub.admissions.find('PID-1001'))[0]!.status, 'discharged');
});

test('an ADT that cannot be translated is AR-rejected with reasons', async (t) => {
  const hub = await startHubWithHl7(t);
  const { socket, acks } = await connect(hub.ports.hl7!);
  t.after(() => socket.destroy());

  // No patient identifier → the admission cannot register → AR + reason.
  const bad = [
    'MSH|^~\\&|ACME_HIS|FAC1|HUB|FAC2|20260904120000||ADT^A01|ADT-3|P|2.3.1',
    'PID|1|||^NoId^X||19850312|M',
  ].join('\r');
  socket.write(wrapMessage(bad));
  await waitFor(() => acks.length >= 1, 'AR ack');
  assert.match(acks[0]!, /MSA\|AR\|ADT-3/);
  assert.match(acks[0]!, /Missing patient identifier/);
  assert.equal((await hub.admissions.find('PID-1001')).length, 0);
});