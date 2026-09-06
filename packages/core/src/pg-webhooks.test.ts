/**
 * PostgreSQL webhook-subscription store integration tests (D3 slice 4).
 * Shares the `hub_test` database pattern — skipped without a DB URL.
 *
 * The headline assertion is restart survival: subscriptions written through
 * one EventBus instance are visible to a fresh instance booted on the same
 * store — exactly what the hub does when it restarts in PG mode.
 */
import { after, before, test } from 'node:test';
import { skip as skipTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { closeDbPool, createDbPool, runMigrations } from '@integration-hub/api';
import { EventBus, PostgresWebhookStore, type WebhookSubscription } from './index.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipReason = DB_URL ? false : 'TEST_DATABASE_URL/DATABASE_URL not set (npm run db:up && npm run test:db)';

let pool: Pool | undefined;

const SUB: WebhookSubscription = {
  id: 'wh-lis-results',
  name: 'LIS results receiver',
  url: 'https://lis.example/hook',
  secret: 'smoke-secret-1234567890',
  events: ['result.received', 'result.failed'],
  enabled: true,
  retry: { maxAttempts: 3, backoffMs: 500, backoffFactor: 2, jitter: false },
  createdAt: '2026-09-05T00:00:00.000Z',
};

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
  await runMigrations(pool);
});

after(async () => {
  if (pool) await closeDbPool(pool);
});

test('Postgres webhook store round-trips subscriptions (upsert / list / remove)', { skip: skipReason }, async () => {
  if (!pool) return skipTest('no pool');
  const store = new PostgresWebhookStore(pool);
  await store.upsert(SUB);
  await store.upsert({ ...SUB, id: 'wh-second', name: 'Second receiver', events: '*' });

  const all = await store.list();
  assert.equal(all.length, 2);
  const first = all.find((s) => s.id === 'wh-lis-results');
  assert.ok(first);
  assert.equal(first.name, 'LIS results receiver');
  assert.equal(first.url, 'https://lis.example/hook');
  assert.equal(first.secret, 'smoke-secret-1234567890'); // secret persists server-side
  assert.deepEqual(first.events, ['result.received', 'result.failed']);
  assert.equal(first.enabled, true);
  assert.deepEqual(first.retry, { maxAttempts: 3, backoffMs: 500, backoffFactor: 2, jitter: false });

  // Same id overwrites (PATCH path) — no duplicate row.
  await store.upsert({ ...SUB, enabled: false });
  assert.equal((await store.list()).length, 2);
  assert.equal((await store.list()).find((s) => s.id === 'wh-lis-results')?.enabled, false);

  await store.remove('wh-lis-results');
  assert.equal((await store.list()).length, 1);
  await store.remove('wh-second');
  assert.equal((await store.list()).length, 0);
});

test('subscriptions survive a hub restart: a fresh EventBus on the same store sees them', { skip: skipReason }, async () => {
  if (!pool) return skipTest('no pool');
  const store = new PostgresWebhookStore(pool);

  // "First boot": a bus with the store writes subscriptions through.
  const busA = new EventBus({ store });
  await busA.addSubscription(SUB);
  await busA.addSubscription({ ...SUB, id: 'wh-star', name: 'Everything receiver', events: '*' });
  assert.equal(busA.listSubscriptions().length, 2);

  // "Restart": a brand-new bus on the same store loads them at boot.
  const busB = new EventBus({ store });
  await busB.ready;
  const loaded = busB.listSubscriptions();
  assert.equal(loaded.length, 2);
  const lis = loaded.find((s) => s.id === 'wh-lis-results');
  assert.ok(lis);
  assert.equal(lis.secret, 'smoke-secret-1234567890');
  assert.equal(lis.enabled, true);
  assert.ok(loaded.find((s) => s.id === 'wh-star' && s.events === '*'));

  // And the restarted bus can keep managing: remove through bus B is seen by a fresh bus C.
  await busB.removeSubscription('wh-lis-results');
  const busC = new EventBus({ store });
  await busC.ready;
  assert.deepEqual(
    busC.listSubscriptions().map((s) => s.id),
    ['wh-star'],
  );

  await store.remove('wh-star');
});

test('corrupt subscription rows fail loudly on load', { skip: skipReason }, async () => {
  if (!pool) return skipTest('no pool');
  const store = new PostgresWebhookStore(pool);
  await pool.query(`INSERT INTO webhook_subscriptions (id, payload) VALUES ($1, $2)`, [
    'wh-corrupt',
    JSON.stringify({ id: 'wh-corrupt', name: 42 }), // invalid: name not a string, no url/secret/events
  ]);
  await assert.rejects(() => store.list());
  await pool.query(`DELETE FROM webhook_subscriptions WHERE id = 'wh-corrupt'`);
});

test('EventBus without a store keeps subscriptions in memory only (unchanged behavior)', { skip: skipReason }, async () => {
  const bus = new EventBus({ subscriptions: [SUB] });
  assert.equal(bus.listSubscriptions().length, 1);
  assert.equal(bus.removeSubscription(SUB.id), true);
  assert.equal(bus.listSubscriptions().length, 0);
});