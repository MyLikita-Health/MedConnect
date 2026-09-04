/**
 * A4 AdapterRegistry seam (plan §6.3/A4, PRD §39–40): when a device is bound
 * to a certified profile, its ASTM stream must be canonicalized with the
 * profile's record layout + code mappings — the same wire bytes produce
 * correct association under the profile and a mis-association under the
 * generic reference layout (the Acme accession/sample swap).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { AstmGateway, type ProfileResolver } from './gateway.js';
import { AstmClient, type AstmRecord } from '@integration-hub/astm';
import type { CanonicalMessage, DeviceRecordLayout, MappingTable } from '@integration-hub/shared';

// ACME Chem 200 (fictional vendor): O record puts accession BEFORE sample-id
// (sampleId = position 3, accession = position 2) and maps GLU → GLUCOSE.
const ACME_LAYOUT: DeviceRecordLayout = {
  patient: { id: 3, name: 4, dateOfBirth: 6, sex: 7 },
  order: { sampleId: 3, accession: 2, test: 4 },
  result: { test: 2, value: 3, unit: 4, referenceRange: 5, flag: 6, status: 8 },
};
const ACME_MAPPINGS: MappingTable = { GLU: 'GLUCOSE', CREA: 'CREATININE', HGB: 'HEMOGLOBIN' };

/**
 * A message as the Acme device actually emits it: accession field 2, sample
 * field 3, test code GLU.
 */
const ACME_RECORDS: AstmRecord[] = [
  { type: 'H', fields: ['\\^&', '', '', '', 'ACME-1^ACME-1', '', '', '', '', '', '', 'P', '1', '20260903143000'] },
  { type: 'P', fields: ['1', '', 'PID-9001', 'Doe^John', '', '19900101', 'M'] },
  { type: 'O', fields: ['1', 'ACC-991001', 'S-48291', '^GLU^Glucose'] },
  { type: 'R', fields: ['1', '^GLU^Glucose', '95', 'mg/dL', '70-110', 'N', '', 'F'] },
  { type: 'L', fields: ['1', 'N'] },
];

async function runThroughGateway(t: any, resolver?: ProfileResolver): Promise<CanonicalMessage | undefined> {
  const received: CanonicalMessage[] = [];
  const gateway = new AstmGateway({
    host: '127.0.0.1',
    port: 0,
    sink: { record: (m) => void received.push(m) },
    resolveProfile: resolver,
  });
  const { port } = await gateway.start();
  t.after(() => gateway.stop());

  const socket = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const client = new AstmClient(socket, { timeoutMs: 3000 });
  const result = await client.run(ACME_RECORDS);
  await once(socket, 'close');
  assert.equal(result.nakCount, 0);
  await waitFor(() => received.length >= 1, 'message recorded');
  return received[0];
}

test('a device bound to the Acme profile canonicalizes with its layout + mappings', async (t) => {
  const resolver: ProfileResolver = async (deviceId) =>
    deviceId === 'ACME-1' ? { layout: ACME_LAYOUT, mappings: ACME_MAPPINGS } : undefined;

  const message = await runThroughGateway(t, resolver);
  assert.ok(message);
  // Correct association: accession and sample land in their right slots…
  assert.equal(message.payload?.order?.id, 'ACC-991001');
  assert.equal(message.payload?.order?.sampleId, 'S-48291');
  // …and the profile's test-code mapping was applied (GLU → GLUCOSE).
  assert.equal(message.payload?.results?.[0]?.testCode, 'GLUCOSE');
  assert.equal(message.payload?.results?.[0]?.originalTestCode, 'GLU');
  assert.equal(message.status, 'MAPPED');
});

test('the same bytes without a binding mis-associate under the reference layout', async (t) => {
  const message = await runThroughGateway(t); // no resolver → reference layout
  assert.ok(message);
  // Under the reference layout (sample = position 2), Acme's accession field
  // is read as the sample id — the mis-association certified profiles exist
  // to prevent. GLU stays unmapped too (no per-device mapping table).
  assert.equal(message.payload?.order?.sampleId, 'ACC-991001');
  assert.equal(message.payload?.order?.id, 'S-48291');
  assert.equal(message.payload?.results?.[0]?.testCode, 'GLU');
});

test('an unbound device keeps the global mapping table behaviour', async (t) => {
  const resolver: ProfileResolver = async () => undefined;
  const message = await runThroughGateway(t, resolver);
  assert.equal(message?.payload?.results?.[0]?.testCode, 'GLU');
});

async function waitFor(pred: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
