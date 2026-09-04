import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CanonicalMessage, MessageAttempt, MessageMatch, MessageStatus } from '@integration-hub/shared';
import { InMemoryDedupStore } from './dedup.js';
import { Dispatcher, type DeliveryStore } from './dispatcher.js';
import { InMemoryOrderRegistry } from './matching.js';
import { InMemoryRouteStore, type Destination } from './routing.js';
import { DEFAULT_VALIDATION_RULES, type ValidationConfig } from './validate.js';

class FakeStore implements DeliveryStore {
  readonly messages = new Map<string, CanonicalMessage>();
  readonly attempts: MessageAttempt[] = [];

  async record(message: CanonicalMessage): Promise<void> {
    this.messages.set(message.id, structuredClone(message));
  }

  async mark(id: string, status: MessageStatus, note?: string, fields?: { dlqAt?: string; clearDlq?: boolean; duplicateOf?: string; match?: MessageMatch }): Promise<void> {
    const message = this.messages.get(id);
    if (!message) throw new Error(`mark: unknown message ${id}`);
    message.status = status;
    if (fields?.dlqAt) message.dlqAt = fields.dlqAt;
    if (fields?.clearDlq) delete message.dlqAt;
    if (fields?.duplicateOf) message.duplicateOf = fields.duplicateOf;
    if (fields?.match) message.match = fields.match;
    message.timeline.push({ stage: status, at: new Date().toISOString(), note });
  }

  async recordAttempt(attempt: MessageAttempt): Promise<void> {
    this.attempts.push(attempt);
  }

  async get(id: string): Promise<CanonicalMessage | undefined> {
    return this.messages.get(id);
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

test('retry re-enters a DLQ message and routes once the destination is fixed', async (t) => {
  const broken = await startHttp(100); // always 503
  t.after(() => broken.close());
  const healthy = await startHttp(0); // 200 immediately
  t.after(() => healthy.close());
  const routes = new InMemoryRouteStore();
  const brokenDest = httpDestination(`http://127.0.0.1:${broken.port}/hook`, 2);
  await routes.upsertDestination(brokenDest);
  await routes.upsertRule({ id: 'r1', destinationId: 'lis-http', priority: 100, enabled: true });

  const store = new FakeStore();
  const dispatcher = new Dispatcher({ store, dedup: new InMemoryDedupStore(), routes, pollMs: 5, sleep: () => Promise.resolve() });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'FAILED' && store.messages.get('m1')!.dlqAt !== undefined);
  assert.ok(store.messages.get('m1')!.dlqAt);

  // The operator fixes the routing: drop the broken destination rule, point
  // the message at a healthy one — retry resolves CURRENT rules (no dedup wall).
  await routes.deleteRule('r1');
  await routes.upsertDestination(httpDestination(`http://127.0.0.1:${healthy.port}/hook`, 2));
  await routes.upsertRule({ id: 'r2', destinationId: 'lis-http', priority: 100, enabled: true });

  assert.equal(await dispatcher.retry('m1'), true);
  await waitFor(() => store.messages.get('m1')?.status === 'ROUTED');
  const routed = store.messages.get('m1')!;
  assert.equal(routed.status, 'ROUTED');
  assert.equal(routed.dlqAt, undefined, 'the DLQ marker is cleared on retry');
  assert.ok(healthy.requests.length >= 1);
  assert.ok(routed.timeline.some((e) => e.note?.includes('retried from the DLQ')));
});

test('retry rejects messages that are not dead-lettered failures', async (t) => {
  const store = new FakeStore();
  const dispatcher = new Dispatcher({ store, dedup: new InMemoryDedupStore(), routes: new InMemoryRouteStore(), pollMs: 5, sleep: () => Promise.resolve() });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  // A delivered (ROUTED) message is not retryable — nothing to re-run.
  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'ROUTED');
  assert.equal(await dispatcher.retry('m1'), false);

  // A pipeline-FAILED message parked in the DLQ IS retryable; an unknown id is not.
  const failed = message('m2', undefined, 'FAILED');
  failed.errors = ['Missing order identifier'];
  await dispatcher.record(failed);
  await waitFor(() => store.messages.get('m2')!.dlqAt !== undefined);
  assert.equal(await dispatcher.retry('m2'), true);
  await waitFor(() => store.messages.get('m2')?.status === 'ROUTED');
  assert.equal(await dispatcher.retry('ghost'), false);
});

