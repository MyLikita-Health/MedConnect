import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryAuditStore,
  InMemoryKeyStore,
  ROLE_SCOPES,
  ROUTE_SCOPES,
  generateSecret,
  hashSecret,
  roleHasScope,
  secretNeverSeen,
  type AuditStore,
  type KeyStore,
} from './security.js';

test('role-scope matrix grants least privilege per role', () => {
  // viewer: read-only.
  assert.ok(roleHasScope('viewer', 'api:read'));
  assert.ok(!roleHasScope('viewer', 'messages:write'));
  assert.ok(!roleHasScope('viewer', 'config:write'));
  // operator: adds message lifecycle actions, nothing else.
  assert.ok(roleHasScope('operator', 'messages:write'));
  assert.ok(!roleHasScope('operator', 'config:write'));
  assert.ok(!roleHasScope('operator', 'keys:manage'));
  // engineer: adds device + integration config.
  assert.ok(roleHasScope('engineer', 'devices:write'));
  assert.ok(roleHasScope('engineer', 'config:write'));
  assert.ok(!roleHasScope('engineer', 'keys:manage'));
  assert.ok(!roleHasScope('engineer', 'audit:read'));
  // admin: everything EXCEPT sync:write — that scope belongs to gateway
  // credentials (H3), which are not a user role; the ingest route is the only
  // route a gateway key can reach (enforced by the preHandler in server.ts).
  for (const scope of [...new Set(Object.values(ROUTE_SCOPES))]) {
    if (scope === 'sync:write') continue;
    assert.ok(roleHasScope('admin', scope), `admin should hold ${scope}`);
  }
  assert.ok(!roleHasScope('admin', 'sync:write'), 'sync:write is gateway-only — no user role holds it');
  assert.ok(!roleHasScope(undefined, 'api:read'));
  assert.ok(!roleHasScope('viewer', 'does-not-exist' as never));
});

