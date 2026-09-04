/**
 * PostgreSQL device registry + A4 binding (migration 0008): profileId
 * round-trips through register/get, the FK rejects unknown profile ids, and a
 * deleted profile detaches the device (ON DELETE SET NULL) instead of
 * deleting it. Skipped unless TEST_DATABASE_URL/DATABASE_URL is set.
 */
import { after, before, test } from 'node:test';
import { skip as skipTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { closeDbPool, createDbPool } from './pool.js';
import { runMigrations } from './migrate.js';
import { PostgresDeviceRegistry } from './pg-devices.js';
import { PostgresProfileStore } from '@integration-hub/core';
import { ACME_CHEM_200_PROFILE } from '@integration-hub/core';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipReason = DB_URL ? false : 'TEST_DATABASE_URL/DATABASE_URL not set (npm run db:up && npm run test:db)';

let pool: Pool | undefined;

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

test('device profile binding round-trips; unknown profile ids are rejected by the FK', { skip: skipReason }, async () => {
  if (!pool) return skipTest('no pool');
  const devices = new PostgresDeviceRegistry(pool);
  await pool.query('DELETE FROM devices');
  await pool.query("DELETE FROM device_profiles WHERE id = 'acme-chem-200'");

  // Seed the profile, then bind a device to it.
  const profiles = new PostgresProfileStore(pool);
  await profiles.upsert(ACME_CHEM_200_PROFILE);
  const bound = await devices.register({ id: 'acme-1', name: 'Acme #1', profileId: 'acme-chem-200' });
  assert.equal(bound.profileId, 'acme-chem-200');
  assert.equal((await devices.get('acme-1'))?.profileId, 'acme-chem-200');
  assert.equal((await devices.list()).find((d) => d.id === 'acme-1')?.profileId, 'acme-chem-200');

  // Re-registering keeps/updates the binding; unknown ids violate the FK.
  await devices.register({ id: 'acme-1', name: 'Acme #1 renamed', profileId: 'acme-chem-200' });
  assert.equal((await devices.get('acme-1'))?.name, 'Acme #1 renamed');
  await assert.rejects(
    () => devices.register({ id: 'ghost', name: 'Ghost', profileId: 'no-such-profile' }),
    /foreign key|violates/,
  );

  // Deleting the profile detaches devices instead of deleting them.
  await profiles.remove('acme-chem-200');
  const detached = await devices.get('acme-1');
  assert.equal(detached?.profileId, undefined);
  assert.equal(detached?.name, 'Acme #1 renamed');

  // Clean slate for sibling tests.
  await pool.query('DELETE FROM devices');
});
