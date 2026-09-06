/**
 * B2c e2e proof — the LIS seam, wired exactly like `startHub`: the Hl7Gateway
 * carries an `orders` feed backed by the real `OrderRegistry`, and the
 * Dispatcher matches against that same registry. An ORM^O01 sent over MLLP
 * registers the expected order; the matching ORU then routes instead of
 * landing in the HELD exception queue (the control shows the same ORU without
 * the feed is HELD). This replaces the manual `POST /api/v1/orders` flow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { CanonicalMessage, MessageAttempt } from '@integration-hub/shared';
import { Dispatcher, InMemoryDedupStore, InMemoryOrderRegistry, InMemoryRouteStore, type DeliveryStore } from '@integration-hub/core';
import { Hl7Gateway, MllpDecoder, wrapMessage } from '@integration-hub/hl7';

// Server integration tests are designed for in-memory stores. Explicitly
// unset DATABASE_URL so startHub() never silently flips into PG mode.
delete process.env.DATABASE_URL;

const ORU = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG0001|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'OBR|1|ORD-77|ACC-424242|GLU^Glucose',
  'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
].join('\r');

const ORM = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORM^O01|ORD-9|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'ORC|NW|PL-77|ACC-424242|GLU^Glucose',
  'OBR|1|PL-77|ACC-424242|GLU^Glucose',
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

interface Hub {
  store: MemDeliveryStore;
  orders: InMemoryOrderRegistry;
  port: number;
}

async function startHub(t: any): Promise<Hub> {
  const store = new MemDeliveryStore();
  const orders = new InMemoryOrderRegistry();
  const dispatcher = new Dispatcher({
    store,
    dedup: new InMemoryDedupStore(),
    routes: new InMemoryRouteStore(),
    matching: { registry: orders },
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  const gateway = new Hl7Gateway({
    host: '127.0.0.1',
    port: 0,
    sink: dispatcher,
    orders: {
      register: (order) => orders.register({ ...order, receivedAt: order.receivedAt ?? new Date().toISOString() }),
    },
  });
  const { port } = await gateway.start();
  t.after(() => gateway.stop());
  return { store, orders, port };
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

test('ORM over MLLP registers the expected order; the matching ORU routes (not HELD)', async (t) => {
  const hub = await startHub(t);
  const { socket, acks } = await connect(hub.port);
  t.after(() => socket.destroy());

  // The LIS sends the order first (the seam). AA ack, registry updated.
  socket.write(wrapMessage(ORM));
  await waitFor(() => acks.length >= 1, 'ORM AA ack');
  assert.match(acks[0]!, /MSA\|AA\|ORD-9/);
  await waitFor(async () => (await hub.orders.find({ patientId: 'PID-1001', orderId: 'ACC-424242' })).length === 1, 'order registered');
  const [registered] = await hub.orders.find({ patientId: 'PID-1001', orderId: 'ACC-424242' });
  assert.equal(registered!.id, 'ACC-424242');
  assert.equal(registered!.status, 'active');
  assert.deepEqual(registered!.tests, ['GLU']);

  // Now the results arrive for that order: matched → routed, never held.
  socket.write(wrapMessage(ORU));
  await waitFor(() => [...hub.store.messages.values()].some((m) => m.protocol === 'HL7' && m.status === 'ROUTED'), 'matching ORU ROUTED');

  const msg = [...hub.store.messages.values()].find((m) => m.protocol === 'HL7')!;
  assert.equal(msg.status, 'ROUTED');
  assert.equal(msg.match?.status, 'MATCHED');
  assert.equal(msg.match?.matchedOrderId, 'ACC-424242');
});

test('control: without the order feed, the same ORU is HELD unmatched', async (t) => {
  const hub = await startHub(t);
  // No ORM sent — the registry is empty, exactly like a hub before B2c.
  const { socket, acks } = await connect(hub.port);
  t.after(() => socket.destroy());

  socket.write(wrapMessage(ORU));
  await waitFor(() => [...hub.store.messages.values()].some((m) => m.status === 'HELD'), 'ORU HELD unmatched');

  const msg = [...hub.store.messages.values()][0]!;
  assert.equal(msg.status, 'HELD');
  assert.equal(msg.match?.status, 'UNMATCHED');
});