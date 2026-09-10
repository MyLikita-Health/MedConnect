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

/**
 * W3 §8.3 — first-boot settings APPLY + the imaging endpoint: a configured
 * local hub picks up the wizard's network host (loopback env → stored LAN
 * host) and the wizard's Orthanc REST URL (domains.imaging) on the next
 * boot; the status route echoes the effective listeners. The imaging wiring
 * is proven against a mock Orthanc (the same REST contract the W3 bundle
 * serves): /system, /worklists CRUD, /tools/find.
 */
test('W3: stored network + imaging settings apply on restart (mock Orthanc over REST)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-w3-e2e-'));
  const file = join(dir, 'hub.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const savedAdminKey = process.env.HUB_ADMIN_KEY;
  delete process.env.HUB_ADMIN_KEY;
  t.after(() => {
    if (savedAdminKey !== undefined) process.env.HUB_ADMIN_KEY = savedAdminKey;
  });

  // ---------- Boot 1: complete setup with the W3 fields ----------
  const hub1 = await startHub({
    sqlite: { file },
    httpPort: 0,
    devicePort: 0,
    seedDefaultAlerts: false,
  });
  t.after(() => hub1.stop().catch(() => undefined));
  const base1 = `http://127.0.0.1:${hub1.ports.http}`;

  const complete = await fetch(`${base1}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      facility: { name: 'Imaging Lab' },
      domains: { lab: true, imaging: true },
      network: { host: '0.0.0.0', devicePort: 5000, httpPort: 3000, tls: false },
      orthanc: { baseUrl: 'http://REPLACE-ME' }, // patched below (mock port unknown yet)
    }),
  });
  assert.equal(complete.status, 201);
  const { adminKey } = (await complete.json()) as { adminKey?: { secret: string } };
  assert.ok(adminKey?.secret);

  // ---------- Mock Orthanc (the W3 bundle's REST contract) ----------
  const { startMockOrthanc: mock } = await import('@integration-hub/dicom/mock');
  const worklistCreated: string[] = [];
  const { base: orthancBase } = await mock(t, (req, res, entry) => {
    if (req.method === 'GET' && entry.path === '/system') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Version: '1.12.6', Name: 'IntegrationHub-Orthanc' }));
    }
    if (req.method === 'GET' && entry.path === '/worklists') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(worklistCreated));
    if (req.method === 'POST' && entry.path === '/worklists') {
      const id = `wl-${worklistCreated.length + 1}`;
      worklistCreated.push(id);
      return res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(id));
    }
    if (req.method === 'GET' && entry.path.startsWith('/worklists/')) {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ID: entry.path.split('/')[2], Tags: {} }));
    }
    if (req.method === 'DELETE' && entry.path.startsWith('/worklists/')) return res.writeHead(200).end();
    if (req.method === 'POST' && entry.path === '/tools/find') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([]));
    res.writeHead(404).end();
  });

  // Record the real Orthanc base (settings are editable via the auth'd PATCH).
  const patched = await fetch(`${base1}/api/v1/setup/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey.secret}` },
    body: JSON.stringify({ orthanc: { baseUrl: orthancBase } }),
  });
  assert.equal(patched.status, 200, 'settings PATCH (config:write) accepts the orthanc endpoint');

  // The status surface echoes the stored config + the runtime listeners (W3).
  const status1 = (await fetch(`${base1}/api/v1/setup/status`, { headers: { Authorization: `Bearer ${adminKey.secret}` } }).then((r) => r.json())) as {
    firstBoot: boolean;
    network?: { host: string };
    orthanc?: { baseUrl: string };
    runtime?: { host: string; device?: number; http?: number };
  };
  assert.equal(status1.network?.host, '0.0.0.0', 'stored network settings echo back');
  assert.equal(status1.orthanc?.baseUrl, orthancBase, 'imaging endpoint echoes (never the password)');
  assert.equal(status1.runtime?.device, hub1.ports.device, 'runtime listener ports echo');

  await hub1.stop();

  // ---------- Boot 2: stored settings apply ----------
  // No HOST env (loopback default) → the stored 0.0.0.0 wins; no ORTHANC_URL
  // env → the stored imaging endpoint wins. The MWL monitor boots against it.
  const hub2 = await startHub({
    sqlite: { file },
    httpPort: 0,
    devicePort: 0,
    seedDefaultAlerts: false,
  });
  t.after(() => hub2.stop().catch(() => undefined));

  assert.ok(hub2.mwl, 'imaging wiring came up from the stored settings (domains.imaging + orthanc.baseUrl)');
  assert.equal(hub2.mwl.status().baseUrl, orthancBase);

  // The mock saw the real MWL poll chain (the imaging engine is reachable).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && hub2.mwl.status().lastRunAt === undefined) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(hub2.mwl.status().lastRunAt, 'the MWL monitor polled the configured Orthanc');

  // The Orthanc device row flipped connected through the health seam (C6).
  const deadline2 = Date.now() + 5000;
  let orthancRow: { state: string } | undefined;
  while (Date.now() < deadline2) {
    orthancRow = (await hub2.devices.get('orthanc')) as { state: string } | undefined;
    if (orthancRow?.state === 'connected') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(orthancRow?.state, 'connected', 'Orthanc surfaced as a connected device');

  // LAN reach: with no HOST env, the stored 0.0.0.0 became the bind host —
  // the console answer (via the setup status) reports it as the runtime host.
  const status2 = (await fetch(`http://127.0.0.1:${hub2.ports.http}/api/v1/setup/status`, { headers: { Authorization: `Bearer ${adminKey.secret}` } }).then((r) => r.json())) as {
    runtime?: { host: string };
  };
  assert.equal(status2.runtime?.host, '0.0.0.0', 'stored LAN host applied on restart');

  await hub2.stop();
});

