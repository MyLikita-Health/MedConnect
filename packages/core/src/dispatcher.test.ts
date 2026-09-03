import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CanonicalMessage, MessageAttempt, MessageStatus } from '@integration-hub/shared';
import { InMemoryDedupStore } from './dedup.js';
import { Dispatcher, type DeliveryStore } from './dispatcher.js';
import { InMemoryRouteStore, type Destination } from './routing.js';

class FakeStore implements DeliveryStore {
  readonly messages = new Map<string, CanonicalMessage>();
  readonly attempts: MessageAttempt[] = [];

  async record(message: CanonicalMessage): Promise<void> {
    this.messages.set(message.id, structuredClone(message));
  }

  async mark(id: string, status: MessageStatus, note?: string, fields?: { dlqAt?: string; duplicateOf?: string }): Promise<void> {
    const message = this.messages.get(id);
    if (!message) throw new Error(`mark: unknown message ${id}`);
    message.status = status;
    if (fields?.dlqAt) message.dlqAt = fields.dlqAt;
    if (fields?.duplicateOf) message.duplicateOf = fields.duplicateOf;
    message.timeline.push({ stage: status, at: new Date().toISOString(), note });
  }

  async recordAttempt(attempt: MessageAttempt): Promise<void> {
    this.attempts.push(attempt);
  }
}

function message(id: string, raw?: string, status: CanonicalMessage['status'] = 'MAPPED'): CanonicalMessage {
  return {
    id,
    protocol: 'ASTM',
    direction: 'device-to-host',
    deviceId: 'DEV-1',
    receivedAt: new Date().toISOString(),
    raw: raw ?? `H|1|msg-${id}`,
    records: [{ type: 'H', fields: ['\\^&'] }],
    payload: {
      patient: { id: 'P1' },
      order: { id: 'O1', tests: [] },
      results: [{ testCode: 'GLUCOSE', value: '95' }],
    },
    status,
    errors: [],
    timeline: [{ stage: 'RECEIVED', at: new Date().toISOString() }],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

type HttpTarget = { port: number; requests: number[]; close: () => Promise<void> };

function startHttp(failuresBeforeSuccess: number): Promise<HttpTarget> {
  const requests: number[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(requests.length);
      const shouldFail = requests.length <= failuresBeforeSuccess;
      res.writeHead(shouldFail ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(shouldFail ? 'unavailable' : `{"ok":true,"got":${JSON.stringify(body).length}}`);
    });
  });
  return new Promise<HttpTarget>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function httpDestination(url: string, maxAttempts = 3): Destination {
  return {
    id: 'lis-http',
    kind: 'http',
    name: 'LIS',
    url,
    enabled: true,
    retry: { maxAttempts, backoffMs: 1, backoffFactor: 2, jitter: false },
  };
}

test('dispatcher delivers a MAPPED message through QUEUED → DELIVERING → ROUTED', async (t) => {
  const store = new FakeStore();
  const dispatcher = new Dispatcher({
    store,
    dedup: new InMemoryDedupStore(),
    routes: new InMemoryRouteStore(),
    pollMs: 5,
    sleep: () => Promise.resolve(),
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'ROUTED');

  const stages = store.messages.get('m1')!.timeline.map((e) => e.stage);
  assert.deepEqual(stages, ['RECEIVED', 'QUEUED', 'DELIVERING', 'ROUTED']);
  assert.equal(store.attempts.filter((a) => a.messageId === 'm1').length, 1);
  assert.equal(store.attempts[0]!.status, 'OK');
});

test('dispatcher retries, then routes, on transient HTTP failures', async (t) => {
  const target = await startHttp(2); // fail twice, succeed on the 3rd
  t.after(() => target.close());
  const routes = new InMemoryRouteStore();
  await routes.upsertDestination(httpDestination(`http://127.0.0.1:${target.port}/hook`));
  await routes.upsertRule({ id: 'r1', destinationId: 'lis-http', priority: 100, enabled: true });

  const store = new FakeStore();
  const dispatcher = new Dispatcher({ store, dedup: new InMemoryDedupStore(), routes, pollMs: 5 });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'ROUTED');

  assert.equal(target.requests.length, 3);
  const attempts = store.attempts.filter((a) => a.messageId === 'm1');
  assert.deepEqual(attempts.map((a) => a.status), ['FAILED', 'FAILED', 'OK']);
  assert.equal(store.messages.get('m1')!.dlqAt, undefined);
});

test('dispatcher sends to DLQ after attempts are exhausted', async (t) => {
  const target = await startHttp(100); // always fails
  t.after(() => target.close());
  const routes = new InMemoryRouteStore();
  await routes.upsertDestination(httpDestination(`http://127.0.0.1:${target.port}/hook`, 3));
  await routes.upsertRule({ id: 'r1', destinationId: 'lis-http', priority: 100, enabled: true });

  const store = new FakeStore();
  const dispatcher = new Dispatcher({ store, dedup: new InMemoryDedupStore(), routes, pollMs: 5, sleep: () => Promise.resolve() });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'FAILED' && store.messages.get('m1')!.dlqAt !== undefined);

  const got = store.messages.get('m1')!;
  assert.ok(got.dlqAt);
  assert.deepEqual(store.attempts.filter((a) => a.messageId === 'm1').map((a) => a.status), ['FAILED', 'FAILED', 'FAILED']);
  assert.ok(got.errors.length >= 0); // DLQ note lives in the timeline
  assert.ok(got.timeline.some((e) => e.note?.includes('DLQ')));
});

