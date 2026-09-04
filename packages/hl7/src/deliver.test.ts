/**
 * HL7 outbound delivery tests (workstream B3.3). A real MLLP server stands in
 * for the LIS: `deliverHl7` connects, writes the canonical message out as
 * ORU^R01 (results) / ORM^O01 (order-only), and resolves only on an AA ack —
 * AE/AR and connection failures throw so the dispatcher can retry/DLQ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalMessage } from '@integration-hub/shared';
import { MllpServer } from './mllp-server.js';
import type { AckDecision } from './mllp-session.js';
import { deliverHl7 } from './deliver.js';
import { parseMessage, segmentField } from './message.js';

function message(overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    protocol: 'HL7',
    direction: 'host-to-device',
    deviceId: 'HUB',
    receivedAt: new Date().toISOString(),
    raw: '',
    payload: {
      patient: { id: 'PID-1001', name: 'Adeyemi, Tunde' },
      order: { id: 'ACC-424242', tests: [{ code: 'GLUCOSE', name: 'Glucose' }] },
      results: [{ testCode: 'GLUCOSE', testName: 'Glucose', value: '95', unit: 'mg/dL', referenceRange: '70-110', flag: 'N', status: 'F' }],
    },
    status: 'MAPPED',
    errors: [],
    timeline: [],
    ...overrides,
  };
}

async function startLIS(
  t: any,
  onMessage?: (payload: string) => AckDecision | void,
): Promise<{ received: string[]; port: number }> {
  const received: string[] = [];
  const server = new MllpServer({
    host: '127.0.0.1',
    port: 0,
    onMessage: (payload) => {
      received.push(payload);
      if (onMessage) return onMessage(payload);
    },
  });
  const { port } = await server.start();
  t.after(() => server.stop());
  return { received, port };
}

test('deliverHl7 sends an ORU^R01 and resolves on AA', async (t) => {
  const lis = await startLIS(t, undefined);
  await deliverHl7({ host: '127.0.0.1', port: lis.port }, message());

  assert.equal(lis.received.length, 1);
  const raw = parseMessage(lis.received[0]!);
  assert.equal(segmentField(raw.segments[0]!, 7), 'ORU^R01');
  const obx = raw.segments.find((s) => s.id === 'OBX');
  assert.equal(segmentField(obx!, 2), 'GLUCOSE^Glucose');
  assert.equal(segmentField(obx!, 4), '95');
});

test('an order-only payload is sent as ORM^O01', async (t) => {
  const lis = await startLIS(t, undefined);
  await deliverHl7({ host: '127.0.0.1', port: lis.port, receivingApp: 'ACME_LIS' }, message({ payload: { ...message().payload!, results: [] } }));

  assert.equal(lis.received.length, 1);
  const raw = parseMessage(lis.received[0]!);
  assert.equal(segmentField(raw.segments[0]!, 7), 'ORM^O01');
  const orc = raw.segments.find((s) => s.id === 'ORC');
  assert.equal(segmentField(orc!, 2), 'ACC-424242');
});

test('AE/AR acks throw with the MSA-3 reason (retry/DLQ applies)', async (t) => {
  const lis = await startLIS(t, () => ({ status: 'AE', text: 'no such test' }));
  await assert.rejects(deliverHl7({ host: '127.0.0.1', port: lis.port }, message()), /rejected \(AE\): no such test/);
});

test('a refused connection throws (transient — the dispatcher retries)', async () => {
  // Grab an ephemeral port by binding + closing a raw listener: it is now
  // free but nothing listens, so connect is refused.
  const net = await import('node:net');
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  await assert.rejects(deliverHl7({ host: '127.0.0.1', port }, message()), /ECONNREFUSED|connect/i);
});