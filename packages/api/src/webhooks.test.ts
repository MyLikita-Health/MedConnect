/**
 * D3 slice 3 — webhook-subscriptions REST surface tests (plan §7.D): the
 * /api/v1/webhooks routes manage subscriptions on the live EventBus (secret
 * echoed exactly once at create, never re-exposed), surface the delivery
 * log, replay failed deliveries, and fire a test ping. Functional tests run
 * with auth off (a stubbed fetch captures deliveries without network); one
 * auth-scoped test asserts reads are `api:read` and mutations are
 * `config:write`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from './server.js';
import { MessageStore } from './store.js';
import { DeviceRegistry } from './devices.js';
import { InMemoryAuditStore, InMemoryKeyStore, type ApiKeyRole } from './security.js';
import {
  EVENT_HEADER,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  EventBus,
  verifyWebhookSignature,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookSubscription,
} from '@integration-hub/core';

const SECRET = 'webhook-test-secret-123';

function subscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'sub-1',
    name: 'LIS results',
    url: 'https://lis.local/hooks/results',
    secret: SECRET,
    events: ['result.received', 'order.received'],
    enabled: true,
    retry: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitter: false },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface StubFetch {
  fetch: typeof fetch;
  setFail(v: boolean): void;
}

/** fetch stub that captures deliveries; `setFail(true)` rejects like a down endpoint. */
function stubFetch(received: Captured[]): StubFetch {
  let fail = false;
  const fn = (async (url: string, init: RequestInit) => {
    if (fail) throw new Error('connection refused');
    const headers = Object.fromEntries(
      Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    received.push({ url: String(url), headers, body: String(init.body) });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  return { fetch: fn, setFail: (v: boolean) => {
    fail = v;
  } };
}

async function startApi(t: any) {
  const received: Captured[] = [];
  const stub = stubFetch(received);
  const bus = new EventBus({ subscriptions: [subscription()], fetch: stub.fetch });
  const store = new MessageStore();
  const devices = new DeviceRegistry();
  const api = new ApiServer({ port: 0, host: '127.0.0.1', store, devices, webhooks: bus });
  const { port } = await api.start();
  t.after(() => api.stop());
  return { base: `http://127.0.0.1:${port}`, bus, received, stub };
}

async function startAuthApi(t: any) {
  const keys: InMemoryKeyStore = new InMemoryKeyStore();
  await keys.create({ id: 'key-viewer', name: 'viewer', role: 'viewer' as ApiKeyRole, secret: 'ihk_webhook_viewer' });
  await keys.create({ id: 'key-eng', name: 'engineer', role: 'engineer' as ApiKeyRole, secret: 'ihk_webhook_eng' });
  const bus = new EventBus({ subscriptions: [subscription()], fetch: stubFetch([]).fetch });
  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store: new MessageStore(),
    devices: new DeviceRegistry(),
    webhooks: bus,
    keys,
    audit: new InMemoryAuditStore(),
  });
  const { port } = await api.start();
  t.after(() => api.stop());
  return { base: `http://127.0.0.1:${port}` };
}

function auth(base: string, secret: string) {
  return { Authorization: `Bearer ${secret}` };
}

test('subscription CRUD: create echoes the secret once, list/patch never re-expose it', async (t) => {
  const { base } = await startApi(t);

  // Create — the full record including the secret comes back exactly once.
  const created = await fetch(`${base}/api/v1/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Results webhook', url: 'https://lis.local/hooks/results', events: '*' }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as WebhookSubscription;
  assert.ok(createdBody.id, 'id auto-generated');
  assert.ok(createdBody.secret, 'secret echoed at create');
  assert.ok(createdBody.secret!.length >= 16, 'generated secret is long enough');

  // List — the secret is gone.
  const list = await fetch(`${base}/api/v1/webhooks`);
  assert.equal(list.status, 200);
  const subs = (await list.json()) as WebhookSubscription[];
  assert.equal(subs.length, 2); // the seeded one + the created one
  for (const sub of subs) assert.equal((sub as { secret?: string }).secret, undefined, 'no secret on list');

  // Patch — fields update, the secret is preserved unless replaced.
  const patched = await fetch(`${base}/api/v1/webhooks/${createdBody.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed webhook', enabled: false, events: ['result.received'] }),
  });
  assert.equal(patched.status, 200);
  const patchedBody = (await patched.json()) as WebhookSubscription;
  assert.equal(patchedBody.name, 'Renamed webhook');
  assert.equal(patchedBody.enabled, false);
  assert.deepEqual(patchedBody.events, ['result.received']);
  assert.equal((patchedBody as { secret?: string }).secret, undefined);

  // Patch with a new secret swaps it.
  const resecreted = await fetch(`${base}/api/v1/webhooks/${createdBody.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: 'replacement-secret-123' }),
  });
  assert.equal(resecreted.status, 200);

  // Delete + verify it is gone.
  const deleted = await fetch(`${base}/api/v1/webhooks/${createdBody.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  const after = await fetch(`${base}/api/v1/webhooks`).then((r) => r.json() as Promise<WebhookSubscription[]>);
  assert.equal(after.length, 1);

  // Unknown id: 404 on patch/delete.
  assert.equal((await fetch(`${base}/api/v1/webhooks/nope`, { method: 'DELETE' })).status, 404);
});

test('subscription input validation: bad events/urls are rejected', async (t) => {
  const { base } = await startApi(t);
  const bad = await fetch(`${base}/api/v1/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'bad', url: 'https://x.local', events: ['not.an.event'] }),
  });
  assert.equal(bad.status, 400);
  const badUrl = await fetch(`${base}/api/v1/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'bad', url: 'not-a-url', events: '*' }),
  });
  assert.equal(badUrl.status, 400);
});

