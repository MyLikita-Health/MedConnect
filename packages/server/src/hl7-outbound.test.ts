/**
 * B3.3 e2e proof — the outbound leg, wired exactly like `startHub`: the
 * Dispatcher carries the injected `deliver` (→ `deliverHl7`), and an `hl7`
 * destination + route rule select a mock LIS. An ORU arriving at the gateway
 * flows through matching → routing → MLLP delivery to the LIS → ROUTED; a
 * LIS that rejects (AE) → retries → DLQ with the ACK reason. This is the
 * first real outbound beyond HTTP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { CanonicalMessage, MessageAttempt } from '@integration-hub/shared';
import { Dispatcher, InMemoryDedupStore, InMemoryOrderRegistry, InMemoryRouteStore, type DeliveryStore } from '@integration-hub/core';
import { deliverHl7, Hl7Gateway, MllpDecoder, MllpServer, wrapMessage } from '@integration-hub/hl7';

// Server integration tests are designed for in-memory stores. Explicitly
// unset DATABASE_URL so startHub() never silently flips into PG mode.
delete process.env.DATABASE_URL;

const ORU = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG0001|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'OBR|1|ORD-77|ACC-424242|GLU^Glucose',
  'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
].join('\r');

class MemDeliveryStore implements DeliveryStore {
  readonly messages = new Map<string, CanonicalMessage>();
  readonly attempts: MessageAttempt[] = [];
  async record(message: CanonicalMessage): Promise<void> {
    this.messages.set(message.id, message);
  }
  async mark(
    id: string,
    status: CanonicalMessage['status'],
    note?: string,
    fields?: { dlqAt?: string; duplicateOf?: string; match?: CanonicalMessage['match'] },
  ): Promise<void> {
    const m = this.messages.get(id);
    if (!m) return;
    m.status = status;
    if (note) m.timeline.push({ stage: status, at: new Date().toISOString(), note });
    if (fields?.dlqAt) m.dlqAt = fields.dlqAt;
    if (fields?.duplicateOf) m.duplicateOf = fields.duplicateOf;
    if (fields?.match) m.match = fields.match;
  }
  async recordAttempt(attempt: MessageAttempt): Promise<void> {
    this.attempts.push(attempt);
  }
  async get(id: string): Promise<CanonicalMessage | undefined> {
    return this.messages.get(id);
  }
}

/** Mock LIS: an MLLP server capturing inbound payloads, AA unless told to reject. */
async function startLIS(t: any, rejectWith?: string): Promise<{ port: number; received: string[] }> {
  const received: string[] = [];
  const server = new MllpServer({
    host: '127.0.0.1',
    port: 0,
    onMessage: (payload) => {
      received.push(payload);
      return rejectWith ? { status: 'AE', text: rejectWith } : undefined;
    },
  });
  const { port } = await server.start();
  t.after(() => server.stop());
  return { port, received };
}

interface Hub {
  store: MemDeliveryStore;
  port: number;
  received: string[];
}

async function startHub(t: any, opts: { rejectWith?: string } = {}): Promise<Hub> {
  const store = new MemDeliveryStore();
  const orders = new InMemoryOrderRegistry();
  await orders.register({
    id: 'ACC-424242',
    patientId: 'PID-1001',
    sampleId: 'S-4242',
    tests: ['GLUCOSE'],
    status: 'active',
    receivedAt: new Date().toISOString(),
  });

  const routes = new InMemoryRouteStore();
  const lis = await startLIS(t, opts.rejectWith);
  await routes.upsertDestination({
    id: 'lis-mllp',
    kind: 'hl7',
    name: 'LIS MLLP',
    hl7: { host: '127.0.0.1', port: lis.port, receivingApp: 'ACME_LIS' },
    enabled: true,
    retry: { maxAttempts: 3, backoffMs: 1, backoffFactor: 2, jitter: false },
  });
  await routes.upsertRule({ id: 'r1', destinationId: 'lis-mllp', priority: 100, enabled: true });

  const dispatcher = new Dispatcher({
    store,
    dedup: new InMemoryDedupStore(),
    routes,
    matching: { registry: orders },
    // Exactly the startHub wiring.
    deliver: async (destination, message) => {
      if (destination.kind !== 'hl7' || !destination.hl7) throw new Error(`cannot deliver kind ${destination.kind} over HL7`);
      await deliverHl7(destination.hl7, message);
    },
    pollMs: 5,
    sleep: () => Promise.resolve(),
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  const gateway = new Hl7Gateway({ host: '127.0.0.1', port: 0, sink: dispatcher });
  const { port } = await gateway.start();
  t.after(() => gateway.stop());

  return { store, port, received: lis.received };
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

async function waitFor(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

test('an inbound ORU routes to the mock LIS over MLLP and lands ROUTED', async (t) => {
  const hub = await startHub(t);
  const { socket, acks } = await connect(hub.port);
  t.after(() => socket.destroy());

  socket.write(wrapMessage(ORU));
  await waitFor(() => [...hub.store.messages.values()].some((m) => m.status === 'ROUTED'), 'ROUTED');
  await waitFor(() => hub.received.length >= 1, 'LIS received the ORU');

  const msg = [...hub.store.messages.values()][0]!;
  assert.equal(msg.status, 'ROUTED');
  assert.equal(msg.match?.status, 'MATCHED');
  // The LIS saw one ORU^R01 carrying the canonical result.
  assert.ok(hub.received[0]!.includes('ORU^R01'));
  assert.ok(hub.received[0]!.includes('ACC-424242'));
  assert.ok(hub.received[0]!.includes('95'));
});

test('a rejecting LIS (AE) exhausts retries into the DLQ with the reason', async (t) => {
  const hub = await startHub(t, { rejectWith: 'duplicate accession' });
  const { socket, acks } = await connect(hub.port);
  t.after(() => socket.destroy());

  socket.write(wrapMessage(ORU));
  await waitFor(() => {
    const m = [...hub.store.messages.values()][0];
    return m?.status === 'FAILED' && m.dlqAt !== undefined;
  }, 'DLQ');

  const msg = [...hub.store.messages.values()][0]!;
  assert.equal(msg.status, 'FAILED');
  assert.ok(msg.dlqAt);
  // The MSA-3 reason surfaces in the delivery failure note.
  assert.ok(msg.timeline.some((e) => e.note?.includes('duplicate accession')), 'ACK reason surfaced in the timeline');
  assert.deepEqual(hub.store.attempts.filter((a) => a.messageId === msg.id).map((a) => a.status), ['FAILED', 'FAILED', 'FAILED']);
});