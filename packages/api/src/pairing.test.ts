/**
 * W4 — cloud-pairing surface tests (docs/windows-desktop-installer.md §8.4
 * exit proof a). Runs against a real ApiServer over the loopback with a temp
 * SQLite settings store and a MOCK CLOUD (a Fastify-less node:http server
 * standing in for POST /api/v1/provision/claim) — no Postgres, no Docker.
 *
 * Proves:
 *   - status starts unpaired (public, no secrets)
 *   - the claim is public ONLY while unpaired; a successful claim persists
 *     the H3 bundle (identity + the gateway key at rest) and never echoes
 *     the key back over the API
 *   - cloud error mapping: 410 expired / 401 invalid / 409 consumed / 502
 *     unreachable + timeout
 *   - re-claim fails closed (409) even for an admin
 *   - unpair is config:write-only and forgets the binding
 *   - the pairing survives a store close/reopen (restart proof)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { ApiServer } from './server.js';
import { InMemoryAuditStore, InMemoryKeyStore } from './security.js';
import { InMemoryAdmissionRegistry, InMemoryAlertStore, InMemoryOrderRegistry, InMemoryProfileStore, InMemoryRouteStore, EventBus } from '@integration-hub/core';
import { MessageStore } from './store.js';
import { DeviceRegistry } from './devices.js';
import { openSqliteDatabase, SqliteLocalSettingsStore, type SqliteDb } from './sqlite/index.js';

/** A mock cloud: counts claims and replays a scripted status/hostname. */
interface MockCloud {
  url: string;
  claims: number;
  close: () => Promise<void>;
  /** Next response to serve: status + body (default: the full H3 bundle). */
  next: { status: number; body?: unknown } | undefined;
}

async function startMockCloud(t: test.TestContext): Promise<MockCloud> {
  const cloud: MockCloud = {
    url: '',
    claims: 0,
    close: async () => undefined,
    next: undefined,
  };
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v1/provision/claim') {
      cloud.claims++;
      // Default: the full H3 bundle. `next` overrides status (and body if
      // provided) — a bare { status: 201 } replays the default bundle.
      const bundle = {
        gateway: { id: 'gw-1', name: 'St. Mary edge', facilityId: 'fac-9', orgId: 'org-7' },
        cloud: { baseUrl: 'http://cloud.test:9', ingestPath: '/api/v1/sync/ingest' },
        apiKey: 'ihk_gw_secret_1234567890',
        tenancy: { orgId: 'org-7', facilityId: 'fac-9' },
        claimedAt: '2026-09-10T00:00:00.000Z',
      };
      if (cloud.next) {
        res.writeHead(cloud.next.status).end(JSON.stringify(cloud.next.body ?? bundle));
        return;
      }
      res.writeHead(201).end(JSON.stringify(bundle));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  cloud.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return cloud;
}

let dir: string;
let db: SqliteDb;
let settings: SqliteLocalSettingsStore;
let keys: InMemoryKeyStore;
let adminSecret = '';

function admin(): Record<string, string> {
  return { authorization: `Bearer ${adminSecret}` };
}

