/**
 * W1 e2e — the fully-local, no-Docker hub run (D12; docs §8.1 exit proof),
 * extended with the W2 first-boot setup flow (docs §8.2 exit proof 3):
 * startHub on a temp SQLite file boots UNCONFIGURED (local setup auto-on for
 * SQLite), the setup flow is completed via the API (admin key minted and
 * shown exactly once), an analyzer is simulated end-to-end over the wire
 * (parse → canonicalize → match → route → deliver), and everything persists
 * across stop → restart on the same file — including the completed-setup flag.
 *
 * No Docker, no Postgres — this is the Windows-desktop local-mode shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type Hub } from './index.js';

test('startHub runs fully-local on SQLite: setup → wire → pipeline → API → restart persistence', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-sqlite-e2e-'));
  const file = join(dir, 'hub.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Hermetic: a developer's HUB_ADMIN_KEY must not change the boot behavior.
  const savedAdminKey = process.env.HUB_ADMIN_KEY;
  delete process.env.HUB_ADMIN_KEY;
  t.after(() => {
    if (savedAdminKey !== undefined) process.env.HUB_ADMIN_KEY = savedAdminKey;
  });

  // ---------- Boot 1: the local edge, unconfigured (W2 first boot) ----------
  const hub1 = await startHub({
    sqlite: { file },
    httpPort: 0,
    devicePort: 0,
    seedDefaultAlerts: false,
  });
  t.after(() => hub1.stop().catch(() => undefined));
  assert.ok(hub1.sqlite, 'hub reports the sqlite backend');
  assert.equal(hub1.sqlite.file, file);
  assert.ok(hub1.setup, 'local setup surface is on for the SQLite backend');

  const base1 = `http://127.0.0.1:${hub1.ports.http}`;

  // First boot: status is public and reports unconfigured.
  const status1 = (await fetch(`${base1}/api/v1/setup/status`).then((r) => r.json())) as {
    firstBoot: boolean;
  };
  assert.equal(status1.firstBoot, true, 'boots unconfigured');

  // No admin key exists yet — the SETUP FLOW mints it at completion (W2).
  assert.equal(await hub1.keys?.get('admin'), undefined, 'no admin key before setup');

  // Anonymous completion: public ONLY while unconfigured; mints the admin key
  // returned exactly once (the H3 pairing-bundle pattern).
  const complete = await fetch(`${base1}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      facility: { name: 'St. Mary Lab', orgSlug: 'st-mary' },
      domains: { lab: true, imaging: false },
      network: { host: '0.0.0.0', devicePort: 5000, httpPort: 3000, tls: false },
    }),
  });
  assert.equal(complete.status, 201, 'setup completion succeeds on first boot');
  const completeBody = (await complete.json()) as { adminKey?: { secret: string }; firstBoot: boolean };
  const adminSecret = completeBody.adminKey?.secret;
  assert.ok(adminSecret, 'completion returns the admin secret exactly once');
  assert.equal(completeBody.firstBoot, false, 'completion flips the first-boot flag');

  // A second completion attempt fails closed: anonymous is 401 (the auth
  // hook no longer bypasses once configured) and an admin re-post reaches the
  // route, which 403s — setup is one-shot (same contract as setup.test.ts).
  const again = await fetch(`${base1}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility: { name: 'Again' } }),
  });
  assert.equal(again.status, 401, 'anonymous re-completion is unauthorized');
  const adminAgain = await fetch(`${base1}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSecret}` },
    body: JSON.stringify({ facility: { name: 'Again' } }),
  });
  assert.equal(adminAgain.status, 403, 'authenticated re-completion is forbidden');

  // The minted key authenticates like any admin key.
  const me = await fetch(`${base1}/api/v1/me`, { headers: { Authorization: `Bearer ${adminSecret}` } });
  assert.equal(me.status, 200, 'minted admin key authenticates');
  const adminRow = await hub1.keys?.get('admin');
  assert.ok(adminRow, 'admin key landed in the key store');

  // Deliver one ASTM session over the wire from the simulator.
  const { AnalyzerSimulator } = await import('@integration-hub/simulator');
  const sim = new AnalyzerSimulator({ host: '127.0.0.1', port: hub1.ports.device, count: 1, intervalMs: 0 });
  await sim.runOnce();

  // The pipeline ran end-to-end on SQLite: a message exists with a device row.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await hub1.store.stats()).total === 0) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const stats = await hub1.store.stats();
  assert.ok(stats.total >= 1, 'message recorded through the wire');
  const devices = await hub1.devices.list();
  assert.ok(devices.length >= 1, 'device auto-registered');
  assert.equal(hub1.devices.kind, 'sqlite');

  // ---------- Stop; Boot 2 on the SAME file ----------
  await hub1.stop();
  const hub2 = await startHub({
    sqlite: { file },
    httpPort: 0,
    devicePort: 0,
    seedDefaultAlerts: false,
  });
  t.after(() => hub2.stop().catch(() => undefined));

  const base2 = `http://127.0.0.1:${hub2.ports.http}`;

  // Setup state survived the restart: the hub is still configured (W2 exit 3).
  const status2 = (await fetch(`${base2}/api/v1/setup/status`).then((r) => r.json())) as {
    firstBoot: boolean;
    facility?: { name: string };
  };
  assert.equal(status2.firstBoot, false, 'configured state survived the restart');
  assert.equal(status2.facility?.name, 'St. Mary Lab', 'facility identity persisted');

  const stats2 = await hub2.store.stats();
  assert.equal(stats2.total, stats.total, 'messages survived the restart');
  const devices2 = await hub2.devices.list();
  assert.ok(devices2.some((d) => d.id === devices[0]!.id), 'device rows survived');

  // Migrations did not re-apply: the store is the same file, not a re-seed.
  const profile = await hub2.profileStore.get('astm-reference');
  assert.ok(profile, 'seeded profile persisted');
  await hub2.stop();
});