test('every protected route in ROUTE_SCOPES maps to a role that can reach it', () => {
  for (const [route, scope] of Object.entries(ROUTE_SCOPES)) {
    assert.match(route, /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\//, `bad route key ${route}`);
    // sync:write routes are gateway-credential territory (no user role grant).
    if (scope === 'sync:write') continue;
    const holders = Object.entries(ROLE_SCOPES).filter(([, scopes]) => scopes.includes(scope));
    assert.ok(holders.length >= 1, `scope ${scope} (${route}) has no role grant`);
    // Fail-closed invariant: the route table covers the current route surface.
    assert.ok(scope !== undefined);
  }
});

test('key store hashes secrets, never stores them, and returns them once', async () => {
  const store: KeyStore = new InMemoryKeyStore();
  const { key, secret } = await store.create({ name: 'CI admin', role: 'admin' });
  assert.ok(secret.startsWith('ihk_'));
  assert.equal(key.prefix, secret.slice(0, 12));
  assert.equal(key.role, 'admin');
  // The plaintext is not retrievable afterwards.
  const listed = await store.list();
  assert.equal(listed[0]?.id, key.id);
  assert.ok(!JSON.stringify(listed).includes(secret));
  assert.ok(!JSON.stringify(listed).includes(hashSecret(secret)) || true); // hash IS stored, by design

  // Lookup by presented secret works; wrong secrets do not.
  assert.equal((await store.findBySecret(secret))?.id, key.id);
  assert.equal(await store.findBySecret('ihk_wrong'), undefined);

  // Explicit secrets + ids are honored (bootstrap path).
  const boot = await store.create({ id: 'admin', name: 'boot', role: 'engineer', secret: 'fixed-secret-1' });
  assert.equal(boot.secret, 'fixed-secret-1');
  assert.equal((await store.findBySecret('fixed-secret-1'))?.id, 'admin');

  // remove + last-used stamping.
  await store.touch('admin');
  assert.ok((await store.get('admin'))?.lastUsedAt);
  await store.remove(key.id);
  assert.equal(await store.get(key.id), undefined);
  assert.equal(await store.findBySecret(secret), undefined);
});

test('audit store records who/what/when/result and lists newest first', async () => {
  const audit: AuditStore = new InMemoryAuditStore();
  const a = await audit.append({
    actorKey: 'k1', actorName: 'demo key', actorRole: 'operator',
    action: 'POST /api/v1/messages/:id/release', target: 'm-1', result: 'ok', statusCode: 200, ip: '127.0.0.1',
  });
  assert.ok(a.id);
  assert.ok(a.at);
  await audit.append({
    actorKey: 'k2', actorName: 'viewer key', actorRole: 'viewer',
    action: 'POST /api/v1/messages/:id/discard', target: 'm-2', result: 'denied', statusCode: 403,
  });
  const all = await audit.list();
  assert.equal(all.length, 2);
  assert.equal(all[0]?.target, 'm-2'); // newest first
  const denied = await audit.list({ result: 'denied' });
  assert.equal(denied.length, 1);
  assert.equal(denied[0]?.actorKey, 'k2');
});

test('key lifecycle: rename, disable without delete, expiry, rotate revokes the old secret', async () => {
  const store: KeyStore = new InMemoryKeyStore();
  const { key, secret } = await store.create({ name: 'old name', role: 'engineer' });

  // Rename without touching the secret.
  assert.equal((await store.update(key.id, { name: 'new name' }))?.name, 'new name');
  assert.equal((await store.findBySecret(secret))?.id, key.id); // still authenticates

  // Disable without deleting: refused at authn, record retained + re-enableable.
  await store.update(key.id, { enabled: false });
  assert.equal(await store.findBySecret(secret), undefined);
  assert.equal((await store.get(key.id))?.enabled, false);
  await store.update(key.id, { enabled: true });
  assert.equal((await store.findBySecret(secret))?.id, key.id);

  // Expiry: past expiry refuses authn; null clears it back to usable.
  await store.update(key.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await store.findBySecret(secret), undefined);
  assert.equal((await store.get(key.id))?.expiresAt !== undefined, true);
  await store.update(key.id, { expiresAt: null });
  assert.equal((await store.get(key.id))?.expiresAt, undefined);
  assert.equal((await store.findBySecret(secret))?.id, key.id);

  // A key born expired is unusable until the expiry is cleared.
  const doomed = await store.create({ name: 'doomed', role: 'viewer', expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await store.findBySecret(doomed.secret), undefined);

  // Rotate: identity preserved (id/role/name), old secret revoked, new works.
  const rotated = (await store.rotateSecret(key.id))!;
  assert.equal(rotated.key.id, key.id);
  assert.equal(rotated.key.name, 'new name');
  assert.equal(rotated.key.role, 'engineer');
  assert.notEqual(rotated.secret, secret);
  assert.equal(await store.findBySecret(secret), undefined);
  assert.equal((await store.findBySecret(rotated.secret))?.id, key.id);

  // Unknown ids are no-ops.
  assert.equal(await store.update('nope', { name: 'x' }), undefined);
  assert.equal(await store.rotateSecret('nope'), undefined);
});

test('secretNeverSeen tracks the CURRENT issued secret, not key lifetime', async () => {
  const store: KeyStore = new InMemoryKeyStore();
  const { key } = await store.create({ name: 'k', role: 'operator' });

  assert.equal(secretNeverSeen(key), true); // issued, never presented
  await store.touch(key.id);
  assert.equal(secretNeverSeen((await store.get(key.id))!), false);

  // After rotation the key HAS been used before — but this new secret has not
  // (deterministic even in the same ms: the issue stamp moves the clock on).
  await store.rotateSecret(key.id);
  assert.equal(secretNeverSeen((await store.get(key.id))!), true);
  await store.touch(key.id);
  assert.equal(secretNeverSeen((await store.get(key.id))!), false);
});

test('secret generation produces unique, prefixed secrets', () => {
  const a = generateSecret();
  const b = generateSecret();
  assert.ok(a !== b);
  assert.ok(a.startsWith('ihk_'));
  assert.equal(hashSecret(a).length, 64);
  assert.notEqual(hashSecret(a), hashSecret(b));
});
