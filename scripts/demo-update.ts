/**
 * M2 installer + remote update demo (plan G3): runs the REAL hub as a child
 * of the supervisor, publishes a signed 0.2.0 release, and drives the whole
 * loop through the authenticated API:
 *
 *   check (verified signature) → apply (staged) → supervisor swaps + health-
 *   gates → hub reports v0.2.0 → rollback → hub reports v0.1.0 again.
 *
 * Requires Node only (in-memory hub; no Postgres). Run: npm run demo:update
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { HubSupervisor, generateUpdateKeyPair, signManifest, updateManifestSchema } from '@integration-hub/core';

const CLI_PATH = fileURLToPath(new URL('../packages/server/src/cli.ts', import.meta.url));
const ADMIN_KEY = 'ihk_demo_update_001';
const HTTP_PORT = 3310;
const DEVICE_PORT = 5310;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => console.log(`[demo] ${s}`);

async function waitHealth(expectedVersion: string, what: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/health`);
      if (res.ok) {
        const body = (await res.json()) as { status: string; version: string };
        if (body.status === 'ok' && body.version === expectedVersion) return;
      }
    } catch {
      /* hub still booting */
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for hub health to report ${what} (${expectedVersion})`);
}

async function api(method: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'hub-update-demo-'));
  const sourceDir = await mkdtemp(join(tmpdir(), 'hub-update-src-'));
  const { privateKeyPem, publicKeyPem } = generateUpdateKeyPair();
  await mkdir(join(sourceDir, 'updates'));
  line('generated fresh Ed25519 update keypair (demo)');

  // Publish a signed 0.2.0 release the hub's update agent can verify.
  const manifest = signManifest(
    updateManifestSchema.parse({
      schemaVersion: 1,
      release: {
        id: 'v0.2.0',
        version: '0.2.0',
        platform: 'any',
        minHubVersion: '0.1.0',
        changelog: 'demo release 0.2.0',
        payload: { env: { HUB_VERSION: '0.2.0' } },
      },
      artifact: { kind: 'payload' },
    }),
    privateKeyPem,
    'demo-update-key',
  );
  await writeFile(join(sourceDir, 'updates', 'manifest.json'), JSON.stringify(manifest, null, 2));
  line('published + signed release manifest v0.2.0 → updates/manifest.json');

  // The hub process runs under the supervisor; it sees the state dir, the
  // update source and the public key via env (the update agent is enabled).
  const supervisor = new HubSupervisor({
    stateDir,
    command: [process.execPath, '--import', 'tsx', CLI_PATH],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(HTTP_PORT),
      DEVICE_PORT: String(DEVICE_PORT),
      HUB_STATE_DIR: stateDir,
      UPDATE_SOURCE: join(sourceDir, 'updates'),
      UPDATE_PUBLIC_KEY: publicKeyPem,
      HUB_ADMIN_KEY: ADMIN_KEY,
    },
    healthUrl: `${BASE}/api/v1/health`,
    bootTimeoutMs: 40_000,
    log: (l) => console.log(`       ${l}`),
  });

  try {
    await supervisor.start();
    await waitHealth('0.1.0', 'v0.1.0 up under the supervisor');
    line('hub v0.1.0 is running under the supervisor');

    // 1. Check: signature verified, update available.
    const check = await api('POST', '/api/v1/updates/check');
    line(`POST /updates/check → ${check.status}: available=${check.body?.available} (${check.body?.manifest?.release?.version ?? check.body?.reason})`);
    if (!check.body?.available) throw new Error('check failed — cannot continue');

    // 2. Apply: the agent stages the verified release; the supervisor swaps.
    const apply = await api('POST', '/api/v1/updates/apply');
    line(`POST /updates/apply → ${apply.status}: staged=${apply.body?.staged} (v${apply.body?.release?.version})`);
    await waitHealth('0.2.0', 'the applied v0.2.0', 60_000);
    line('supervisor health-gate passed — hub now reports v0.2.0');
    const status = (await api('GET', '/api/v1/updates/status')).body;
    line(`updates/status: current=v${status?.current?.release?.version} healthy=${status?.current?.healthy} lastGood=v${status?.lastGood?.release?.version} supervisorAlive=${status?.supervisor?.alive}`);
    line(`  history: ${(status?.history ?? []).map((h: any) => `${h.event}:v${h.version}`).join(' → ')}`);

    // 3. Rollback: undo the successful update back to the replaced release.
    const rb = await api('POST', '/api/v1/updates/rollback');
    line(`POST /updates/rollback → ${rb.status}: staged=${rb.body?.staged} (v${rb.body?.release?.version})`);
    await waitHealth('0.1.0', 'rolled-back v0.1.0', 60_000);
    line('rollback applied — hub reports v0.1.0 again');
    const after = (await api('GET', '/api/v1/updates/status')).body;
    line(`  history: ${(after?.history ?? []).map((h: any) => `${h.event}:v${h.version}`).join(' → ')}`);
    line('demo complete: signed check → supervised apply → verified swap → rollback ✓');
  } finally {
    await supervisor.stop().catch(() => undefined);
    await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`[demo] failed: ${(err as Error).message}`);
  process.exit(1);
});
