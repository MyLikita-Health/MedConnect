/**
 * API tests for the signed-update surface (M2 installer + remote update):
 * release identity on /health + /api/v1/version, the /api/v1/updates/*
 * endpoints, and their per-role scoping (check/apply/rollback are admin-only
 * via the updates:manage scope; status is readable by every role).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiServer } from './server.js';
import { DeviceRegistry } from './devices.js';
import { MessageStore } from './store.js';
import { InMemoryAuditStore, InMemoryKeyStore, type ApiKeyRole } from './security.js';
import { UpdateAgent, UpdateStateDir, generateUpdateKeyPair, signManifest, updateManifestSchema } from '@integration-hub/core';

const SECRETS = { admin: 'ihk_test_upd_admin', engineer: 'ihk_test_upd_eng', operator: 'ihk_test_upd_op', viewer: 'ihk_test_upd_view' };

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function authed(secret: string) {
  return { Authorization: `Bearer ${secret}` };
}

function post(secret: string, path: string) {
  return fetch(path, { method: 'POST', headers: authed(secret) });
}

async function seededKeys(): Promise<InMemoryKeyStore> {
  const keys = new InMemoryKeyStore();
  for (const [role, secret] of Object.entries(SECRETS)) {
    await keys.create({ id: `key-${role}`, name: `${role} key`, role: role as ApiKeyRole, secret });
  }
  return keys;
}

async function startApi(t: any, updates?: UpdateAgent) {
  const keys = await seededKeys();
  const audit = new InMemoryAuditStore();
  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store: new MessageStore(),
    devices: new DeviceRegistry(),
    keys,
    audit,
    updates,
  });
  const { port } = await api.start();
  t.after(() => api.stop());
  return { base: `http://127.0.0.1:${port}`, audit };
}

/** Agent + published signed 0.2.0 manifest in a temp dir. */
async function enabledAgentHarness(): Promise<{ agent: UpdateAgent; state: UpdateStateDir }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'api-updates-'));
  const sourceDir = await mkdtemp(join(tmpdir(), 'api-updates-src-'));
  dirs.push(stateDir, sourceDir);
  const { privateKeyPem, publicKeyPem } = generateUpdateKeyPair();
  const manifest = signManifest(
    updateManifestSchema.parse({
      schemaVersion: 1,
      release: { id: 'v0.2.0', version: '0.2.0', platform: 'any', minHubVersion: '0.1.0', payload: { env: { HUB_VERSION: '0.2.0' } } },
      artifact: { kind: 'payload' },
    }),
    privateKeyPem,
  );
  await mkdir(join(sourceDir, 'latest'));
  await writeFile(join(sourceDir, 'latest', 'manifest.json'), JSON.stringify(manifest));
  const agent = new UpdateAgent({ stateDir, source: join(sourceDir, 'latest'), publicKeyPem, currentVersion: '0.1.0' });
  return { agent, state: new UpdateStateDir(stateDir) };
}

test('health and /api/v1/version expose release identity; version needs auth', async (t) => {
  const { base } = await startApi(t);
  const health = (await (await fetch(`${base}/api/v1/health`)).json()) as { status: string; version: string };
  assert.equal(health.status, 'ok');
  assert.match(health.version, /^\d+\.\d+\.\d+/);

  assert.equal((await fetch(`${base}/api/v1/version`)).status, 401);
  const version = (await (await fetch(`${base}/api/v1/version`, { headers: authed(SECRETS.viewer) })).json()) as { version: string };
  assert.equal(version.version, health.version);
});