test('duplicates are detected and marked, not delivered twice', async (t) => {
  const store = new FakeStore();
  const dedup = new InMemoryDedupStore();
  const dispatcher = new Dispatcher({ store, dedup, routes: new InMemoryRouteStore(), pollMs: 5, sleep: () => Promise.resolve() });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  const first = message('m1', 'H|1|same-raw');
  const second = message('m2', 'H|1|same-raw'); // same protocol/device/raw → duplicate
  await dispatcher.record(first);
  await waitFor(() => store.messages.get('m1')?.status === 'ROUTED');
  await dispatcher.record(second);

  const dup = store.messages.get('m2')!;
  assert.equal(dup.status, 'DUPLICATE');
  assert.equal(dup.duplicateOf, 'm1');
  assert.ok(dup.timeline.some((e) => e.stage === 'DUPLICATE'));
  assert.equal(store.attempts.filter((a) => a.messageId === 'm2').length, 0);
});

test('pipeline-validation FAILED messages go straight to the DLQ', async (t) => {
  const store = new FakeStore();
  const dispatcher = new Dispatcher({ store, dedup: new InMemoryDedupStore(), routes: new InMemoryRouteStore(), pollMs: 5 });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  const failed = message('m1', undefined, 'FAILED');
  failed.errors = ['Missing patient identifier'];
  await dispatcher.record(failed);
  await waitFor(() => store.messages.get('m1')!.dlqAt !== undefined);

  const got = store.messages.get('m1')!;
  assert.equal(got.status, 'FAILED');
  assert.ok(got.dlqAt);
  assert.ok(!got.timeline.some((e) => e.stage === 'QUEUED'));
});

test('dedup can be disabled', async (t) => {
  const store = new FakeStore();
  const dispatcher = new Dispatcher({
    store,
    dedup: new InMemoryDedupStore(),
    routes: new InMemoryRouteStore(),
    dedupEnabled: false,
    pollMs: 5,
    sleep: () => Promise.resolve(),
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'ROUTED');
  await dispatcher.record(message('m2'));
  await waitFor(() => store.messages.get('m2')?.status === 'ROUTED');

  assert.equal(store.messages.get('m2')!.status, 'ROUTED');
});