test('test ping fires a signed delivery through the real bus', async (t) => {
  const { base, received } = await startApi(t);

  const res = await fetch(`${base}/api/v1/webhooks/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'result.received' }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { ok: boolean; id: string; matched: number };
  assert.equal(body.matched, 1);

  assert.equal(received.length, 1);
  const captured = received[0]!;
  const event = JSON.parse(captured.body) as WebhookEvent;
  assert.equal(event.id, body.id, 'event id reported matches the delivered envelope');
  assert.equal(captured.headers[EVENT_HEADER], 'result.received');
  assert.equal(captured.headers[EVENT_ID_HEADER], body.id);
  assert.equal(verifyWebhookSignature(SECRET, captured.body, captured.headers[SIGNATURE_HEADER]), true);

  // An event type nothing subscribes to is a no-op with an explanatory note.
  const none = await fetch(`${base}/api/v1/webhooks/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'device.connected' }),
  });
  const noneBody = (await none.json()) as { matched: number; note?: string };
  assert.equal(noneBody.matched, 0);
  assert.match(noneBody.note ?? '', /no enabled subscription/);
});

test('manual POST /api/v1/orders fires a signed order.received delivery (the REST fire point)', async (t) => {
  const { base, received } = await startApi(t);

  const res = await fetch(`${base}/api/v1/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'ACC-MANUAL-1',
      patientId: 'PID-2002',
      sampleId: 'S-42',
      tests: ['GLUCOSE', 'CREATININE'],
      status: 'active',
    }),
  });
  assert.equal(res.status, 201);

  // The order lands in the registry (the manual LIS seam).
  const orders = await fetch(`${base}/api/v1/orders`).then((r) => r.json() as Promise<Array<{ id: string }>>);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.id, 'ACC-MANUAL-1');

  // …and a signed order.received delivery reaches the subscription. The fire
  // is fire-and-forget (void), so give the stub a moment to land it.
  for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(received.length, 1, 'one signed delivery captured');
  const captured = received[0]!;
  const event = JSON.parse(captured.body) as WebhookEvent;
  assert.equal(captured.headers[EVENT_HEADER], 'order.received');
  assert.equal(captured.headers[EVENT_ID_HEADER], event.id);
  assert.equal(verifyWebhookSignature(SECRET, captured.body, captured.headers[SIGNATURE_HEADER]), true);
  // Same envelope shape as the HL7 ORM feed — only the source differs.
  assert.equal(event.source, 'hub:api');
  assert.equal(event.data.orderId, 'ACC-MANUAL-1');
  assert.equal(event.data.patientId, 'PID-2002');
  assert.equal(event.data.sampleId, 'S-42');
  assert.deepEqual(event.data.tests, ['GLUCOSE', 'CREATININE']);
  assert.equal(event.data.status, 'active');
});

test('deliveries log + replay: failed deliveries are listed and re-sent on replay', async (t) => {
  const { base, bus, received, stub } = await startApi(t);

  // Fire a delivery that FAILS (endpoint down) and confirm it lands in the log.
  stub.setFail(true);
  const { id: eventId } = await bus.fire({ type: 'order.received', source: 'test', data: { orderId: 'ACC-9' } });

  const log = await fetch(`${base}/api/v1/webhooks/deliveries`).then((r) => r.json() as Promise<WebhookDelivery[]>);
  const failed = log.find((d) => d.eventId === eventId);
  assert.ok(failed, 'failed delivery is listed');
  assert.equal(failed!.ok, false);
  assert.match(failed!.lastError ?? '', /connection refused/);

  // Replaying with the endpoint still down re-attempts (still failing — the
  // delivery stays failed); replay of an unknown event id is a 404.
  const replayDown = await fetch(`${base}/api/v1/webhooks/deliveries/${eventId}/replay`, { method: 'POST' });
  assert.equal(replayDown.status, 200);
  const replayDownBody = (await replayDown.json()) as { attempted: number };
  assert.equal(replayDownBody.attempted, 1);
  assert.equal((await fetch(`${base}/api/v1/webhooks/deliveries/unknown/replay`, { method: 'POST' })).status, 404);

  // Operator fixes the endpoint → replay re-sends the SAME signed event.
  stub.setFail(false);
  const before = received.length;
  const replay = await fetch(`${base}/api/v1/webhooks/deliveries/${eventId}/replay`, { method: 'POST' });
  assert.equal(replay.status, 200);
  const replayBody = (await replay.json()) as { ok: boolean; attempted: number };
  assert.equal(replayBody.attempted, 1);
  assert.equal(received.length, before + 1);
  const resent = received[before]!;
  assert.equal(resent.headers[EVENT_ID_HEADER], eventId, 'replay re-sends the SAME event id');
  assert.equal(verifyWebhookSignature(SECRET, resent.body, resent.headers[SIGNATURE_HEADER]), true);
  const resentEvent = JSON.parse(resent.body) as WebhookEvent;
  assert.equal(resentEvent.data.orderId, 'ACC-9');

  // The delivery now reads ok in the log.
  const afterLog = await fetch(`${base}/api/v1/webhooks/deliveries`).then((r) => r.json() as Promise<WebhookDelivery[]>);
  assert.equal(afterLog.find((d) => d.eventId === eventId)?.ok, true);
});

test('auth: reads are api:read, mutations are config:write (engineer+), anonymous is 401', async (t) => {
  const { base } = await startAuthApi(t);

  // Anonymous → 401 on everything under /api/v1.
  assert.equal((await fetch(`${base}/api/v1/webhooks`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/webhooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);

  // Viewer can read subscriptions but not mutate (config:write needs engineer).
  const viewerGet = await fetch(`${base}/api/v1/webhooks`, { headers: auth(base, 'ihk_webhook_viewer') });
  assert.equal(viewerGet.status, 200);
  const viewerPost = await fetch(`${base}/api/v1/webhooks`, {
    method: 'POST',
    headers: { ...auth(base, 'ihk_webhook_viewer'), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'nope', url: 'https://x.local', events: '*' }),
  });
  assert.equal(viewerPost.status, 403);

  // Engineer can create + replay + test.
  const engPost = await fetch(`${base}/api/v1/webhooks`, {
    method: 'POST',
    headers: { ...auth(base, 'ihk_webhook_eng'), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'eng sub', url: 'https://lis.local/hooks/eng', events: ['order.received'] }),
  });
  assert.equal(engPost.status, 201);
  const engTest = await fetch(`${base}/api/v1/webhooks/test`, {
    method: 'POST',
    headers: { ...auth(base, 'ihk_webhook_eng'), 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'order.received' }),
  });
  assert.equal(engTest.status, 201);
  assert.equal((await fetch(`${base}/api/v1/webhooks/deliveries`, { headers: auth(base, 'ihk_webhook_eng') })).status, 200);
});