test('updates status is readable; check/apply/rollback are admin-only (updates:manage)', async (t) => {
  const { agent } = await enabledAgentHarness();
  const { base } = await startApi(t, agent);

  // No key → 401; viewer/operator/engineer can read status but not act.
  assert.equal((await fetch(`${base}/api/v1/updates/status`)).status, 401);
  const status = (await (await fetch(`${base}/api/v1/updates/status`, { headers: authed(SECRETS.viewer) })).json()) as { enabled: boolean };
  assert.equal(status.enabled, true);
  for (const role of ['viewer', 'operator', 'engineer'] as const) {
    assert.equal((await post(SECRETS[role], `${base}/api/v1/updates/apply`)).status, 403, `${role} must not apply updates`);
    assert.equal((await post(SECRETS[role], `${base}/api/v1/updates/rollback`)).status, 403, `${role} must not roll back`);
    assert.equal((await post(SECRETS[role], `${base}/api/v1/updates/check`)).status, 403, `${role} must not trigger checks`);
  }
});

test('admin check + apply stages the signed release and lands in the audit log', async (t) => {
  const { agent, state } = await enabledAgentHarness();
  const { base, audit } = await startApi(t, agent);

  const check = (await (await post(SECRETS.admin, `${base}/api/v1/updates/check`)).json()) as { available: boolean; manifest?: { release: { version: string } } };
  assert.equal(check.available, true);
  assert.equal(check.manifest?.release.version, '0.2.0');

  const apply = await post(SECRETS.admin, `${base}/api/v1/updates/apply`);
  assert.equal(apply.status, 202);
  const applied = (await apply.json()) as { staged: boolean; release?: { version: string } };
  assert.equal(applied.staged, true);
  assert.equal(applied.release?.version, '0.2.0');

  // desired.json staged with the acting key attributed.
  const desired = await state.readDesired();
  assert.equal(desired?.kind, 'update');
  assert.equal(desired?.release.version, '0.2.0');
  assert.equal(desired?.by, 'key-admin');

  // Mutating action audited with the actor.
  const entries = audit.list({ limit: 10 });
  const applyEntry = entries.find((e) => e.action === 'POST /api/v1/updates/apply');
  assert.ok(applyEntry, 'apply should be audited');
  assert.equal(applyEntry.result, 'ok');
  assert.equal(applyEntry.actorKey, 'key-admin');

  // Status shows the staged release.
  const status = (await (await fetch(`${base}/api/v1/updates/status`, { headers: authed(SECRETS.viewer) })).json()) as {
    desired?: { release: { version: string } };
  };
  assert.equal(status.desired?.release.version, '0.2.0');
});

test('agent disabled: status explains why; mutating endpoints 501', async (t) => {
  const { base } = await startApi(t); // no updates option at all
  const status = (await (await fetch(`${base}/api/v1/updates/status`, { headers: authed(SECRETS.viewer) })).json()) as {
    enabled: boolean;
    reason?: string;
  };
  assert.equal(status.enabled, false);
  assert.match(status.reason ?? '', /not configured/);
  assert.equal((await post(SECRETS.admin, `${base}/api/v1/updates/apply`)).status, 501);
  assert.equal((await post(SECRETS.admin, `${base}/api/v1/updates/rollback`)).status, 501);
});

test('admin rollback stages last-known-good and refuses when already there', async (t) => {
  const { agent, state } = await enabledAgentHarness();
  const { base } = await startApi(t, agent);
  // No last-good recorded yet → rollback refuses with a reason (409).
  const none = await post(SECRETS.admin, `${base}/api/v1/updates/rollback`);
  assert.equal(none.status, 409);
  assert.match(((await none.json()) as { error: string }).error, /no earlier release recorded/);

  // Supervisor recorded last-good 0.2.0 (hub reports 0.2.1 from code).
  await state.writeLastGood({ release: { id: 'v0.2.0', version: '0.2.0' }, appliedAt: new Date().toISOString(), healthy: true });
  const rollback = await post(SECRETS.admin, `${base}/api/v1/updates/rollback`);
  assert.equal(rollback.status, 202);
  const body = (await rollback.json()) as { staged: boolean; release?: { version: string } };
  assert.equal(body.staged, true);
  assert.equal(body.release?.version, '0.2.0');
});
