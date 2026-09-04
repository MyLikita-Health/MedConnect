/**
 * PostgreSQL security-store integration tests (migration 0007). Skipped unless
 * TEST_DATABASE_URL (or DATABASE_URL) is set — run with `npm run test:db`
 * after `npm run db:up`. Same hub_test isolation as the sibling pg tests.
 */
import { after, before, test } from 'node:test';
import { skip as skipTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { closeDbPool, createDbPool } from './pool.js';
import { runMigrations } from './migrate.js';
import { PostgresAuditStore, PostgresKeyStore } from './pg-security.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipReason = DB_URL ? false : 'TEST_DATABASE_URL/DATABASE_URL not set (npm run db:up && npm run test:db)';

let pool: Pool | undefined;
let keys: PostgresKeyStore | undefined;
let audit: PostgresAuditStore | undefined;

before(async () => {
  if (!DB_URL) return;
  const admin = createDbPool(DB_URL);
  try {
    await admin.query('DROP DATABASE IF EXISTS hub_test WITH (FORCE)');
    await admin.query('CREATE DATABASE hub_test');
  } finally {
    await closeDbPool(admin);
  }
  const testUrl = new URL(DB_URL);
  testUrl.pathname = '/hub_test';
  pool = createDbPool(testUrl.toString());
  keys = new PostgresKeyStore(pool);
  audit = new PostgresAuditStore(pool);
  await runMigrations(pool);
});

after(async () => {
  if (pool) await closeDbPool(pool);
});

test('Postgres key store hashes secrets, authenticates by secret, lists safely', { skip: skipReason }, async () => {
  if (!pool || !keys) return skipTest('no pool');
  // Clean slate for this test.
  await pool.query('DELETE FROM api_keys');

  const { key, secret } = await keys.create({ name: 'pg admin', role: 'admin' });
  assert.ok(secret.startsWith('ihk_'));
  assert.equal(key.role, 'admin');

  // Only the hash + prefix are stored; the plaintext secret is not.
  const { rows } = await pool.query<{ key_hash: string; prefix: string }>('SELECT key_hash, prefix FROM api_keys');
  assert.equal(rows[0]?.prefix, secret.slice(0, 12));
  assert.notEqual(rows[0]?.key_hash, secret);
  assert.ok(!JSON.stringify(await keys.list()).includes(secret));

  assert.equal((await keys.findBySecret(secret))?.id, key.id);
  assert.equal(await keys.findBySecret('ihk_wrong_secret'), undefined);

  // Bootstrap path: explicit id + secret (HUB_ADMIN_KEY), idempotent re-create.
  const boot = await keys.create({ id: 'admin', name: 'boot', role: 'admin', secret: 'fixed-boot-secret' });
  assert.equal(boot.secret, 'fixed-boot-secret');
  assert.equal((await keys.findBySecret('fixed-boot-secret'))?.id, 'admin');

  // last-used stamping + delete revokes.
  await keys.touch(key.id);
  assert.ok((await keys.get(key.id))?.lastUsedAt);
  await keys.remove(key.id);
  assert.equal(await keys.findBySecret(secret), undefined);

  await pool.query(`DELETE FROM api_keys WHERE id = 'admin'`);
});

test('Postgres key lifecycle: rename, disable, expiry, rotate with never-seen tracking', { skip: skipReason }, async () => {
  if (!pool || !keys) return skipTest('no pool');
  await pool.query('DELETE FROM api_keys');

  const { key, secret } = await keys.create({ name: 'pg lifecycle', role: 'engineer' });

  // Rename + disable + re-enable keep the secret working semantics.
  assert.equal((await keys.update(key.id, { name: 'pg lifecycle v2' }))?.name, 'pg lifecycle v2');
  await keys.update(key.id, { enabled: false });
  assert.equal(await keys.findBySecret(secret), undefined);
  assert.equal((await keys.get(key.id))?.enabled, false);
  await keys.update(key.id, { enabled: true });
  assert.equal((await keys.findBySecret(secret))?.id, key.id);

  // Expiry stored + enforced; null clears it.
  await keys.update(key.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await keys.findBySecret(secret), undefined);
  const expired = (await keys.get(key.id))!;
  assert.ok(expired.expiresAt, 'expiry column round-trips');
  await keys.update(key.id, { expiresAt: null });
  assert.equal((await keys.get(key.id))?.expiresAt, undefined);
  assert.equal((await keys.findBySecret(secret))?.id, key.id);

  // A key born expired is unusable.
  const doomed = await keys.create({ name: 'doomed', role: 'viewer', expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await keys.findBySecret(doomed.secret), undefined);

  // Rotate: identity preserved, old secret revoked, new secret authenticates.
  const rotated = (await keys.rotateSecret(key.id))!;
  assert.equal(rotated.key.id, key.id);
  assert.equal(rotated.key.role, 'engineer');
  assert.notEqual(rotated.secret, secret);
  assert.equal(await keys.findBySecret(secret), undefined);
  assert.equal((await keys.findBySecret(rotated.secret))?.id, key.id);
  assert.equal(await keys.rotateSecret('nope'), undefined);

  await pool.query('DELETE FROM api_keys');
});

test('Postgres audit store round-trips entries and filters by result', { skip: skipReason }, async () => {
  if (!pool || !audit) return skipTest('no pool');
  await pool.query('DELETE FROM audit_log');

  const okEntry = await audit.append({
    actorKey: 'key-op', actorName: 'operator key', actorRole: 'operator',
    action: 'POST /api/v1/messages/:id/release', target: 'm-1', result: 'ok', statusCode: 200, ip: '127.0.0.1',
  });
  assert.ok(okEntry.id);
  assert.ok(okEntry.at);
  await audit.append({
    actorKey: 'key-view', actorName: 'viewer key', actorRole: 'viewer',
    action: 'POST /api/v1/messages/:id/discard', target: 'm-2', result: 'denied', statusCode: 403,
  });
  await audit.append({
    action: 'POST /api/v1/routes', target: 'r-1', result: 'error', statusCode: 400,
    detail: { body: { id: 'r-1' } },
  });

  const all = await audit.list({ limit: 10 });
  assert.equal(all.length, 3);
  assert.equal(all[0]?.action, 'POST /api/v1/routes'); // newest first
  assert.deepEqual((await audit.list({ result: 'denied' })).map((e) => e.target), ['m-2']);
  assert.equal((await audit.list({ result: 'ok' }))[0]?.actorRole, 'operator');
  const errorEntry = (await audit.list({ result: 'error' }))[0];
  assert.equal((errorEntry?.detail?.body as { id?: string } | undefined)?.id, 'r-1');

  // The row round-trips through a fresh read as well.
  const { rows } = await pool.query<{ result: string; action: string }>('SELECT result, action FROM audit_log ORDER BY at DESC, seq DESC LIMIT 1');
  assert.equal(rows[0]?.result, 'error');

  await pool.query('DELETE FROM audit_log');
});
