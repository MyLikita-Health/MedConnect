/**
 * D3 webhook event bus tests (plan §7.D D3): signature correctness +
 * verification (the D exit criterion), event→subscription matching, retry
 * behavior, and replay of failed deliveries with the SAME signed body + event
 * id (idempotency for consumers).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_HEADER,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  EventBus,
  signWebhook,
  verifyWebhookSignature,
  type WebhookEvent,
  type WebhookSubscription,
} from './event-bus.js';

function subscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'sub-1',
    name: 'LIS results',
    url: 'http://lis.local/hooks/results',
    secret: 's3cret',
    events: '*',
    enabled: true,
    retry: { maxAttempts: 2, backoffMs: 0, backoffFactor: 1, jitter: false },
    createdAt: '2026-09-04T00:00:00Z',
    ...overrides,
  };
}

test('sign + verify: the signature header authenticates the exact body', () => {
  const body = JSON.stringify({ hello: 'world' });
  const sig = signWebhook('s3cret', body);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.equal(verifyWebhookSignature('s3cret', body, sig), true);
  // Wrong secret, tampered body, and a missing header all fail.
  assert.equal(verifyWebhookSignature('other', body, sig), false);
  assert.equal(verifyWebhookSignature('s3cret', JSON.stringify({ hello: 'nope' }), sig), false);
  assert.equal(verifyWebhookSignature('s3cret', body, undefined), false);
  assert.equal(verifyWebhookSignature('s3cret', body, 'md5=deadbeef'), false);
});

test('fire delivers a signed POST only to enabled matching subscriptions', async () => {
  const received: { url: string; headers: Record<string, string>; body: string }[] = [];
  const stubFetch = (async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    received.push({ url: String(url), headers, body: String(init.body) });
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;

  const bus = new EventBus({
    subscriptions: [
      subscription({ id: 'all', events: '*' }),
      subscription({ id: 'results-only', events: ['result.received'], enabled: false }), // disabled → skipped
      subscription({ id: 'orders-only', events: ['order.received'] }), // wrong event → skipped
    ],
    fetch: stubFetch,
  });

  await bus.fire({ type: 'result.received', source: 'facility-1', data: { accession: 'ACC-1', patientId: 'P1' } });

  assert.equal(received.length, 1);
  const delivery = received[0]!;
  assert.equal(delivery.url, 'http://lis.local/hooks/results');

  const event = JSON.parse(delivery.body) as WebhookEvent;
  assert.equal(event.type, 'result.received');
  assert.equal(event.source, 'facility-1');
  assert.deepEqual(event.data, { accession: 'ACC-1', patientId: 'P1' });
  assert.ok(event.id);
  assert.ok(event.occurredAt);

  // Headers: type + id + timestamp + a signature that verifies against the body.
  assert.equal(delivery.headers[EVENT_HEADER], 'result.received');
  assert.equal(delivery.headers[EVENT_ID_HEADER], event.id);
  assert.equal(delivery.headers[SIGNATURE_HEADER], signWebhook('s3cret', delivery.body));
  assert.equal(verifyWebhookSignature('s3cret', delivery.body, delivery.headers[SIGNATURE_HEADER]), true);

  // Event retained for replay.
  assert.equal(bus.listDeliveries().length, 1);
});

test('delivery retries per the subscription policy and records attempts', async () => {
  let calls = 0;
  const stubFetch = (async () => {
    calls += 1;
    throw new Error('connection refused');
  }) as unknown as typeof fetch;
  const bus = new EventBus({
    subscriptions: [subscription({ retry: { maxAttempts: 3, backoffMs: 0, backoffFactor: 1, jitter: false } })],
    fetch: stubFetch,
  });

  await bus.fire({ type: 'device.disconnected', source: 'facility-1', data: { deviceId: 'CT-1' } });

  assert.equal(calls, 3); // initial + 2 retries
  const [delivery] = bus.listDeliveries();
  assert.equal(delivery?.ok, false);
  assert.equal(delivery?.attempts.length, 3);
  assert.equal(delivery?.attempts[0]?.attempt, 1);
  assert.equal(delivery?.lastError, 'connection refused');
});

test('replay re-sends failed deliveries with the same signed body and event id', async () => {
  const received: { url: string; headers: Record<string, string>; body: string }[] = [];
  let accepting = false; // endpoint down until we flip it
  const stubFetch = (async (url: string, init: RequestInit) => {
    if (!accepting) throw new Error('down');
    const headers = Object.fromEntries(
      Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    received.push({ url: String(url), headers, body: String(init.body) });
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const bus = new EventBus({ subscriptions: [subscription()], fetch: stubFetch });

  await bus.fire({ type: 'order.received', source: 'facility-1', data: { accession: 'ACC-9' } });
  const failed = bus.listDeliveries()[0]!;
  assert.equal(failed.ok, false); // both attempts failed (maxAttempts 2, endpoint down)

  accepting = true; // operator fixes the endpoint, then replays
  const replayed = await bus.replay(failed.eventId);
  assert.equal(replayed, 1);

  assert.equal(received.length, 1);
  const resent = received[0]!;
  const resentEvent = JSON.parse(resent.body) as WebhookEvent;
  assert.equal(resentEvent.id, failed.eventId); // SAME id — consumers dedupe
  assert.equal(resent.headers[EVENT_ID_HEADER], failed.eventId);
  assert.equal(verifyWebhookSignature('s3cret', resent.body, resent.headers[SIGNATURE_HEADER]), true);
  assert.equal(bus.listDeliveries().find((d) => d.eventId === failed.eventId)?.ok, true);
});

test('subscriptions are managed at runtime (list/add/remove) and fire reports matches', async () => {
  const stubFetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
  const bus = new EventBus({ fetch: stubFetch });
  assert.deepEqual(bus.listSubscriptions(), []);

  bus.addSubscription(subscription({ id: 'a', events: ['order.received'] }));
  bus.addSubscription(subscription({ id: 'b', events: ['result.received'], enabled: false }));
  assert.equal(bus.listSubscriptions().length, 2);

  // Matching counts only enabled subscriptions subscribed to the event.
  const fired = await bus.fire({ type: 'order.received', source: 'facility-1', data: {} });
  assert.equal(fired.matched, 1);
  assert.ok(fired.id);

  // addSubscription is an idempotent upsert; removeSubscription deletes.
  bus.addSubscription(subscription({ id: 'a', events: '*' }));
  assert.equal(bus.listSubscriptions().length, 2);
  assert.equal(bus.removeSubscription('a'), true);
  assert.equal(bus.removeSubscription('a'), false);
  assert.equal(bus.listSubscriptions().length, 1);
  assert.equal(bus.removeSubscription('b'), true);
  assert.deepEqual(bus.listSubscriptions(), []);
});

test('an event with no matching subscription is a no-op', async () => {
  let calls = 0;
  const stubFetch = (async () => {
    calls += 1;
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const bus = new EventBus({
    subscriptions: [subscription({ events: ['order.received'] })],
    fetch: stubFetch,
  });
  const fired = await bus.fire({ type: 'device.connected', source: 'facility-1', data: { deviceId: 'X' } });
  assert.equal(calls, 0);
  assert.equal(fired.matched, 0);
});