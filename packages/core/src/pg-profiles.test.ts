/**
 * PostgreSQL DeviceProfile store integration tests (M2 sprint 3). Shares the
 * `hub_test` database pattern — skipped without a DB URL.
 */
import { after, before, test } from 'node:test';
import { skip as skipTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { DeviceProfile } from '@integration-hub/shared';
import { closeDbPool, createDbPool, runMigrations } from '@integration-hub/api';
import { ACME_CHEM_200_PROFILE, PostgresProfileStore, REFERENCE_PROFILE } from './index.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipReason = DB_URL ? false : 'TEST_DATABASE_URL/DATABASE_URL not set (npm run db:up && npm run test:db)';

let pool: Pool | undefined;
let store: PostgresProfileStore | undefined;

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
  store = new PostgresProfileStore(pool);
});

after(async () => {
  if (pool) await closeDbPool(pool);
});

test('Postgres profile store round-trips certified profiles and rejects corrupt rows', { skip: skipReason }, async () => {
  if (!pool || !store) return skipTest('no pool');
  const s = store;
  const p = pool;
  await s.upsert(REFERENCE_PROFILE);
  await s.upsert(ACME_CHEM_200_PROFILE);

  assert.equal((await s.list()).length, 2);
  const acme = await s.get('acme-chem-200');
  assert.ok(acme);
  assert.equal(acme.manufacturer, 'Acme Diagnostics');
  assert.equal(acme.status, 'certified');
  assert.equal(acme.layout.order?.accession, 2);
  assert.equal(acme.layout.order?.sampleId, 3);

  // Version bump overwrites the row (config versioning, plan §6.3).
  const bumped: DeviceProfile = { ...ACME_CHEM_200_PROFILE, version: 2, name: 'Acme Chem 200 (rev B)' };
  await s.upsert(bumped);
  assert.equal((await s.get('acme-chem-200'))?.version, 2);
  assert.equal((await s.list()).length, 2); // same slug, no new row

  // A corrupt row fails loudly on read (zod validation in parseDeviceProfile).
  await p.query(`UPDATE device_profiles SET payload = '{"id": 42}'::jsonb WHERE id = 'astm-reference'`);
  await assert.rejects(() => s.get('astm-reference'));

  await s.remove('acme-chem-200');
  await p.query(`DELETE FROM device_profiles WHERE id = 'astm-reference'`);
  assert.equal((await s.list()).length, 0);
});