test('W4 pairing → restart → the paired edge ships its outbox to the cloud (docs §8.4 exit proof b)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-pairing-e2e-'));
  const file = join(dir, 'hub.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Hermetic: no ambient admin key; a fast sync poll for the test window.
  const savedAdminKey = process.env.HUB_ADMIN_KEY;
  const savedSyncPoll = process.env.HUB_SYNC_POLL_MS;
  delete process.env.HUB_ADMIN_KEY;
  process.env.HUB_SYNC_POLL_MS = '50';
  t.after(() => {
    if (savedAdminKey !== undefined) process.env.HUB_ADMIN_KEY = savedAdminKey;
    else delete process.env.HUB_SYNC_POLL_MS;
    if (savedSyncPoll !== undefined) process.env.HUB_SYNC_POLL_MS = savedSyncPoll;
  });

  // ---------- The mock cloud: H3 claim + D11 ingest on one origin ----------
  const BUNDLE = {
    gateway: { id: 'gw-1', name: 'St. Mary edge', facilityId: 'fac-9', orgId: 'org-7' },
    cloud: { baseUrl: '', ingestPath: '/api/v1/sync/ingest' }, // stamped after bind
    apiKey: 'ihk_gw_secret_1234567890',
    tenancy: { orgId: 'org-7', facilityId: 'fac-9' },
    claimedAt: '2026-09-10T00:00:00.000Z',
  };
  interface Ingest { gateway?: string; authorization?: string; entries: Array<Record<string, unknown>> }
  const ingests: Ingest[] = [];
  let claims = 0;
  const { createServer } = await import('node:http');
  const cloudServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v1/provision/claim') {
      claims += 1;
      res.writeHead(201).end(JSON.stringify(BUNDLE));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/sync/ingest') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { entries?: Array<{ seq: number }> };
        const entries = body.entries ?? [];
        ingests.push({
          gateway: typeof req.headers['x-hub-gateway'] === 'string' ? req.headers['x-hub-gateway'] : undefined,
          authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
          entries: entries as Array<Record<string, unknown>>,
        });
        const through = entries.length > 0 ? Math.max(...entries.map((e) => Number(e.seq))) : 0;
        res.writeHead(200).end(JSON.stringify({ appliedThrough: through }));
      });
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => cloudServer.listen(0, '127.0.0.1', resolve));
  const cloudPort = (cloudServer.address() as { port: number }).port;
  BUNDLE.cloud.baseUrl = `http://127.0.0.1:${cloudPort}`;
  t.after(() => new Promise<void>((resolve) => cloudServer.close(() => resolve())));

  // ---------- Boot 1: complete setup, then pair via the API ----------
  const hub1 = await startHub({ sqlite: { file }, httpPort: 0, devicePort: 0, seedDefaultAlerts: false });
  t.after(() => hub1.stop().catch(() => undefined));
  const base1 = `http://127.0.0.1:${hub1.ports.http}`;

  const complete = await fetch(`${base1}/api/v1/setup/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility: { name: 'St. Mary Lab', orgSlug: 'st-mary' }, domains: { lab: true } }),
  });
  assert.equal(complete.status, 201, 'setup completion succeeds');
  const { adminKey } = (await complete.json()) as { adminKey?: { secret: string } };
  assert.ok(adminKey?.secret);

  assert.ok(!hub1.syncer, 'an unpaired edge runs no syncer');

  const claim = await fetch(`${base1}/api/v1/pairing/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cloudBaseUrl: BUNDLE.cloud.baseUrl, pairingCode: 'ihp_e2e-code-123' }),
  });
  assert.equal(claim.status, 201, 'the claim succeeds against the mock cloud');
  assert.equal(claims, 1);
  assert.ok(hub1.pairing, 'the pairing surface is mounted');
  const paired = (await fetch(`${base1}/api/v1/pairing/status`).then((r) => r.json())) as { paired: boolean; gatewayId: string };
  assert.equal(paired.paired, true);
  assert.equal(paired.gatewayId, 'gw-1');
  // The outbox attaches at boot — pairing at runtime takes effect on restart
  // (the service model: operators pair once, the service picks it up).
  assert.ok(!hub1.syncer, 'the runtime hub does not hot-attach the syncer; restart does');

  await hub1.stop();

  // ---------- Boot 2: the stored pairing drives the syncer ----------
  const hub2 = await startHub({ sqlite: { file }, httpPort: 0, devicePort: 0, seedDefaultAlerts: false });
  t.after(() => hub2.stop().catch(() => undefined));
  assert.ok(hub2.syncer, 'the paired edge boots a syncer from stored settings (no env)');

  // A write with tenancy stamps lands in the outbox (the device write-through).
  const reg = await fetch(`http://127.0.0.1:${hub2.ports.http}/api/v1/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey.secret}` },
    body: JSON.stringify({ id: 'analyzer-1', name: 'Sysmex XN', protocol: 'ASTM', transport: 'tcp' }),
  });
  assert.equal(reg.status, 201, 'device registration succeeds on the paired edge');

  // The syncer ships it: the mock ingest sees the batch with the H3 identity.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && ingests.length === 0) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(ingests.length >= 1, true, 'the syncer shipped at least one batch to the cloud');
  const batch = ingests[0]!;
  assert.equal(batch.gateway, 'gw-1', 'the gateway identity rides the header');
  assert.equal(batch.authorization, `Bearer ihk_gw_secret_1234567890`, 'the claimed gateway key authenticates the ingest');
  assert.equal(batch.entries.length >= 1, true);
  const deviceRow = batch.entries.find((e) => e['table'] === 'devices');
  assert.ok(deviceRow, 'the device write reached the outbox');
  assert.equal(deviceRow?.['facilityId'], 'fac-9', 'rows carry the paired facility stamp (H1/W4)');
  assert.equal(deviceRow?.['orgId'], 'org-7', 'rows carry the paired org stamp');

  // And the cloud acked it: the local outbox drains (no endless backlog).
  const deadline2 = Date.now() + 5000;
  let pending = -1;
  while (Date.now() < deadline2) {
    pending = (hub2.sqlite!.db.prepare('SELECT COUNT(*) AS c FROM outbox WHERE acked = 0').get() as { c: number }).c;
    if (pending === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(pending, 0, 'acked rows drain — the outbox is not an endless backlog');

  await hub2.stop();
});
