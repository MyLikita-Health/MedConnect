/**
 * W2 — first-boot setup surface tests (docs/windows-desktop-installer.md §8.2
 * exit proof 1). Runs against a real ApiServer over the loopback with a temp
 * SQLite settings store — no Postgres, no Docker.
 *
 * Proves:
 *   - status starts firstBoot:true (public, no auth)
 *   - anonymous completion mints the admin key (secret shown exactly once)
 *     and flips the flag in the same flow
 *   - re-completion 403s even anonymously (fail closed)
 *   - settings land in local_settings and survive store reopen
 *   - every OTHER route still requires auth while unconfigured
 *   - the settings PATCH requires an admin key (config:write)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

let dir: string;
let db: SqliteDb;
let settings: SqliteLocalSettingsStore;
let keys: InMemoryKeyStore;
let audit: InMemoryAuditStore;
let baseUrl: string;
let admin: () => Record<string, string>;

test('setup surface: first-boot flow end to end', async (t) => {
  dir = mkdtempSync(join(tmpdir(), 'hub-setup-'));
  db = openSqliteDatabase((f) => new BetterSqlite3(f), join(dir, 'hub.sqlite'));
  settings = new SqliteLocalSettingsStore(db);
  keys = new InMemoryKeyStore();
  audit = new InMemoryAuditStore();
  t.after(() => db.close()); // dir removed by the LAST test (reopen proof)

  const routes = new InMemoryRouteStore();
  const orders = new InMemoryOrderRegistry();
  const admissions = new InMemoryAdmissionRegistry();
  const alerts = new InMemoryAlertStore();
  const profiles = new InMemoryProfileStore();
  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store: new MessageStore(),
    devices: new DeviceRegistry(),
    routes,
    orders,
    admissions,
    alerts,
    profiles,
    keys,
    audit,
    setup: { settings, keys },
    webhooks: new EventBus({ subscriptions: [] }),
  });
  t.after(() => api.stop());
  baseUrl = `http://127.0.0.1:${(await api.start()).port}`;
  admin = () => ({ authorization: `Bearer ${keys.list()[0]?.id ?? ''}` }); // replaced below after mint

  // 1. Status is public and reports first boot.
  const status1 = (await fetch(`${baseUrl}/api/v1/setup/status`).then((r) => r.json())) as { firstBoot: boolean };
  assert.equal(status1.firstBoot, true);

  // 2. Every OTHER route still 401s while unconfigured (no key exists yet).
  const statsBefore = await fetch(`${baseUrl}/api/v1/stats`);
  assert.equal(statsBefore.status, 401);

  // 3. Anonymous completion mints the admin key — shown exactly once.
  const complete = await fetch(`${baseUrl}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      facility: { name: "St. Mary's Laboratory", orgSlug: 'st-marys' },
      domains: { lab: true, imaging: false },
    }),
  });
  assert.equal(complete.status, 201);
  const body = (await complete.json()) as { adminKey?: { secret: string }; configuredAt?: string };
  assert.ok(body.adminKey?.secret, 'admin secret returned exactly once');
  assert.ok(body.configuredAt);
  const secret = body.adminKey!.secret;

  // 4. The key authenticates immediately.
  const me = await fetch(`${baseUrl}/api/v1/me`, { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(me.status, 200);
  const meBody = (await me.json()) as { role: string; name: string };
  assert.equal(meBody.role, 'admin');
  admin = () => ({ authorization: `Bearer ${secret}` });

  // 5. Status flips; re-completion fails closed — anonymous is 401 (the
  // hook no longer bypasses auth once configured) and an ADMIN re-posting
  // reaches the route, which 403s: setup is one-shot.
  const status2 = (await fetch(`${baseUrl}/api/v1/setup/status`).then((r) => r.json())) as { firstBoot: boolean; facility?: { name?: string } };
  assert.equal(status2.firstBoot, false);
  assert.equal(status2.facility?.name, "St. Mary's Laboratory");
  const anonAgain = await fetch(`${baseUrl}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ facility: { name: 'Second Try' } }),
  });
  assert.equal(anonAgain.status, 401);
  const adminAgain = await fetch(`${baseUrl}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...admin() },
    body: JSON.stringify({ facility: { name: 'Second Try' } }),
  });
  assert.equal(adminAgain.status, 403);

  // 6. Settings landed in local_settings (store seam, not a side file).
  assert.equal(settings.get<{ name: string }>('facility')?.name, "St. Mary's Laboratory");
  assert.equal(settings.isConfigured(), true);

  // 7. Settings PATCH requires auth + admin (config:write); GET too.
  const anonPatch = await fetch(`${baseUrl}/api/v1/setup/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domains: { lab: true, imaging: true } }),
  });
  assert.equal(anonPatch.status, 401);
  const adminPatch = await fetch(`${baseUrl}/api/v1/setup/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...admin() },
    body: JSON.stringify({ domains: { lab: true, imaging: true } }),
  });
  assert.equal(adminPatch.status, 200);
  assert.deepEqual(settings.get<{ lab: boolean; imaging: boolean }>('domains'), { lab: true, imaging: true });
});

test('setup settings persist across store close/reopen (restart proof)', () => {
  // Same file, new handle — the W2 restart story.
  const reopened = openSqliteDatabase((f) => new BetterSqlite3(f), join(dir, 'hub.sqlite'));
  const settings2 = new SqliteLocalSettingsStore(reopened);
  assert.equal(settings2.isConfigured(), true);
  assert.equal(settings2.get<{ name: string }>('facility')?.name, "St. Mary's Laboratory");
  assert.equal(settings2.get<{ imaging: boolean }>('domains')?.imaging, true);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});