test('pairing surface: claim → persisted bundle → fail-closed → unpair', async (t) => {
  const cloud = await startMockCloud(t);
  dir = mkdtempSync(join(tmpdir(), 'hub-pairing-'));
  db = openSqliteDatabase((f) => new BetterSqlite3(f), join(dir, 'hub.sqlite'));
  settings = new SqliteLocalSettingsStore(db);
  keys = new InMemoryKeyStore();
  const audit = new InMemoryAuditStore();
  t.after(() => db.close()); // dir removed by the LAST test (reopen proof)

  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store: new MessageStore(),
    devices: new DeviceRegistry(),
    routes: new InMemoryRouteStore(),
    orders: new InMemoryOrderRegistry(),
    admissions: new InMemoryAdmissionRegistry(),
    alerts: new InMemoryAlertStore(),
    profiles: new InMemoryProfileStore(),
    keys,
    audit,
    pairing: { settings },
    webhooks: new EventBus({ subscriptions: [] }),
  });
  t.after(() => api.stop());
  const base = `http://127.0.0.1:${(await api.start()).port}`;

  // Mint an admin key directly (the pairing tests do not exercise W2 setup).
  const adminRow = await keys.create({ id: 'admin', name: 'admin', role: 'admin' });
  adminSecret = adminRow.secret;

  // 1. Status is public, unpaired, and carries no secrets.
  const statusRes = await fetch(`${base}/api/v1/pairing/status`);
  assert.equal(statusRes.status, 200, 'status is public');
  assert.deepEqual(await statusRes.json(), { paired: false });

  // 2. The claim is public while unpaired (the pairing code is the credential)
  // and proxies to the cloud's H3 route.
  const claim = await fetch(`${base}/api/v1/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cloudBaseUrl: cloud.url, pairingCode: 'ihp_test-code-123' }),
  });
  assert.equal(claim.status, 201, 'claim succeeds against the mock cloud');
  const claimBody = (await claim.json()) as Record<string, unknown>;
  assert.equal(claimBody.paired, true);
  assert.equal(claimBody.gatewayId, 'gw-1');
  assert.equal(claimBody.facilityId, 'fac-9');
  assert.equal(claimBody.syncEndpoint, 'http://cloud.test:9', 'the bundle reported the cloud URL');
  assert.equal(cloud.claims, 1);
  assert.equal('apiKey' in claimBody, false, 'the gateway key NEVER echoes back');
  assert.equal(JSON.stringify(claimBody).includes('ihk_gw_secret'), false, 'no secret anywhere in the response');

  // 3. The bundle persisted: identity + the key at rest (store seam, for the
  // syncer — not the operator).
  assert.deepEqual(
    settings.get('pairing'),
    {
      state: 'paired',
      gatewayId: 'gw-1',
      gatewayName: 'St. Mary edge',
      facilityId: 'fac-9',
      orgId: 'org-7',
      claimedAt: '2026-09-10T00:00:00.000Z',
    },
  );
  const cloudConfig = settings.get<{ cloudBaseUrl: string; gatewayId: string; gatewayKey: string; ingestPath?: string }>('cloud');
  assert.equal(cloudConfig?.gatewayKey, 'ihk_gw_secret_1234567890', 'the key landed at rest for the syncer');
  assert.equal(cloudConfig?.cloudBaseUrl, 'http://cloud.test:9');

  // 4. Status now reports paired — still no secrets.
  const status2 = (await fetch(`${base}/api/v1/pairing/status`).then((r) => r.json())) as Record<string, unknown>;
  assert.equal(status2.paired, true);
  assert.equal(status2.syncConfigured, true);
  assert.equal(status2.syncEndpoint, 'http://cloud.test:9');
  assert.equal(JSON.stringify(status2).includes('ihk_gw_secret'), false, 'status leaks no key');

  // 5. Re-claim fails closed: anonymous 401 (the auth hook no longer
  // bypasses once paired) and an ADMIN re-post reaches the route, which 409s.
  const anonAgain = await fetch(`${base}/api/v1/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cloudBaseUrl: cloud.url, pairingCode: 'ihp_another-code-456' }),
  });
  assert.equal(anonAgain.status, 401, 'anonymous re-claim is unauthorized once paired');
  // fail-closed: with no ROUTE_SCOPES entry, the hook 403s ANY caller — the
  // route's own 409 is unreachable defense-in-depth (same contract as the W2
  // setup completion). Re-pairing is unpair (admin) then claim.
  const adminAgain = await fetch(`${base}/api/v1/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...admin() },
    body: JSON.stringify({ cloudBaseUrl: cloud.url, pairingCode: 'ihp_another-code-456' }),
  });
  assert.equal(adminAgain.status, 403, 'even an admin re-claim is forbidden once paired (fail-closed)');
  assert.equal(cloud.claims, 1, 'no claim ever reached the cloud again');

  // 6. Cloud error mapping (unpaired first — unpair via the store seam to
  // exercise each mapping cleanly).
  const claimUrl = `${base}/api/v1/pairing/claim`;
  const tryClaim = async (status: number, body?: unknown): Promise<Response> => {
    settings.delete('pairing');
    settings.delete('cloud');
    cloud.next = { status, body };
    return fetch(claimUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cloudBaseUrl: cloud.url, pairingCode: 'ihp_code-789' }),
    });
  };
  assert.equal((await tryClaim(410)).status, 410, 'expired code maps 410');
  assert.equal((await tryClaim(401)).status, 401, 'invalid code maps 401');
  assert.equal((await tryClaim(409)).status, 409, 'consumed code maps 409');
  assert.equal((await tryClaim(501)).status, 502, 'cloud without a registry maps 502');
  assert.equal((await tryClaim(500, { error: 'boom' })).status, 502, 'any other cloud failure maps 502');
  cloud.next = undefined;

  // Unreachable cloud: point the claim at a dead port.
  settings.delete('pairing');
  settings.delete('cloud');
  const dead = await fetch(claimUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cloudBaseUrl: 'http://127.0.0.1:1', pairingCode: 'ihp_code-dead' }),
  });
  assert.equal(dead.status, 502, 'an unreachable cloud maps 502');

  // Restore the pairing for the persistence proof.
  cloud.next = { status: 201 };
  settings.delete('pairing');
  settings.delete('cloud');
  const restore = await fetch(claimUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cloudBaseUrl: cloud.url, pairingCode: 'ihp_code-restore' }),
  });
  assert.equal(restore.status, 201);
  cloud.next = undefined;

  // 7. Unpair is config:write — anonymous 401, operator/viewer 403, admin 200.
  settings.delete('pairing');
  settings.delete('cloud');
  const operator = await keys.create({ name: 'op', role: 'operator' });
  const viewer = await keys.create({ name: 'view', role: 'viewer' });
  const restoreAgain = await fetch(claimUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cloudBaseUrl: cloud.url, pairingCode: 'ihp_code-rbac' }),
  });
  assert.equal(restoreAgain.status, 201);
  const anonUnpair = await fetch(`${base}/api/v1/pairing/unpair`, { method: 'POST' });
  assert.equal(anonUnpair.status, 401);
  const opUnpair = await fetch(`${base}/api/v1/pairing/unpair`, { method: 'POST', headers: { authorization: `Bearer ${operator.secret}` } });
  assert.equal(opUnpair.status, 403, 'operator lacks config:write');
  const viewUnpair = await fetch(`${base}/api/v1/pairing/unpair`, { method: 'POST', headers: { authorization: `Bearer ${viewer.secret}` } });
  assert.equal(viewUnpair.status, 403, 'viewer lacks config:write');
  const adminUnpair = await fetch(`${base}/api/v1/pairing/unpair`, { method: 'POST', headers: admin() });
  assert.equal(adminUnpair.status, 200);
  assert.equal(settings.get('pairing'), undefined, 'the binding is forgotten');
  assert.equal(settings.get('cloud'), undefined);

  // 8. Malformed claim bodies are rejected (schema).
  const bad = await fetch(claimUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cloudBaseUrl: 'not-a-url', pairingCode: 'short' }),
  });
  assert.equal(bad.status, 400);
});

test('pairing survives a store close/reopen (restart proof)', async (t) => {
  const cloud = await startMockCloud(t);
  dir = mkdtempSync(join(tmpdir(), 'hub-pairing-reopen-'));
  const file = join(dir, 'hub.sqlite');
  const db1 = openSqliteDatabase((f) => new BetterSqlite3(f), file);
  const settings1 = new SqliteLocalSettingsStore(db1);
  const keys1 = new InMemoryKeyStore();

  const api1 = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store: new MessageStore(),
    devices: new DeviceRegistry(),
    routes: new InMemoryRouteStore(),
    orders: new InMemoryOrderRegistry(),
    admissions: new InMemoryAdmissionRegistry(),
    alerts: new InMemoryAlertStore(),
    profiles: new InMemoryProfileStore(),
    keys: keys1,
    audit: new InMemoryAuditStore(),
    pairing: { settings: settings1 },
    webhooks: new EventBus({ subscriptions: [] }),
  });
  t.after(() => api1.stop());
  const base1 = `http://127.0.0.1:${(await api1.start()).port}`;

  const claim = await fetch(`${base1}/api/v1/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cloudBaseUrl: cloud.url, pairingCode: 'ihp_persist-code' }),
  });
  assert.equal(claim.status, 201);
  db1.close();
  await api1.stop();

  // "Restart": same file, new handles.
  const db2 = openSqliteDatabase((f) => new BetterSqlite3(f), file);
  const settings2 = new SqliteLocalSettingsStore(db2);
  t.after(() => db2.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(settings2.get<{ state: string }>('pairing')?.state, 'paired', 'the pairing survived the restart');
  assert.ok(settings2.get<{ gatewayKey: string }>('cloud')?.gatewayKey, 'the syncer credential survived the restart');
  rmSync(dir, { recursive: true, force: true });
});
