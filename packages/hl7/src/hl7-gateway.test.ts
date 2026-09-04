/**
 * Inbound HL7 gateway (workstream B2b) over real TCP: MLLP in → canonical
 * envelope → sink, with application-ACK semantics — AA on accept, AR with the
 * reasons when the content cannot be canonicalized (message still persisted,
 * never dropped), AE on a persistence failure. The sink here is a recording
 * fake; the real-Dispatcher proof (ROUTED / dedup) lives in the server
 * package's integration test, which wires the gateway the way `startHub`
 * will.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { CanonicalMessage, Hl7RecordLayout, MessageSink } from '@integration-hub/shared';
import { Hl7Gateway, type OrderFeed } from './hl7-gateway.js';
import type { OrderRegistration } from './order.js';
import { MllpDecoder, wrapMessage } from './mllp.js';
import { parseMessage, segmentField } from './message.js';

const ORU = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG0001|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'OBR|1|ORD-77|ACC-88|GLU^Glucose',
  'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
].join('\r');

interface Hub {
  messages: CanonicalMessage[];
  states: Array<[string, 'connected' | 'disconnected']>;
  errors: Error[];
  port: number;
}

async function startHub(t: any, sink?: MessageSink, orders?: OrderFeed, resolveLayout?: (deviceId: string) => Hl7RecordLayout | undefined): Promise<Hub> {
  const messages: CanonicalMessage[] = [];
  const states: Hub['states'] = [];
  const errors: Error[] = [];
  const gateway = new Hl7Gateway({
    host: '127.0.0.1',
    port: 0,
    sink: sink ?? { record: (m) => void messages.push(m) }, // recording default
    orders,
    resolveLayout,
    onDeviceState: (deviceId, state) => states.push([deviceId, state]),
    onSessionError: (e) => errors.push(e),
  });
  const { port } = await gateway.start();
  t.after(() => gateway.stop());
  return { messages, states, errors, port };
}

function connect(port: number): Promise<{ socket: net.Socket; acks: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const acks: string[] = [];
      const decoder = new MllpDecoder({
        onMessage: (p) => {
          acks.push(p);
        },
      });
      socket.on('data', (c: Buffer) => decoder.feed(c));
      resolve({ socket, acks });
    });
    socket.once('error', reject);
  });
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function msa(ack: string): { status?: string; text?: string } {
  const msg = parseMessage(ack);
  const seg = msg.segments.find((s) => s.id === 'MSA');
  return { status: seg ? segmentField(seg, 0) : undefined, text: seg ? segmentField(seg, 2) : undefined };
}

test('ORU becomes a canonical HL7 envelope with an AA ack', async (t) => {
  const hub = await startHub(t);
  const { socket, acks } = await connect(hub.port);
  t.after(() => socket.destroy());

  socket.write(wrapMessage(ORU));
  await waitFor(() => acks.length >= 1, 'AA ack');
  await waitFor(() => hub.messages.length >= 1, 'message recorded');

  assert.equal(msa(acks[0]!).status, 'AA');
  const m = hub.messages[0]!;
  assert.equal(m.protocol, 'HL7');
  assert.equal(m.direction, 'device-to-host');
  assert.equal(m.deviceId, 'ACME_LIS');
  assert.equal(m.status, 'MAPPED');
  assert.deepEqual(m.errors, []);
  assert.deepEqual(
    (m.records ?? []).map((r) => r.type),
    ['MSH', 'PID', 'OBR', 'OBX'],
  );
  assert.equal(m.payload?.patient.id, 'PID-1001');
  assert.equal(m.payload?.order.id, 'ACC-88');
  assert.equal(m.payload?.results[0]?.value, '95');
  assert.deepEqual(hub.states, [['ACME_LIS', 'connected']]);
  assert.deepEqual(hub.errors, []);
});

test('content that cannot be canonicalized is rejected AR with reasons yet persisted', async (t) => {
  const hub = await startHub(t);
  const { socket, acks } = await connect(hub.port);
  t.after(() => socket.destroy());

  const bad = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|BAD1|P|2.3.1',
    'PID|1|||^NoId^X||19850312|M',
  ].join('\r');
  socket.write(wrapMessage(bad));
  await waitFor(() => acks.length >= 1, 'AR ack');
  await waitFor(() => hub.messages.length >= 1, 'FAILED message persisted');

  assert.equal(msa(acks[0]!).status, 'AR');
  assert.match(msa(acks[0]!).text ?? '', /Missing patient identifier/);
  const m = hub.messages[0]!;
  assert.equal(m.status, 'FAILED');
  assert.ok(m.errors.length >= 2, 'identifier/order/result issues listed');
  assert.equal(hub.errors.length, 0);
});

test('a persistence failure answers AE and surfaces onSessionError', async (t) => {
  const hub = await startHub(t, {
    record: () => {
      throw new Error('postgres unavailable');
    },
  });
  const { socket, acks } = await connect(hub.port);
  t.after(() => socket.destroy());

  socket.write(wrapMessage(ORU));
  await waitFor(() => acks.length >= 1, 'AE ack');
  await waitFor(() => hub.errors.length >= 1, 'session error surfaced');

  assert.equal(msa(acks[0]!).status, 'AE');
  assert.match(msa(acks[0]!).text ?? '', /postgres unavailable/);
  assert.equal(hub.messages.length, 0);
});

test('ORM^O01 order feeds the registry (AA) instead of the results sink', async (t) => {
  const registered: OrderRegistration[] = [];
  const orders: OrderFeed = { register: (o) => void registered.push(o) };
  const hub = await startHub(t, undefined, orders);
  const { socket, acks } = await connect(hub.port);
  t.after(() => socket.destroy());

  const orm = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORM^O01|ORD-9|P|2.3.1',
    'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
    'ORC|NW|PL-77|ACC-424242|GLU^Glucose',
    'OBR|1|PL-77|ACC-424242|GLU^Glucose',
  ].join('\r');
  socket.write(wrapMessage(orm));
  await waitFor(() => acks.length >= 1, 'AA ack');
  await waitFor(() => registered.length >= 1, 'order registered');

  assert.equal(msa(acks[0]!).status, 'AA');
  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.id, 'ACC-424242');
  assert.equal(registered[0]!.patientId, 'PID-1001');
  // An ORM is not a result: the results sink is untouched.
  assert.equal(hub.messages.length, 0);
  assert.deepEqual(hub.errors, []);
});

test('a malformed ORM is rejected AR; a registry failure answers AE', async (t) => {
  const registered: OrderRegistration[] = [];
  const hub = await startHub(t, undefined, {
    register: (o) => void registered.push(o),
  } as OrderFeed);
  const { socket, acks } = await connect(hub.port);
  t.after(() => socket.destroy());

  // Missing PID-3 → cannot register → AR with reasons.
  const bad = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORM^O01|BAD2|P|2.3.1',
    'PID|1|||^NoId^X||19850312|M',
    'ORC|NW|PL-77|ACC-9||',
    'OBR|1|PL-77|ACC-9|GLU',
  ].join('\r');
  socket.write(wrapMessage(bad));
  await waitFor(() => acks.length >= 1, 'AR ack');
  assert.equal(msa(acks[0]!).status, 'AR');
  assert.match(msa(acks[0]!).text ?? '', /Missing patient identifier/);

  // A registry that throws → AE + session error.
  const hub2 = await startHub(t, undefined, {
    register: () => {
      throw new Error('registry down');
    },
  } as OrderFeed);
  const c2 = await connect(hub2.port);
  t.after(() => c2.socket.destroy());
  const good = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORM^O01|ORD-10|P|2.3.1',
    'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
    'ORC|NW|PL-77|ACC-424242|GLU^Glucose',
    'OBR|1|PL-77|ACC-424242|GLU^Glucose',
  ].join('\r');
  c2.socket.write(wrapMessage(good));
  await waitFor(() => c2.acks.length >= 1, 'AE ack');
  await waitFor(() => hub2.errors.length >= 1, 'session error surfaced');
  assert.equal(msa(c2.acks[0]!).status, 'AE');
  assert.match(msa(c2.acks[0]!).text ?? '', /order registration failed: registry down/);
});

test('disconnect fires for the device that carried the connection', async (t) => {
  const hub = await startHub(t);
  const { socket, acks } = await connect(hub.port);
  socket.write(wrapMessage(ORU));
  await waitFor(() => acks.length >= 1, 'AA ack');
  socket.destroy();
  await waitFor(() => hub.states.some(([, s]) => s === 'disconnected'), 'disconnected state');
  assert.deepEqual(hub.states, [
    ['ACME_LIS', 'connected'],
    ['ACME_LIS', 'disconnected'],
  ]);
});

test('B4: a bound device layout overrides canonicalization; unbound devices parse generically', async (t) => {
  // ACME_LIS is bound to a profile whose `hl7` layout puts the patient name
  // at PID-6; other senders have no profile and parse with generic positions.
  const hub = await startHub(t, undefined, undefined, (deviceId) =>
    deviceId === 'ACME_LIS' ? { patient: { name: { field: 6 } } } : undefined,
  );
  const { socket, acks } = await connect(hub.port);
  t.after(() => socket.destroy());

  // Bound device: name at PID-6, PID-5 empty.
  const vendorWire = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|B4-1|P|2.5.1',
    'PID|1||PID-1001^^^FAC1^PI|||Adeyemi^Tunde|19850312|M',
    'OBR|1|ORD-77|ACC-88|GLU^Glucose',
    'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
  ].join('\r');
  socket.write(wrapMessage(vendorWire));
  await waitFor(() => hub.messages.length >= 1, 'bound message recorded');
  assert.equal(msa(acks[0]!).status, 'AA');
  assert.equal(hub.messages[0]!.payload?.patient.name, 'Adeyemi, Tunde');

  // Unbound device: same wire shape → no name (generic PID-5 read).
  const unbound = vendorWire.replace('ACME_LIS', 'OTHER_LIS').replace('B4-1', 'B4-2');
  socket.write(wrapMessage(unbound));
  await waitFor(() => hub.messages.length >= 2, 'unbound message recorded');
  assert.equal(hub.messages[1]!.deviceId, 'OTHER_LIS');
  assert.equal(hub.messages[1]!.payload?.patient.name, undefined);
  assert.deepEqual(hub.errors, []);
});
