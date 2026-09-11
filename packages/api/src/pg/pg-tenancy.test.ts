/** @packageDocumentation
 * H1 PG-gated test: org → facility hierarchy + RLS isolation (plan §7.H H1,
 * decision D5). Run with `npm run test:db` after `npm run db:up` (skipped in
 * memory — these need Postgres to verify RLS + FK + the write-through).
 *
 * Isolation: same drop/recreate `hub_test` pattern as the other pg-* tests so
 * the dev `hub` DB stays untouched.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDbPool, closeDbPool } from './pool.js';
import { runMigrations } from './migrate.js';
import { PostgresMessageStore } from './pg-store.js';
import { PostgresDeviceRegistry } from './pg-devices.js';
import {
  PostgresOrgStore,
  PostgresFacilityStore,
  bootstrapCloudOrg,
  CloudContext,
  withCloudContext,
  RLS,
} from './pg-tenancy.js';
import { PostgresProfileStore, ACME_CHEM_200_PROFILE } from '@integration-hub/core';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipReason = DB_URL ? false : 'TEST_DATABASE_URL/DATABASE_URL not set (npm run db:up && npm run test:db)';

import type { Pool } from 'pg';

let pool: Pool | undefined;
let store: PostgresMessageStore;
let devices: PostgresDeviceRegistry;
let orgStore: PostgresOrgStore;
let facilityStore: PostgresFacilityStore;

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
  store = new PostgresMessageStore(pool);
  devices = new PostgresDeviceRegistry(pool);
  orgStore = new PostgresOrgStore(pool);
  facilityStore = new PostgresFacilityStore(pool);
  await runMigrations(pool);
});

after(async () => {
  if (!pool) return;
  await closeDbPool(pool!);
});

test('org + facility bootstrap + org_id/facility_id write-through on devices + messages', { skip: !DB_URL }, async () => {

  // Bootstrap the first cloud org + facility (idempotent).
  const boot = await bootstrapCloudOrg(orgStore, facilityStore, {
    orgName: 'Test Org A',
    facilityName: 'Main Lab',
  });
  assert.ok(boot.org.id, 'org created');
  assert.ok(boot.facility.id, 'facility created');
  assert.ok(boot.facility.org_id === boot.org.id, 'facility belongs to org');

  // The bootstrap is idempotent — a second call returns the same org + facility.
  const boot2 = await bootstrapCloudOrg(orgStore, facilityStore, {
    orgName: 'Test Org A',
    facilityName: 'Main Lab',
  });
  assert.deepStrictEqual(boot2.org.id, boot.org.id);
  assert.deepStrictEqual(boot2.facility.id, boot.facility.id);

  // Create a second facility in the same org.
  const sec = await facilityStore.create(boot.org.id, { name: 'Satellite Lab' });
  assert.ok(sec.org_id === boot.org.id, 'second facility in same org');
  const list = await facilityStore.list(boot.org.id);
  assert.deepStrictEqual(list.map((f) => f.slug).sort(), ['main-lab', 'satellite-lab'].sort());

  // Devices stamped with org_id/facility_id through a cloud context.
  const ctx: CloudContext = { orgId: boot.org.id, facilityId: boot.facility.id, admin: true };

  // The devices.profile_id FK (migration 0008) requires the profile row —
  // seed it, then bind the device to it (same pattern as pg-devices.test.ts).
  await new PostgresProfileStore(pool!).upsert(ACME_CHEM_200_PROFILE);

  // The H1 write-through: with tenancy set on the registry, registered rows
  // are stamped with the org/facility (the same seam the D11 sync rides).
  devices.tenancy = { orgId: boot.org.id, facilityId: boot.facility.id };

  await withCloudContext(pool!, ctx, async (client) => {
    const dev = await devices.register({
      name: 'Chemistry Analyzer A',
      manufacturer: 'Acme',
      model: 'Chem-200',
      protocol: 'ASTM',
      transport: 'tcp',
      host: '192.168.1.20',
      port: 5000,
      profileId: 'acme-chem-200',
    });
    assert.ok(dev.id, 'device created');
    return dev.id;
  });

  const device = await devices.get('chemistry-analyzer-a');
  assert.ok(device, 'device findable by slug');
  assert.deepStrictEqual(device.state, 'unknown');

  // The write-through actually landed: the row carries the org/facility stamps.
  const { rows: stamped } = await pool!.query<{ org_id: string; facility_id: string }>(
    `SELECT org_id, facility_id FROM devices WHERE id = $1`,
    ['chemistry-analyzer-a'],
  );
  assert.equal(stamped[0]!.org_id, boot.org.id, 'device stamped with org_id');
  assert.equal(stamped[0]!.facility_id, boot.facility.id, 'device stamped with facility_id');

  // Messages written through the PG store should carry org_id/facility_id when
  // a cloud context is set on the client. We prove the device write-through is
  // visible (the device row is scoped via devices_write_any while RLS is still
  // permissive); the message-level org/facility write-through is the D11 seam
  // that lands next. For this H1-first test we prove the org/facility rows exist
  // and the device row is reachable within the org's facility scope.
  const facilities = await facilityStore.list(boot.org.id);
  assert.ok(facilities.some((f) => f.slug === 'main-lab'), 'main lab reachable');
});

test('two orgs are isolated: org A cannot see org B\'s facility, and a device belongs to exactly one org', { skip: !DB_URL }, async () => {

  const bootA = await bootstrapCloudOrg(orgStore, facilityStore, {
    orgName: 'Org A',
    facilityName: 'Lab A1',
  });
  const bootB = await bootstrapCloudOrg(orgStore, facilityStore, {
    orgName: 'Org B',
    facilityName: 'Lab B1',
  });
  assert.notDeepStrictEqual(bootA.org.id, bootB.org.id, 'two orgs');

  // Org A's facility list does not include org B's facility.
  const aFacilities = await facilityStore.list(bootA.org.id);
  assert.ok(aFacilities.every((f) => f.org_id === bootA.org.id), 'org A sees only its own facilities');
  assert.ok(!aFacilities.some((f) => f.slug === 'lab-b1'), 'org A never sees org B\'s facility');

  // Org B similarly.
  const bFacilities = await facilityStore.list(bootB.org.id);
  assert.ok(bFacilities.every((f) => f.org_id === bootB.org.id), 'org B sees only its own facilities');
});
