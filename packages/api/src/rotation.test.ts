/**
 * API integration tests for key-rotation ergonomics: rename, disable without
 * delete, expiry dates, and the audit-friendly re-issue flow (POST
 * /api/v1/keys/:id/rotate warns when the outgoing secret was never seen).
 * All of it sits behind the admin-only keys:manage scope, and every mutation
 * lands in the audit log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from './server.js';
import { DeviceRegistry } from './devices.js';
import { MessageStore } from './store.js';
import { InMemoryAuditStore, InMemoryKeyStore, type ApiKeyRole } from './security.js';

const SECRETS = { admin: 'ihk_rot_admin_001', engineer: 'ihk_rot_engineer_001', operator: 'ihk_rot_operator_001', viewer: 'ihk_rot_viewer_001' };

function authed(secret: string) {
  return { Authorization: `Bearer ${secret}` };
}

function patch(secret: string, path: string, body: unknown) {
  return fetch(path, {
    method: 'PATCH',
    headers: { ...authed(secret), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function post(secret: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { ...authed(secret) };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return fetch(path, { method: 'POST', headers, ...(payload !== undefined ? { body: payload } : {}) });
}

async function startApi(t: any) {
  const keys = new InMemoryKeyStore();
  for (const [role, secret] of Object.entries(SECRETS)) {
    await keys.create({ id: `key-${role}`, name: `${role} key`, role: role as ApiKeyRole, secret });
  }
  const audit = new InMemoryAuditStore();
  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store: new MessageStore(),
    devices: new DeviceRegistry(),
    keys,
    audit,
  });
  const { port } = await api.start();
  t.after(() => api.stop());
  return { base: `http://127.0.0.1:${port}`, keys, audit };
}

interface KeyJson {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
  expiresAt?: string;
  lastUsedAt?: string;
  secretIssuedAt?: string;
}

async function createKey(base: string, body: Record<string, unknown>): Promise<{ key: KeyJson; secret: string }> {
  const res = await post(SECRETS.admin, `${base}/api/v1/keys`, body);
  assert.equal(res.status, 201);
  return (await res.json()) as { key: KeyJson; secret: string };
}

test('key lifecycle endpoints are admin-only (keys:manage)', async (t) => {
  const { base } = await startApi(t);
  for (const role of ['viewer', 'operator', 'engineer'] as const) {
    assert.equal((await patch(SECRETS[role], `${base}/api/v1/keys/key-operator`, { name: 'x' })).status, 403, `${role} must not rename keys`);
    assert.equal((await patch(SECRETS[role], `${base}/api/v1/keys/key-operator`, { enabled: false })).status, 403, `${role} must not disable keys`);
    assert.equal((await post(SECRETS[role], `${base}/api/v1/keys/key-operator/rotate`)).status, 403, `${role} must not rotate keys`);
  }
  // Admin can; unknown ids 404.
  assert.equal((await patch(SECRETS.admin, `${base}/api/v1/keys/ghost`, { name: 'x' })).status, 404);
  assert.equal((await post(SECRETS.admin, `${base}/api/v1/keys/ghost/rotate`)).status, 404);
});

test('rename and disable-without-delete, audited with actor + target', async (t) => {
  const { base, audit } = await startApi(t);

  const renamed = await patch(SECRETS.admin, `${base}/api/v1/keys/key-operator`, { name: 'Night bench operator' });
  assert.equal(renamed.status, 200);
  assert.equal(((await renamed.json()) as KeyJson).name, 'Night bench operator');
  // The renamed key's secret still authenticates (rename never touches it).
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: authed(SECRETS.operator) })).status, 200);

  // Disable without deleting: auth fails, the record survives for re-enable.
  const disabled = await patch(SECRETS.admin, `${base}/api/v1/keys/key-operator`, { enabled: false });
  assert.equal(disabled.status, 200);
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: authed(SECRETS.operator) })).status, 401);
  const listAfterDisable = (await (await fetch(`${base}/api/v1/keys`, { headers: authed(SECRETS.admin) })).json()) as KeyJson[];
  const operatorKey = listAfterDisable.find((k) => k.id === 'key-operator');
  assert.equal(operatorKey?.enabled, false); // still listed, not deleted
  assert.equal(operatorKey?.name, 'Night bench operator'); // rename survived

  // Re-enable restores the SAME secret (no rotation happened).
  const enabled = await patch(SECRETS.admin, `${base}/api/v1/keys/key-operator`, { enabled: true });
  assert.equal(enabled.status, 200);
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: authed(SECRETS.operator) })).status, 200);

  // Both mutations audited with the acting admin + the key as target.
  const entries = audit.list({ limit: 20 });
  const keyActions = entries.filter((e) => e.action === 'PATCH /api/v1/keys/:id');
  assert.ok(keyActions.length >= 2, 'renames/disables must be audited');
  assert.ok(keyActions.every((e) => e.actorKey === 'key-admin' && e.target === 'key-operator' && e.result === 'ok'));
});

test('an admin cannot disable the key in use (lockout guard), but can rename it', async (t) => {
  const { base } = await startApi(t);
  const selfDisable = await patch(SECRETS.admin, `${base}/api/v1/keys/key-admin`, { enabled: false });
  assert.equal(selfDisable.status, 400);
  assert.match(((await selfDisable.json()) as { error: string }).error, /in use/);
  // Renaming self is fine and reflects on /me.
  const renamed = await patch(SECRETS.admin, `${base}/api/v1/keys/key-admin`, { name: 'Primary admin' });
  assert.equal(renamed.status, 200);
  const me = (await (await fetch(`${base}/api/v1/me`, { headers: authed(SECRETS.admin) })).json()) as { name: string };
  assert.equal(me.name, 'Primary admin');
});

test('expiry: create accepts future expiry (surfaced on /me), past expiry rejected at the API', async (t) => {
  const { base } = await startApi(t);

  const future = new Date(Date.now() + 30 * 86400000).toISOString();
  const { key, secret } = await createKey(base, { name: 'temp LIS', role: 'engineer', expiresAt: future });
  assert.equal(key.expiresAt, future);
  const me = (await (await fetch(`${base}/api/v1/me`, { headers: authed(secret) })).json()) as { expiresAt?: string };
  assert.equal(me.expiresAt, future);

  // Past expiry dates are rejected (clear instead of back-dating).
  const past = new Date(Date.now() - 1000).toISOString();
  const pastCreate = await post(SECRETS.admin, `${base}/api/v1/keys`, { name: 'x', role: 'viewer', expiresAt: past });
  assert.equal(pastCreate.status, 400);
  const pastPatch = await patch(SECRETS.admin, `${base}/api/v1/keys/key-operator`, { expiresAt: past });
  assert.equal(pastPatch.status, 400);
  assert.match(((await pastPatch.json()) as { error: string }).error, /must be in the future/);

  // Clearing expiry works.
  const cleared = await patch(SECRETS.admin, `${base}/api/v1/keys/${key.id}`, { expiresAt: null });
  assert.equal(cleared.status, 200);
  assert.equal(((await cleared.json()) as KeyJson).expiresAt, undefined);
});

test('rotate: warns when the outgoing secret was never used; old secret dies, new one lives', async (t) => {
  const { base, audit } = await startApi(t);
  // Fresh key, never used → rotation must warn.
  const { key, secret } = await createKey(base, { name: 'unused integration', role: 'engineer' });

  const rotate = (await post(SECRETS.admin, `${base}/api/v1/keys/${key.id}/rotate`))!;
  assert.equal(rotate.status, 200);
  const rotatedBody = (await rotate.json()) as { key: KeyJson; secret: string; warning?: string };
  assert.match(rotatedBody.warning ?? '', /never used/, 'rotation of an unseen secret must warn');
  assert.notEqual(rotatedBody.secret, secret);

  // Old secret revoked; new secret authenticates.
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: authed(secret) })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: authed(rotatedBody.secret) })).status, 200);

  // Rotation audited; the secret itself never lands in the log.
  const rotateEntry = audit.list({ limit: 50 }).find((e) => e.action === 'POST /api/v1/keys/:id/rotate');
  assert.ok(rotateEntry, 'rotation must be audited');
  assert.equal(rotateEntry.actorKey, 'key-admin');
  assert.equal(rotateEntry.target, key.id);
  assert.ok(!JSON.stringify(audit.list({ limit: 50 })).includes(rotatedBody.secret));

  // Use the new secret once, then rotate again → the outgoing secret WAS seen,
  // so no warning this time.
  await fetch(`${base}/api/v1/me`, { headers: authed(rotatedBody.secret) });
  const rotate2 = (await post(SECRETS.admin, `${base}/api/v1/keys/${key.id}/rotate`))!;
  const secondBody = (await rotate2.json()) as { key: KeyJson; secret: string; warning?: string };
  assert.equal(secondBody.warning, undefined, 'a used secret rotates without the never-seen warning');
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: authed(rotatedBody.secret) })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: authed(secondBody.secret) })).status, 200);
});
