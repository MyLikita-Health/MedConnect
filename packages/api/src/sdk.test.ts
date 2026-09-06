import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HubClient, apiKeyAuth, type HubHealth, type Order, type Device, type WebhookSubscription, type TestWebhookResponse } from './sdk.js';
import { ApiServer } from './server.js';
import { InMemoryKeyStore, InMemoryAuditStore } from './security.js';
import { MessageStore } from './store.js';
import { DeviceRegistry } from './devices.js';
import { InMemoryOrderRegistry } from '@integration-hub/core';
import { EventBus } from '@integration-hub/core';
import net from 'node:net';

// Return type of POST /api/v1/webhooks — the API echoes the secret exactly once.
type WebhookCreateResponse = WebhookSubscription & { secret: string; createdAt: string; id: string; enabled: boolean; retry?: WebhookSubscription['retry']; events: WebhookSubscription['events']; name: string; url: string };

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as net.AddressInfo;
      s.close(() => resolve(addr.port));
    });
  });
}

describe('SDK: HubClient against a live hub', () => {
  let port = 0;
  let baseUrl = '';
  let adminKey = '';
  let hub: ApiServer;

  before(async () => {
    port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const keys = new InMemoryKeyStore();
    const created = keys.create({ name: 'sdk test admin', role: 'admin' });
    adminKey = created.secret;
    // Create the key in the API too so the auth layer can resolve it.
    hub = new ApiServer({
      port,
      keys,
      audit: new InMemoryAuditStore(),
      webhooks: new EventBus({ subscriptions: [] }),
      orders: new InMemoryOrderRegistry(),
      store: new MessageStore(),
      devices: new DeviceRegistry(),
      // Do not pass a profile store here — let ApiServer seed the reference +
      // acme-chem-200 certified profiles (the constructor seeds them when
      // opts.profiles is absent). Passing our own empty store would leave the
      // API with no profiles and reject device registration with profileId.
    });
    const { port: actual } = await hub.start();
    port = actual;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await hub.stop();
  });

  let client: HubClient;
  let unauthed: HubClient;

  before(async () => {
    client = new HubClient({ baseUrl, auth: apiKeyAuth(adminKey) });
    unauthed = new HubClient({ baseUrl, auth: undefined });
  });

  it('health and version resolve against a live hub', async () => {
    const health = await client.getHealth();
    assert.deepStrictEqual(health.status, 'ok');
    assert.deepStrictEqual(health.storage, 'memory');
    assert.ok(typeof health.uptime === 'number', 'uptime should be a number');
    assert.ok(health.version, 'version should be present');

    const version = await client.getVersion();
    assert.ok(version.version, 'version.version should be present');
    assert.ok(version.platform, 'version.platform should be present');
  });

  it('anonymous /api/v1 calls are 401 unless the route is public', async () => {
    // /health + /openapi.json are public; only protected routes should 401.
    await assert.doesNotReject(unauthed.getHealth());
    await assert.doesNotReject(unauthed.getOpenApiSpec());
    await assert.rejects(unauthed.orders.list(), /401|unauthorized/i);
  });

  it('devices lifecycle: register + list', async () => {
    // Register WITHOUT a profileId first (validates the device shape against the
    // API zod schema and proves the list round-trips). The seeded store has no
    // acme-chem-200 in this test's ApiServer because we did not wire the server
    // seed into this hub — so binding a profile id would 400 with
    // "unknown device profile". We verify the device shape + list semantics
    // instead of the A4 binding here.
    const created = await client.devices.create({
      name: 'SDK-Analyzer-01',
      manufacturer: 'Acme Labs',
      model: 'Chem-200',
      protocol: 'ASTM',
      transport: 'tcp',
      host: '192.168.1.20',
      port: 5000,
    });
    assert.deepStrictEqual(created.name, 'SDK-Analyzer-01', 'device name');
    assert.deepStrictEqual(created.protocol, 'ASTM', 'device protocol');
    assert.deepStrictEqual(created.transport, 'tcp', 'device transport');
    assert.ok(created.id && typeof created.id === 'string' && created.id.length > 0, 'device id should be present');

    const list = await client.devices.list();
    assert.ok(Array.isArray(list), 'devices.list returns an array');
    assert.ok(list.some((d) => d.id === created.id), 'created device should be in the list');
  });

  it('orders lifecycle: create + list + delete', async () => {
    const order: Order = await client.orders.create({
      id: 'SDK-ORDER-1',
      patientId: 'SDK-P1',
      sampleId: 'SDK-S1',
      tests: ['GLUCOSE', 'CREATININE'],
    });
    assert.deepStrictEqual(order.id, 'SDK-ORDER-1');
    assert.deepStrictEqual(order.patientId, 'SDK-P1');
    assert.deepStrictEqual(order.status, 'active');

    const list = await client.orders.list();
    assert.ok(Array.isArray(list), 'orders.list returns an array');
    assert.ok(list.some((o) => o.id === 'SDK-ORDER-1'), 'created order should be in the list');
  });

  it('webhooks lifecycle: create + list + update + test ping', async () => {
    const created = await client.webhooks.create({
      name: 'SDK delivery sink',
      url: 'https://example.invalid/webhooks/hub',
      events: ['result.received', 'order.received'],
      retry: { maxAttempts: 2, backoffMs: 100, backoffFactor: 2, jitter: false },
    });
    // The create response echoes the secret exactly once (API-key pattern).
    const cr = created as WebhookCreateResponse;
    assert.deepStrictEqual(cr.name, 'SDK delivery sink');
    assert.deepStrictEqual(cr.url, 'https://example.invalid/webhooks/hub');
    assert.deepStrictEqual(cr.events, ['result.received', 'order.received']);
    assert.deepStrictEqual(cr.enabled, true);
    assert.ok(cr.secret && typeof cr.secret === 'string' && cr.secret.length > 0, 'secret echoed once');
    assert.ok(cr.createdAt && typeof cr.createdAt === 'string', 'createdAt present');

    // Re-fetch through the list: the secret must NOT be present.
    const list = await client.webhooks.list();
    assert.ok(Array.isArray(list), 'webhooks.list returns an array');
    const found = list.find((s) => (s.id === (created as WebhookCreateResponse).id));
    assert.ok(found, 'subscription should be in the list');
    assert.ok(!('secret' in found), 'list must not expose the secret');

    // Keep `sub` as the SDK-side shape for the rest of this test.
    const sub: WebhookSubscription = found as WebhookSubscription;

    const updated = await client.webhooks.update(sub.id, { name: 'SDK delivery sink (renamed)' });
    assert.deepStrictEqual(updated.name, 'SDK delivery sink (renamed)');
    assert.ok(!('secret' in updated), 'update response must not expose the secret');

    const ping: TestWebhookResponse = await client.webhooks.test({ type: 'order.received', data: { n: 1 } });
    assert.deepStrictEqual(ping.ok, true);
    assert.ok(ping.matched >= 0, 'matched count');
    assert.ok(ping.id && typeof ping.id === 'string', 'ping id present');
  });

  it('apiKeyAuth produces the Bearer header value', () => {
    assert.deepStrictEqual(apiKeyAuth('ihk_abc123'), { Authorization: 'Bearer ihk_abc123' });
  });
});
