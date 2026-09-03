import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { AstmGateway } from './gateway.js';
import { buildMessage } from './pipeline.js';
import { DEFAULT_MAPPINGS } from './mappings.js';
import type { CanonicalMessage } from '@integration-hub/shared';
import { AstmClient, type AstmRecord } from '@integration-hub/astm';

function sampleMessage(glucose: string): AstmRecord[] {
  return [
    { type: 'H', fields: ['\\^&', '', '', '', 'SIM-BS430^SIM-001', '', '', '', '', '', '', 'P', '1', '20260903143000'] },
    { type: 'P', fields: ['1', '', 'PID-9001', 'Doe^John', '', '19900101', 'M'] },
    { type: 'O', fields: ['1', 'S-48291', 'ACC-991001', '^GLU^Glucose'] },
    { type: 'R', fields: ['1', '^GLU^Glucose', glucose, 'mg/dL', '70-110', 'N', '', 'F'] },
    { type: 'R', fields: ['2', '^CREA^Creatinine', '1.1', 'mg/dL', '0.6-1.3', 'N', '', 'F'] },
    { type: 'L', fields: ['1', 'N'] },
  ];
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('gateway receives, parses, maps and sinks a full ASTM result message', async (t) => {
  const received: CanonicalMessage[] = [];
  const states: string[] = [];
  const gateway = new AstmGateway({
    port: 0,
    sink: { record: (m) => { received.push(m); } },
    mappings: DEFAULT_MAPPINGS,
    onDeviceState: (id, state) => states.push(`${id}:${state}`),
  });
  const { port } = await gateway.start();
  t.after(() => gateway.stop());

  const socket = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await once(socket, 'connect');

  const client = new AstmClient(socket, { timeoutMs: 3000 });
  const result = await client.run(sampleMessage('95'));
  await once(socket, 'close');

  await waitFor(() => received.length > 0);
  const message = received[0]!;

  assert.equal(result.nakCount, 0);
  // The pipeline produces MAPPED; delivery (ROUTED) is the sink's job.
  assert.equal(message.status, 'MAPPED');
  assert.equal(message.deviceId, 'SIM-BS430');
  assert.equal(message.payload?.patient.id, 'PID-9001');
  assert.equal(message.payload?.patient.name, 'Doe, John');
  assert.equal(message.payload?.order.id, 'ACC-991001');
  assert.equal(message.payload?.results.length, 2);
  assert.equal(message.payload?.results[0]!.testCode, 'GLUCOSE'); // mapped
  assert.equal(message.payload?.results[0]!.originalTestCode, 'GLU');
  assert.equal(message.payload?.results[0]!.value, '95');
  assert.equal(message.raw.includes('H|'), true);
  assert.ok(message.timeline.some((t) => t.stage === 'MAPPED'));
  assert.ok(states.includes('SIM-BS430:connected'));
});

test('gateway records FAILED messages instead of dropping them', async (t) => {
  const received: CanonicalMessage[] = [];
  const gateway = new AstmGateway({ port: 0, sink: { record: (m) => { received.push(m); } } });
  const { port } = await gateway.start();
  t.after(() => gateway.stop());

  const socket = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await once(socket, 'connect');

  // No patient, no order, no results -> validation failure
  const bad: AstmRecord[] = [
    { type: 'H', fields: ['\\^&', '', '', '', 'SIM-BS430^SIM-001', '', '', '', '', '', '', 'P', '1', '20260903143000'] },
    { type: 'L', fields: ['1', 'N'] },
  ];
  const client = new AstmClient(socket, { timeoutMs: 3000 });
  await client.run(bad);
  await once(socket, 'close');

  await waitFor(() => received.length > 0);
  assert.equal(received[0]!.status, 'FAILED');
  assert.ok(received[0]!.errors.length >= 3);
});

test('gateway.replay re-runs the pipeline and sinks a new message', async (t) => {
  const received: CanonicalMessage[] = [];
  const gateway = new AstmGateway({
    port: 0,
    sink: { record: (m) => { received.push(m); } },
    mappings: DEFAULT_MAPPINGS,
  });
  await gateway.start();
  t.after(() => gateway.stop());

  const original = buildMessage(sampleMessage('120'), 'raw text', {
    deviceId: 'SIM-BS430',
    mappings: DEFAULT_MAPPINGS,
  });
  const replayed = await gateway.replay(original);

  assert.notEqual(replayed.id, original.id);
  assert.equal(replayed.status, 'MAPPED'); // delivery is the sink's job
  assert.equal(replayed.payload?.results[0]!.value, '120');
  assert.equal(replayed.timeline[0]!.stage, 'REPLAYED');
  assert.equal(received.length, 1);
  assert.equal(received[0]!.id, replayed.id);
});