/**
 * PostgreSQL alert-store integration tests (M2 alerting). Shares the `hub_test`
 * database pattern of the other DB suites — skipped without a DB URL.
 */
import { after, before, test } from 'node:test';
import { skip as skipTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PostgresMessageStore, closeDbPool, createDbPool, runMigrations } from '@integration-hub/api';
import { AlertService, PostgresAlertStore, type AlertRule } from './index.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipReason = DB_URL ? false : 'TEST_DATABASE_URL/DATABASE_URL not set (npm run db:up && npm run test:db)';

let pool: Pool | undefined;
let store: PostgresAlertStore | undefined;

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
  store = new PostgresAlertStore(pool);
  // The message store is used only to exercise migrations' message tables.
  void new PostgresMessageStore(pool);
});

after(async () => {
  if (pool) await closeDbPool(pool);
});

function rule(id: string, partial: Partial<AlertRule> = {}): AlertRule {
  return { id, kind: 'held-backlog', name: id, threshold: 1, channels: ['console'], enabled: true, ...partial };
}

test('Postgres alert store round-trips rules and fire/resolve lifecycle', { skip: skipReason }, async () => {
  if (!pool || !store) return skipTest('no pool');
  await store.upsertRule(rule('pg-held'));
  await store.upsertRule(rule('pg-off', { kind: 'device-offline', subject: 'PG-DEV-1', channels: ['console', 'webhook'], webhookUrl: 'https://hooks.example/x' }));

  assert.equal((await store.listRules()).length, 2);
  const rules = await store.listRules();
  assert.equal(rules.find((r) => r.id === 'pg-off')?.subject, 'PG-DEV-1');
  assert.deepEqual(rules.find((r) => r.id === 'pg-off')?.channels, ['console', 'webhook']);

  await store.fire({
    id: 'alrt_test1',
    ruleId: 'pg-held',
    kind: 'held-backlog',
    message: 'held-backlog backlog is 3 (threshold 1)',
    status: 'FIRING',
    firedAt: new Date().toISOString(),
    count: 3,
  });

  const open = await store.openAlert('pg-held', '');
  assert.ok(open);
  assert.equal(open.count, 3);
  assert.equal((await store.listAlerts({ firing: true })).length, 1);

  await store.resolveOpen('pg-held', '');
  assert.equal(await store.openAlert('pg-held', ''), undefined);
  const history = await store.listAlerts();
  assert.equal(history.length, 1);
  assert.equal(history[0]!.status, 'RESOLVED');
  assert.ok(history[0]!.resolvedAt);

  await store.deleteRule('pg-held');
  await store.deleteRule('pg-off');
  assert.equal((await store.listRules()).length, 0);
});

test('Postgres alert service fires and resolves through the full stack', { skip: skipReason }, async () => {
  if (!pool || !store) return skipTest('no pool');
  await store.upsertRule(rule('pg-dest', { kind: 'destination-down', subject: 'lis-pg', threshold: 2 }));
  const alerts = new AlertService(store);

  await alerts.deliveryFailed('lis-pg', 'ECONNREFUSED');
  assert.equal((await store.listAlerts({ firing: true })).length, 0);
  await alerts.deliveryFailed('lis-pg', 'ECONNREFUSED');
  const firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 1);
  assert.equal(firing[0]!.subject, 'lis-pg');

  await alerts.deliverySucceeded('lis-pg');
  assert.equal((await store.listAlerts({ firing: true })).length, 0);

  await store.deleteRule('pg-dest');
});