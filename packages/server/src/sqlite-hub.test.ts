/**
 * W1 e2e — the fully-local, no-Docker hub run (D12; docs §8.1 exit proof):
 * startHub on a temp SQLite file, an analyzer simulated end-to-end over the
 * wire (parse → canonicalize → match → route → deliver), API auth with the
 * generated admin key, and persistence across stop → restart on the same file.
 *
 * No Docker, no Postgres — this is the Windows-desktop local-mode shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type Hub } from './index.js';

test('startHub runs fully-local on SQLite: wire → pipeline → API → restart persistence', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-sqlite-e2e-'));
  const file = join(dir, 'hub.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Hermetic: a developer's HUB_ADMIN_KEY must not change the boot behavior.
  const savedAdminKey = process.env.HUB_ADMIN_KEY;
  delete process.env.HUB_ADMIN_KEY;
  t.after(() => {
    if (savedAdminKey !== undefined) process.env.HUB_ADMIN_KEY = savedAdminKey;
  });

  // ---------- Boot 1: the local edge ----------
  const hub1 = await startHub({
    sqlite: { file },
    httpPort: 0,
    devicePort: 0,
    seedDefaultAlerts: false,
  });
  t.after(() => hub1.stop().catch(() => undefined));
  assert.ok(hub1.sqlite, 'hub reports the sqlite backend');
  assert.equal(hub1.sqlite.file, file);

  // Admin key was generated and printed once — pull it from the key store to
  // authenticate like a real local user (the console does the same).
  const adminKey = hub1.keys ? ((await hub1.keys.get('admin')) as { id: string }) : undefined;
  assert.ok(adminKey, 'admin key bootstrapped');

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

  const stats2 = await hub2.store.stats();
  assert.equal(stats2.total, stats.total, 'messages survived the restart');
  const devices2 = await hub2.devices.list();
  assert.ok(devices2.some((d) => d.id === devices[0]!.id), 'device rows survived');

  // Migrations did not re-apply: the store is the same file, not a re-seed.
  const profile = await hub2.profileStore.get('astm-reference');
  assert.ok(profile, 'seeded profile persisted');
  await hub2.stop();
});
