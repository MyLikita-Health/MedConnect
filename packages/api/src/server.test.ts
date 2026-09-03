import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from './server.js';
import { DeviceRegistry } from './devices.js';
import { MessageStore } from './store.js';
import type { CanonicalMessage } from '@integration-hub/shared';

function message(overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    protocol: 'ASTM',
    direction: 'device-to-host',
    deviceId: 'SIM-1',
    receivedAt: new Date().toISOString(),
    raw: 'H|\\^&||||SIM^1|||||||P|1|20260903143000',
    status: 'ROUTED',
    errors: [],
    timeline: [{ stage: 'RECEIVED', at: new Date().toISOString() }],
    ...overrides,
  };
}

async function startApi(t: any, replayHandler?: (m: CanonicalMessage) => CanonicalMessage) {
  const store = new MessageStore();
  const devices = new DeviceRegistry();
  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store,
    devices,
    replayHandler,
  });
  const { port } = await api.start();
  t.after(() => api.stop());
  return { base: `http://127.0.0.1:${port}`, store, devices };
}

test('REST API serves health, stats and the console UI', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message({ id: 'm1' }));

  const health = (await (await fetch(`${base}/api/v1/health`)).json()) as { status: string };
  assert.equal(health.status, 'ok');

  const stats = (await (await fetch(`${base}/api/v1/stats`)).json()) as { total: number };
  assert.equal(stats.total, 1);

  const ui = await (await fetch(base)).text();
  assert.ok(ui.includes('Integration Hub'));
});

test('REST API returns a single message by id and 404 for unknown', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message({ id: 'm1' }));

  const byId = (await (await fetch(`${base}/api/v1/messages/m1`)).json()) as CanonicalMessage;
  assert.equal(byId.id, 'm1');

  const missing = await fetch(`${base}/api/v1/messages/nope`);
  assert.equal(missing.status, 404);
});

test('replay endpoint re-runs a message via the wired handler', async (t) => {
  const replayed: CanonicalMessage[] = [];
  const { base, store } = await startApi(t, (m) => {
    const copy = message({ id: `replay-${m.id}`, raw: m.raw });
    replayed.push(copy);
    return copy;
  });
  store.record(message({ id: 'm1' }));

  const res = await fetch(`${base}/api/v1/messages/m1/replay`, { method: 'POST' });
  assert.equal(res.status, 201);
  const body = (await res.json()) as CanonicalMessage;
  assert.equal(body.id, 'replay-m1');
  assert.equal(replayed.length, 1);

  const notFound = await fetch(`${base}/api/v1/messages/ghost/replay`, { method: 'POST' });
  assert.equal(notFound.status, 404);
});

test('replay endpoint returns 501 when no handler is wired', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message({ id: 'm1' }));
  const res = await fetch(`${base}/api/v1/messages/m1/replay`, { method: 'POST' });
  assert.equal(res.status, 501);
});

test('device registration endpoint creates and lists devices', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mindray BS-430', manufacturer: 'Mindray', model: 'BS-430' }),
  });
  assert.equal(res.status, 201);
  const record = (await res.json()) as { id: string; state: string };
  assert.equal(record.id, 'mindray-bs-430');
  assert.equal(record.state, 'unknown');

  const list = (await (await fetch(`${base}/api/v1/devices`)).json()) as unknown[];
  assert.equal(list.length, 1);
});

test('destination and route endpoints manage routing configuration', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/destinations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'lis-webhook',
      name: 'LIS webhook',
      kind: 'http',
      url: 'http://127.0.0.1:9999/hook',
      retry: { maxAttempts: 5 },
    }),
  });
  assert.equal(res.status, 201);
  const destinations = (await (await fetch(`${base}/api/v1/destinations`)).json()) as Array<{ id: string; retry: { maxAttempts: number } }>;
  assert.equal(destinations.length, 1);
  assert.equal(destinations[0]!.retry.maxAttempts, 5);

  const consoleBad = await fetch(`${base}/api/v1/destinations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'console', name: 'x' }),
  });
  assert.equal(consoleBad.status, 400);

  const routeRes = await fetch(`${base}/api/v1/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'r1', destinationId: 'lis-webhook', deviceId: 'SIM-1' }),
  });
  assert.equal(routeRes.status, 201);
  const rules = (await (await fetch(`${base}/api/v1/routes`)).json()) as unknown[];
  assert.equal(rules.length, 1);

  const deleted = await fetch(`${base}/api/v1/destinations/lis-webhook`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal(((await (await fetch(`${base}/api/v1/destinations`)).json()) as unknown[]).length, 0);
});

test('dlq endpoint lists failed messages and discard retires them', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message({ id: 'm1', status: 'FAILED' }));
  store.mark('m1', 'FAILED', 'DLQ: delivery failed', { dlqAt: new Date().toISOString() });
  store.record(message({ id: 'm2', status: 'ROUTED' }));

  const dlq = (await (await fetch(`${base}/api/v1/dlq`)).json()) as Array<{ id: string }>;
  assert.equal(dlq.length, 1);
  assert.equal(dlq[0]!.id, 'm1');

  const discard = await fetch(`${base}/api/v1/messages/m1/discard`, { method: 'POST' });
  assert.equal(discard.status, 200);
  assert.equal(store.get('m1')?.status, 'DISCARDED');

  const missing = await fetch(`${base}/api/v1/messages/ghost/discard`, { method: 'POST' });
  assert.equal(missing.status, 404);
});

test('results endpoint flattens result rows across messages', async (t) => {
  const { base, store } = await startApi(t);
  store.record(
    message({
      id: 'm1',
      payload: {
        patient: { id: 'P1', name: 'Doe, John' },
        order: { id: 'ACC1', tests: [] },
        results: [{ testCode: 'GLUCOSE', value: '95', unit: 'mg/dL' }],
      },
    }),
  );
  const rows = (await (await fetch(`${base}/api/v1/results`)).json()) as Array<{ testCode: string; patient: unknown }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.testCode, 'GLUCOSE');
});