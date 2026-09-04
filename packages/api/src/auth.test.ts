/**
 * API security integration tests (M2 security review): auth gates /api/v1 by
 * API key, roles map to scopes per ROUTE_SCOPES, and every mutating action by
 * an identified key lands in the audit log (PRD §30, §34).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from './server.js';
import { DeviceRegistry } from './devices.js';
import { MessageStore } from './store.js';
import { InMemoryAuditStore, InMemoryKeyStore, type ApiKeyRole, type KeyStore } from './security.js';
import type { CanonicalMessage } from '@integration-hub/shared';

const SECRETS: { admin: string; engineer: string; operator: string; viewer: string } = {
  admin: 'ihk_test_admin_001',
  engineer: 'ihk_test_engineer_001',
  operator: 'ihk_test_operator_001',
  viewer: 'ihk_test_viewer_001',
};

function message(id: string, status: CanonicalMessage['status'] = 'ROUTED'): CanonicalMessage {
  return {
    id,
    protocol: 'ASTM',
    direction: 'device-to-host',
    deviceId: 'SIM-1',
    receivedAt: new Date().toISOString(),
    raw: 'H|\\^&||||SIM^1|||||||P|1|20260903143000',
    status,
    errors: [],
    timeline: [{ stage: 'RECEIVED', at: new Date().toISOString() }],
  };
}

async function startAuthApi(t: any) {
  const keys: KeyStore = new InMemoryKeyStore();
  const released: string[] = [];
  for (const [role, secret] of Object.entries(SECRETS)) {
    await keys.create({ id: `key-${role}`, name: `${role} test key`, role: role as ApiKeyRole, secret });
  }
  const store = new MessageStore();
  const devices = new DeviceRegistry();
  const audit = new InMemoryAuditStore();
  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store,
    devices,
    keys,
    audit,
    replayHandler: (m) => ({ ...m, id: `replay-${m.id}` }),
    releaseHandler: (id) => {
      released.push(id);
      return true;
    },
  });
  const { port } = await api.start();
  t.after(() => api.stop());
  return { base: `http://127.0.0.1:${port}`, store, released, audit };
}

function authed(secret: string) {
  return { Authorization: `Bearer ${secret}` };
}

/** POST with a JSON body (fetch otherwise defaults to text/plain). */
function post(secret: string, path: string, body: unknown) {
  return fetch(path, {
    method: 'POST',
    headers: { ...authed(secret), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('auth gates /api/v1 while health + console stay public', async (t) => {
  const { base, store } = await startAuthApi(t);
  store.record(message('m1'));

  // Public: health probe + console UI.
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
  assert.equal((await fetch(base)).status, 200);

  // Protected: no key → 401; garbage key → 401.
  const noKey = await fetch(`${base}/api/v1/stats`);
  assert.equal(noKey.status, 401);
  const badKey = await fetch(`${base}/api/v1/stats`, { headers: authed('ihk_nope') });
  assert.equal(badKey.status, 401);
  const body = (await noKey.json()) as { error: string };
  assert.equal(body.error, 'unauthorized');
});

test('viewer role reads everything but mutates nothing', async (t) => {
  const { base, store } = await startAuthApi(t);
  store.record(message('held-1', 'HELD'));

  const read = await fetch(`${base}/api/v1/messages`, { headers: authed(SECRETS.viewer) });
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as unknown[]).length, 1);

  const replay = await fetch(`${base}/api/v1/messages/held-1/replay`, { method: 'POST', headers: authed(SECRETS.viewer) });
  assert.equal(replay.status, 403);
  const denied = (await replay.json()) as { error: string; required: string };
  assert.equal(denied.required, 'messages:write');

  assert.equal((await fetch(`${base}/api/v1/keys`, { headers: authed(SECRETS.viewer) })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/audit`, { headers: authed(SECRETS.viewer) })).status, 403);
});

test('operator handles message lifecycle but cannot change config or keys', async (t) => {
  const { base, store, released } = await startAuthApi(t);
  store.record(message('held-1', 'HELD'));
  store.record(message('dead-1', 'FAILED'));

  const release = await fetch(`${base}/api/v1/messages/held-1/release`, { method: 'POST', headers: authed(SECRETS.operator) });
  assert.equal(release.status, 200);
  assert.deepEqual(released, ['held-1']);

  const discard = await fetch(`${base}/api/v1/messages/dead-1/discard`, { method: 'POST', headers: authed(SECRETS.operator) });
  assert.equal(discard.status, 200);

  // Config + key management stay out of reach.
  const order = await post(SECRETS.operator, `${base}/api/v1/orders`, { id: 'ACC-1', patientId: 'P-1' });
  assert.equal(order.status, 403);
  assert.equal((await post(SECRETS.operator, `${base}/api/v1/keys`, { name: 'x', role: 'viewer' })).status, 403);
});

test('engineer configures devices/routes/orders/profiles but not keys or audit', async (t) => {
  const { base } = await startAuthApi(t);

  const device = await post(SECRETS.engineer, `${base}/api/v1/devices`, { name: 'Chem Analyzer 1' });
  assert.equal(device.status, 201);

  const order = await post(SECRETS.engineer, `${base}/api/v1/orders`, { id: 'ACC-9', patientId: 'P-9', tests: ['GLUCOSE'] });
  assert.equal(order.status, 201);

  const rule = await post(SECRETS.engineer, `${base}/api/v1/alert-rules`, { id: 'r-1', kind: 'held-backlog', name: 'backlog', threshold: 1 });
  assert.equal(rule.status, 201);

  assert.equal((await fetch(`${base}/api/v1/keys`, { headers: authed(SECRETS.engineer) })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/audit`, { headers: authed(SECRETS.engineer) })).status, 403);
});

test('admin manages keys (secret returned once) and reads the audit log', async (t) => {
  const { base, store, audit } = await startAuthApi(t);
  store.record(message('held-1', 'HELD'));

  // A denied attempt + a successful release, both attributable.
  await fetch(`${base}/api/v1/messages/held-1/discard`, { method: 'POST', headers: authed(SECRETS.viewer) });
  await fetch(`${base}/api/v1/messages/held-1/release`, { method: 'POST', headers: authed(SECRETS.operator) });

  // Create a key: the plaintext secret appears in the response exactly once.
  const created = await post(SECRETS.admin, `${base}/api/v1/keys`, { name: 'new tech', role: 'engineer' });
  assert.equal(created.status, 201);
  const { key, secret } = (await created.json()) as { key: { id: string; role: string }; secret: string };
  assert.ok(secret.startsWith('ihk_'));
  assert.equal(key.role, 'engineer');

  // The new secret authenticates with the granted role.
  const me = (await (await fetch(`${base}/api/v1/me`, { headers: authed(secret) })).json()) as { role: string; name: string };
  assert.equal(me.role, 'engineer');
  assert.equal(me.name, 'new tech');

  // Listing keys never exposes secrets.
  const listBody = JSON.stringify(await (await fetch(`${base}/api/v1/keys`, { headers: authed(SECRETS.admin) })).json());
  assert.ok(!listBody.includes(secret));

  // The audit log has both entries, newest first, with actor/role/result.
  const entries = (await (await fetch(`${base}/api/v1/audit?limit=20`, { headers: authed(SECRETS.admin) })).json()) as Array<{
    action: string;
    target?: string;
    result: string;
    actorRole?: string;
    statusCode?: number;
  }>;
  assert.ok(entries.length >= 2, `expected >=2 audit entries, got ${entries.length}`);
  const deniedEntry = entries.find((e) => e.action.includes('discard'));
  assert.equal(deniedEntry?.result, 'denied');
  assert.equal(deniedEntry?.actorRole, 'viewer');
  assert.equal(deniedEntry?.target, 'held-1');
  assert.equal(deniedEntry?.statusCode, 403);
  const okEntry = entries.find((e) => e.action.includes('release') && e.result === 'ok');
  assert.equal(okEntry?.actorRole, 'operator');
  assert.equal(okEntry?.target, 'held-1');

  // Audit store saw the same writes (in-memory shared instance).
  const stored = await audit.list({ limit: 50 });
  assert.ok(stored.some((e) => e.action.endsWith('discard') && e.result === 'denied'));

  // Admins cannot delete the key they are using (lockout guard).
  const selfDelete = await fetch(`${base}/api/v1/keys/key-admin`, { method: 'DELETE', headers: authed(SECRETS.admin) });
  assert.equal(selfDelete.status, 400);

  // Deleting another key revokes it.
  const del = await fetch(`${base}/api/v1/keys/key-engineer`, { method: 'DELETE', headers: authed(SECRETS.admin) });
  assert.equal(del.status, 204);
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: authed(SECRETS.engineer) })).status, 401);
});

test('mutating actions that fail are still audited with their result', async (t) => {
  const { base } = await startAuthApi(t);
  // Release of a message that does not exist → 404, still audited as error.
  const res = await fetch(`${base}/api/v1/messages/ghost/release`, { method: 'POST', headers: authed(SECRETS.operator) });
  assert.equal(res.status, 404);
  const entries = (await (await fetch(`${base}/api/v1/audit`, { headers: authed(SECRETS.admin) })).json()) as Array<{
    result: string;
    action: string;
    statusCode?: number;
  }>;
  const errorEntry = entries.find((e) => e.action.includes('release'));
  assert.equal(errorEntry?.result, 'error');
  assert.equal(errorEntry?.statusCode, 404);
});

test('unknown API paths keep returning 404, not a scope error', async (t) => {
  const { base } = await startAuthApi(t);
  const res = await fetch(`${base}/api/v1/not-a-route`, { headers: authed(SECRETS.admin) });
  assert.equal(res.status, 404);
});