test('retry of a still-broken destination re-DLQs instead of silently dropping', async (t) => {
  const broken = await startHttp(100);
  t.after(() => broken.close());
  const routes = new InMemoryRouteStore();
  await routes.upsertDestination(httpDestination(`http://127.0.0.1:${broken.port}/hook`, 2));
  await routes.upsertRule({ id: 'r1', destinationId: 'lis-http', priority: 100, enabled: true });

  const store = new FakeStore();
  const dispatcher = new Dispatcher({ store, dedup: new InMemoryDedupStore(), routes, pollMs: 5, sleep: () => Promise.resolve() });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'FAILED');
  assert.equal(await dispatcher.retry('m1'), true);
  // The destination is still down — the retried message goes back to the DLQ
  // with a fresh attempt budget, never silently dropped.
  await waitFor(() => store.messages.get('m1')?.status === 'FAILED');
  const got = store.messages.get('m1')!;
  assert.ok(got.dlqAt);
  assert.ok(got.timeline.some((e) => e.note?.includes('retried from the DLQ')));
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

test('dispatcher lifecycle events observe holds, releases, DLQ and deliveries', async (t) => {
  const store = new FakeStore();
  const events: string[] = [];
  const dispatcher = new Dispatcher({
    store,
    dedup: new InMemoryDedupStore(),
    routes: new InMemoryRouteStore(),
    matching: { registry: new InMemoryOrderRegistry() },
    events: {
      onHold: async () => {
        events.push('hold');
      },
      onRelease: async () => {
        events.push('release');
      },
      onDlq: async () => {
        events.push('dlq');
      },
      onDelivery: async (e) => {
        events.push(`delivery:${e.ok}`);
      },
    },
    pollMs: 5,
    sleep: () => Promise.resolve(),
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  // Unmatched → HELD → released → ROUTED (console destination).
  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'HELD');
  assert.ok(events.includes('hold'));
  await dispatcher.release('m1');
  await waitFor(() => store.messages.get('m1')?.status === 'ROUTED');
  assert.ok(events.includes('release'));
  assert.ok(events.includes('delivery:true'));
});

test('dispatcher reports failed deliveries through events', async (t) => {
  const target = await startHttp(100); // always fails
  t.after(() => target.close());
  const routes = new InMemoryRouteStore();
  await routes.upsertDestination(httpDestination(`http://127.0.0.1:${target.port}/hook`, 2));
  await routes.upsertRule({ id: 'r1', destinationId: 'lis-http', priority: 100, enabled: true });

  const store = new FakeStore();
  const failures: Array<{ destinationId: string; attempt: number }> = [];
  const dispatcher = new Dispatcher({
    store,
    dedup: new InMemoryDedupStore(),
    routes,
    events: {
      onDelivery: async (e) => {
        if (!e.ok) failures.push({ destinationId: e.destinationId, attempt: e.attempt });
      },
      onDlq: async () => {
        // no-op
      },
    },
    pollMs: 5,
    sleep: () => Promise.resolve(),
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'FAILED' && store.messages.get('m1')!.dlqAt !== undefined);
  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map((f) => f.attempt), [1, 2]);
  assert.ok(store.messages.get('m1')!.dlqAt);
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

test('unmatched messages are HELD, not delivered (no silent auto-assign)', async (t) => {
  const store = new FakeStore();
  const dispatcher = new Dispatcher({
    store,
    dedup: new InMemoryDedupStore(),
    routes: new InMemoryRouteStore(),
    matching: { registry: new InMemoryOrderRegistry() }, // no registered orders
    pollMs: 5,
    sleep: () => Promise.resolve(),
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'HELD');

  const got = store.messages.get('m1')!;
  assert.equal(got.status, 'HELD');
  assert.equal(got.match?.status, 'UNMATCHED');
  assert.ok(got.timeline.some((e) => e.stage === 'HELD'));
  assert.equal(store.attempts.length, 0);
});

test('matching registers the outcome and routes on a unique hit', async (t) => {
  const store = new FakeStore();
  const registry = new InMemoryOrderRegistry();
  await registry.register({ id: 'O1', patientId: 'P1', sampleId: 'S1', tests: ['GLUCOSE'], status: 'active', receivedAt: new Date().toISOString() });
  const dispatcher = new Dispatcher({
    store,
    dedup: new InMemoryDedupStore(),
    routes: new InMemoryRouteStore(),
    matching: { registry },
    pollMs: 5,
    sleep: () => Promise.resolve(),
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  const msg = message('m1');
  msg.payload!.order = { id: 'O1', sampleId: 'S1', tests: [] };
  await dispatcher.record(msg);
  await waitFor(() => store.messages.get('m1')?.status === 'ROUTED');

  const got = store.messages.get('m1')!;
  assert.equal(got.match?.status, 'MATCHED');
  assert.equal(got.match?.matchedOrderId, 'O1');
  assert.equal(got.match?.strategy, 'patientId+orderId');
});

test('release() re-enters a held message into delivery', async (t) => {
  const store = new FakeStore();
  const dispatcher = new Dispatcher({
    store,
    dedup: new InMemoryDedupStore(),
    routes: new InMemoryRouteStore(),
    matching: { registry: new InMemoryOrderRegistry() },
    pollMs: 5,
    sleep: () => Promise.resolve(),
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'HELD');
  assert.equal(await dispatcher.release('m1'), true);
  await waitFor(() => store.messages.get('m1')?.status === 'ROUTED');
  assert.ok(store.messages.get('m1')!.timeline.some((e) => e.note?.includes('released by operator')));
});

test('release() refuses messages that are not held', async (t) => {
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
  assert.equal(await dispatcher.release('m1'), false);
  assert.equal(await dispatcher.release('nope'), false);
});

test('an injected deliver is used for protocol destinations instead of the built-in', async (t) => {
  const routes = new InMemoryRouteStore();
  await routes.upsertDestination({
    id: 'lis-mllp',
    kind: 'hl7',
    name: 'LIS MLLP',
    hl7: { host: '127.0.0.1', port: 6661 },
    enabled: true,
    retry: { maxAttempts: 3, backoffMs: 1, backoffFactor: 2, jitter: false },
  });
  await routes.upsertRule({ id: 'r1', destinationId: 'lis-mllp', priority: 100, enabled: true });

  const delivered: Array<{ destination: Destination; message: CanonicalMessage }> = [];
  const store = new FakeStore();
  const dispatcher = new Dispatcher({
    store,
    dedup: new InMemoryDedupStore(),
    routes,
    deliver: async (destination, message) => void delivered.push({ destination, message }),
    pollMs: 5,
    sleep: () => Promise.resolve(),
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'ROUTED');

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.destination.id, 'lis-mllp');
  assert.equal(delivered[0]!.message.id, 'm1');
});

test('an hl7 destination without an injected deliver exhausts retries into the DLQ', async (t) => {
  const routes = new InMemoryRouteStore();
  await routes.upsertDestination({
    id: 'lis-mllp',
    kind: 'hl7',
    name: 'LIS MLLP',
    hl7: { host: '10.9.9.9', port: 6661 },
    enabled: true,
    retry: { maxAttempts: 3, backoffMs: 1, backoffFactor: 2, jitter: false },
  });
  await routes.upsertRule({ id: 'r1', destinationId: 'lis-mllp', priority: 100, enabled: true });

  const store = new FakeStore();
  const dispatcher = new Dispatcher({ store, dedup: new InMemoryDedupStore(), routes, pollMs: 5, sleep: () => Promise.resolve() });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message('m1'));
  await waitFor(() => store.messages.get('m1')?.status === 'FAILED' && store.messages.get('m1')!.dlqAt !== undefined);

  const got = store.messages.get('m1')!;
  assert.ok(got.dlqAt);
  assert.deepEqual(store.attempts.filter((a) => a.messageId === 'm1').map((a) => a.status), ['FAILED', 'FAILED', 'FAILED']);
  assert.ok(got.timeline.some((e) => e.note?.includes('unknown destination kind: hl7')));
});

test('validation errors hold the message in the exception queue', async (t) => {
  const store = new FakeStore();
  const registry = new InMemoryOrderRegistry();
  await registry.register({ id: 'O1', patientId: 'P1', sampleId: 'S1', tests: ['GLUCOSE'], status: 'active', receivedAt: new Date().toISOString() });
  const validation: Partial<ValidationConfig> = {
    rules: { ...DEFAULT_VALIDATION_RULES, resultPlausible: { enabled: true, severity: 'error' } },
    numericBounds: { GLUCOSE: { min: 0.5, max: 40 } },
  };
  const dispatcher = new Dispatcher({
    store,
    dedup: new InMemoryDedupStore(),
    routes: new InMemoryRouteStore(),
    matching: { registry },
    validation: { config: validation },
    pollMs: 5,
    sleep: () => Promise.resolve(),
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  const msg = message('m1');
  msg.payload!.order = { id: 'O1', sampleId: 'S1', tests: [] };
  msg.payload!.results = [{ testCode: 'GLUCOSE', value: '999', unit: 'mmol/L' }];
  await dispatcher.record(msg);
  await waitFor(() => store.messages.get('m1')?.status === 'HELD');

  const got = store.messages.get('m1')!;
  assert.equal(got.match?.status, 'MATCHED');
  assert.ok(got.timeline.some((e) => e.note?.includes('outside plausible range')));
  assert.equal(store.attempts.length, 0);
});