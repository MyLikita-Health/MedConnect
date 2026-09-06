/**
 * HL7 inbound → dispatcher integration (workstream B2b proof): the gateway
 * wired exactly as `startHub` will wire it — `Hl7Gateway.sink = Dispatcher`
 * over in-memory stores — over real TCP. An ORU^R01 sent by an MLLP peer
 * lands in the standard lifecycle (RECEIVED → … → ROUTED) with an AA ack,
 * and a resent identical message is deduped (PRD §29), exactly like ASTM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { CanonicalMessage, MessageAttempt } from '@integration-hub/shared';
import { Dispatcher, InMemoryDedupStore, InMemoryRouteStore, type DeliveryStore } from '@integration-hub/core';
import { Hl7Gateway, MllpDecoder, wrapMessage } from '@integration-hub/hl7';

// Server integration tests are designed for in-memory stores. Explicitly
// unset DATABASE_URL so startHub() never silently flips into PG mode.
delete process.env.DATABASE_URL;

const ORU = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG0001|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'OBR|1|ORD-77|ACC-88|GLU^Glucose',
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

interface Hub {
  store: MemDeliveryStore;
  port: number;
}

async function startHub(t: any): Promise<Hub> {
  const store = new MemDeliveryStore();
  const dispatcher = new Dispatcher({ store, dedup: new InMemoryDedupStore(), routes: new InMemoryRouteStore() });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  const gateway = new Hl7Gateway({ host: '127.0.0.1', port: 0, sink: dispatcher }); // Dispatcher implements MessageSink
  const { port } = await gateway.start();
  t.after(() => gateway.stop());
  return { store, port };
}

async function connect(port: number): Promise<{ socket: net.Socket; acks: string[] }> {
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

test('HL7 ORU flows through the dispatcher to ROUTED with an AA ack', async (t) => {
  const hub = await startHub(t);
  const { socket, acks } = await connect(hub.port);
  t.after(() => socket.destroy());

  socket.write(wrapMessage(ORU));
  await waitFor(() => acks.length >= 1, 'AA ack');
  await waitFor(() => [...hub.store.messages.values()].some((m) => m.status === 'ROUTED'), 'ROUTED');

  assert.ok(acks[0]!.includes('MSA|AA|MSG0001'));
  const message = [...hub.store.messages.values()][0]!;
  assert.equal(message.protocol, 'HL7');
  assert.equal(message.status, 'ROUTED');
  assert.equal(message.payload?.results[0]?.value, '95');
});

test('a resent identical HL7 ORU is deduped (DUPLICATE), not delivered twice', async (t) => {
  const hub = await startHub(t);
  const a = await connect(hub.port);
  const b = await connect(hub.port);
  t.after(() => a.socket.destroy());
  t.after(() => b.socket.destroy());

  a.socket.write(wrapMessage(ORU));
  await waitFor(() => [...hub.store.messages.values()].some((m) => m.status === 'ROUTED'), 'first ROUTED');
  await waitFor(() => a.acks.length >= 1, 'first AA ack');

  b.socket.write(wrapMessage(ORU));
  await waitFor(() => b.acks.length >= 1, 'second ack');
  await waitFor(() => [...hub.store.messages.values()].some((m) => m.status === 'DUPLICATE'), 'second DUPLICATE');

  const statuses = [...hub.store.messages.values()].map((m) => m.status).sort();
  assert.deepEqual(statuses, ['DUPLICATE', 'ROUTED']);
});
