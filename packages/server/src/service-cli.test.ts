/**
 * W2 — service entry test (docs/windows-desktop-installer.md §8.2 exit
 * proof 2): the local service launcher boots the hub with local-mode defaults
 * — SQLite under the data dir, signed-update state + logs under the data dir,
 * first-boot setup on — and stops cleanly on SIGTERM-style stop().
 *
 * The launcher is exercised via its module constants being trivially
 * reproducible here; the real supervision semantics (crash restart, health
 * gate, rollback) are HubSupervisor's and already covered in
 * core/updates/supervisor.test.ts — this test pins the LOCAL wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVICE_ENTRY = fileURLToPath(new URL('./service-cli.ts', import.meta.url));

test('service entry boots the hub locally: SQLite + state + logs under the data dir, setup on', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-service-'));
  const port = 18300 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ['--import', 'tsx', SERVICE_ENTRY], {
    env: { ...process.env, HUB_DATA_DIR: dataDir, PORT: String(port), DEVICE_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr.on('data', (c: Buffer) => (output += c.toString()));

  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline && !healthy) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      healthy = res.ok;
    } catch {
      // not up yet
    }
  }
  assert.ok(healthy, 'service-reachable hub answered /api/v1/health');

  // Local defaults: SQLite under the data dir, setup surface live.
  assert.ok(existsSync(join(dataDir, 'hub.sqlite')), 'SQLite store under the data dir');
  assert.ok(existsSync(join(dataDir, 'state')), 'signed-update state dir under the data dir');
  assert.ok(existsSync(join(dataDir, 'logs', 'hub.log')), 'service log file exists');
  const status = (await fetch(`http://127.0.0.1:${port}/api/v1/setup/status`).then((r) => r.json())) as {
    firstBoot: boolean;
  };
  assert.equal(status.firstBoot, true, 'first-boot setup surface is on');
  const log = readFileSync(join(dataDir, 'logs', 'hub.log'), 'utf8');
  assert.ok(log.includes('[service]'), 'service logged to the file');

  // Clean stop (SIGTERM → supervisor drains → exit 0).
  child.kill('SIGTERM');
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  assert.equal(code, 0, 'clean service shutdown');
  rmSync(dataDir, { recursive: true, force: true });
});
