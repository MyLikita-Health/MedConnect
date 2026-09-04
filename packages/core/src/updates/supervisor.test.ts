/**
 * HubSupervisor integration tests. Instead of booting the real hub, these
 * spawn a tiny node -e "hub" that answers /health with its HUB_VERSION and
 * exits(1) at boot when HUB_CRASH=1 (simulating a release that fails its
 * health gate — the auto-rollback path).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { HubSupervisor } from './supervisor.js';
import { UpdateStateDir, type ReleaseSpec } from './state.js';

const dirs: string[] = [];
const supervisors: HubSupervisor[] = [];
after(async () => {
  await Promise.all(supervisors.map((s) => s.stop().catch(() => undefined)));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const CHILD_SCRIPT = `
const http = require('http');
if (process.env.HUB_CRASH === '1') {
  console.error('[fake-hub] crash requested at boot');
  process.exit(1);
}
const port = Number(process.env.CHILD_PORT);
const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', version: process.env.HUB_VERSION }));
});
server.listen(port, '127.0.0.1', () => console.log('[fake-hub] up', process.env.HUB_VERSION));
process.on('SIGTERM', () => process.exit(0));
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function release(version: string, extraEnv: Record<string, string> = {}): ReleaseSpec {
  return { id: `v${version}`, version, payload: { env: { HUB_VERSION: version, ...extraEnv } } };
}

interface Harness {
  sup: HubSupervisor;
  state: UpdateStateDir;
  port: number;
  logs: string[];
}

async function makeSupervisor(): Promise<Harness> {
  const stateDir = await mkdtemp(join(tmpdir(), 'hub-sup-'));
  dirs.push(stateDir);
  const port = await freePort();
  const logs: string[] = [];
  const sup = new HubSupervisor({
    stateDir,
    command: [process.execPath, '-e', CHILD_SCRIPT],
    env: { ...process.env, CHILD_PORT: String(port) },
    healthUrl: `http://127.0.0.1:${port}/api/v1/health`,
    defaultVersion: '0.1.0',
    pollMs: 60,
    bootTimeoutMs: 6_000,
    healthTimeoutMs: 1_000,
    maxRestarts: 3,
    log: (line) => logs.push(line),
  });
  supervisors.push(sup);
  return { sup, state: new UpdateStateDir(stateDir), port, logs };
}

async function waitFor(pred: () => Promise<boolean> | boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function healthVersion(port: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    if (!res.ok) return undefined;
    return ((await res.json()) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

async function bootHealthy(h: Harness): Promise<void> {
  await h.sup.start();
  await waitFor(async () => (await h.state.readCurrent())?.healthy === true, 'boot healthy');
}

test('supervisor boots the default release, heartbeats and stops cleanly', async () => {
  const h = await makeSupervisor();
  await bootHealthy(h);
  const current = await h.state.readCurrent();
  assert.equal(current?.release.version, '0.1.0');
  const sup = await h.state.readSupervisor();
  assert.ok(sup?.pid === process.pid && Date.now() - Date.parse(sup.lastSeenAt) < 3_000, 'supervisor heartbeats');
  await h.sup.stop();
  assert.ok(h.logs.some((l) => l.includes('hub 0.1.0 is up')));
});

test('supervisor applies a staged release: swap + health gate + history', async () => {
  const h = await makeSupervisor();
  await bootHealthy(h);

  // The in-hub agent stages 0.2.0 (this is exactly what agent.apply() writes).
  await h.state.writeDesired({ kind: 'update', release: release('0.2.0'), stagedAt: new Date().toISOString(), by: 'key-admin' });

  await waitFor(
    async () => (await h.state.readCurrent())?.release.version === '0.2.0' && (await h.state.readCurrent())?.healthy === true,
    '0.2.0 applied + healthy',
  );
  // The running child really serves the new version.
  await waitFor(async () => (await healthVersion(h.port)) === '0.2.0', 'child serves 0.2.0');
  assert.equal((await h.state.readLastGood())?.release.version, '0.2.0');
  assert.equal(await h.state.readDesired(), undefined);
  const history = await h.state.readHistory();
  assert.equal(history[0]?.event, 'applied');
  assert.equal(history[0]?.version, '0.2.0');
  await h.sup.stop();
});

test('supervisor auto-rolls-back when an applied release fails the health gate', async () => {
  const h = await makeSupervisor();
  await bootHealthy(h);
  assert.equal((await h.state.readCurrent())?.release.version, '0.1.0');

  // Stage a release whose boot crashes (HUB_CRASH=1) — the hub must not stay down.
  await h.state.writeDesired({ kind: 'update', release: release('9.9.9', { HUB_CRASH: '1' }), stagedAt: new Date().toISOString() });

  // Wait for the whole transition: rolled back to 0.1.0, desired consumed,
  // and the gate failure + rollback recorded in history.
  await waitFor(
    async () => {
      const current = await h.state.readCurrent();
      const desired = await h.state.readDesired();
      const events = (await h.state.readHistory()).map((x) => x.event);
      return (
        current?.release.version === '0.1.0' &&
        current.healthy === true &&
        desired === undefined &&
        events.includes('failed') &&
        events.includes('rolled_back')
      );
    },
    'auto-rollback to 0.1.0 (history + desired consumed)',
  );
  const history = await h.state.readHistory();
  assert.match(history[0]?.reason ?? '', /auto-rollback after failed health gate/);
  await waitFor(async () => (await healthVersion(h.port)) === '0.1.0', 'child healthy again after rollback');
  await h.sup.stop();
});

test('supervisor restarts the hub when the child crashes', async () => {
  const h = await makeSupervisor();
  await bootHealthy(h);
  const firstPid = h.sup.childProcess?.pid;
  assert.ok(firstPid && firstPid > 1);

  // Kill the child out from under the supervisor (simulated power loss / OOM).
  process.kill(firstPid, 'SIGKILL');

  await waitFor(
    async () => h.sup.childProcess !== undefined && h.sup.childProcess!.pid !== firstPid && (await healthVersion(h.port)) === '0.1.0',
    'restart after crash',
  );
  assert.ok(h.logs.some((l) => l.includes('exited unexpectedly')), `logs: ${h.logs.join('\n')}`);
  await h.sup.stop();
});

test('a release that crash-loops at runtime escalates to the previously-good release', async () => {
  const h = await makeSupervisor();
  await bootHealthy(h);
  assert.equal((await h.state.readLastGood())?.release.version, '0.1.0');

  // Apply a *healthy* 9.9.9 first (it passes the gate), then crash it at
  // runtime repeatedly — the supervisor must give up on it and fall back.
  await h.state.writeDesired({ kind: 'update', release: release('9.9.9'), stagedAt: new Date().toISOString() });
  await waitFor(
    async () => (await h.state.readCurrent())?.release.version === '9.9.9' && (await h.state.readCurrent())?.healthy === true,
    '9.9.9 applied and healthy',
  );

  // Kill it maxRestarts (3) times: the first two get plain restarts…
  for (let i = 0; i < 2; i++) {
    const pid = h.sup.childProcess?.pid;
    assert.ok(pid && pid > 1, 'child running before kill');
    process.kill(pid, 'SIGKILL');
    await waitFor(
      async () => h.sup.childProcess !== undefined && h.sup.childProcess!.pid !== pid && (await healthVersion(h.port)) === '9.9.9',
      `restart ${i + 1} after kill`,
    );
  }

  // …the third crash exceeds maxRestarts → escalation rolls back to 0.1.0.
  const pid3 = h.sup.childProcess?.pid;
  assert.ok(pid3 && pid3 > 1, 'child running before third kill');
  process.kill(pid3, 'SIGKILL');
  await waitFor(
    async () => {
      const events = (await h.state.readHistory()).map((x) => x.event);
      return (await h.state.readCurrent())?.release.version === '0.1.0' && events.includes('rolled_back');
    },
    'escalated back to the previously-good release',
    20_000,
  );
  const history = await h.state.readHistory();
  assert.match(history[0]?.reason ?? '', /auto-rollback after crash loop/);
  await waitFor(async () => (await healthVersion(h.port)) === '0.1.0', 'healthy on the rollback release');
  await h.sup.stop();
});
