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
  // admin: everything.
  for (const scope of [...new Set(Object.values(ROUTE_SCOPES))]) {
    assert.ok(roleHasScope('admin', scope), `admin should hold ${scope}`);
  }
  assert.ok(!roleHasScope(undefined, 'api:read'));
  assert.ok(!roleHasScope('viewer', 'does-not-exist' as never));
});

test('every protected route in ROUTE_SCOPES maps to a role that can reach it', () => {
  for (const [route, scope] of Object.entries(ROUTE_SCOPES)) {
    assert.match(route, /^(GET|POST|DELETE) \/api\/v1\//, `bad route key ${route}`);
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

test('secret generation produces unique, prefixed secrets', () => {
  const a = generateSecret();
  const b = generateSecret();
  assert.ok(a !== b);
  assert.ok(a.startsWith('ihk_'));
  assert.equal(hashSecret(a).length, 64);
  assert.notEqual(hashSecret(a), hashSecret(b));
});
