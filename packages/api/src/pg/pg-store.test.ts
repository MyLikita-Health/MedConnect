/**
 * PostgreSQL integration tests. Skipped unless TEST_DATABASE_URL (or
 * DATABASE_URL) is set — run with `npm run test:db` after `npm run db:up`.
 *
 * Isolation: each run drops and recreates a dedicated `hub_test` database on
 * the same server as the configured URL, then runs the real migrations there.
 * Nothing in the dev `hub` database is touched (demo data stays intact).
 */
import { after, before, test } from 'node:test';
import { skip as skipTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { CanonicalMessage } from '@integration-hub/shared';
import { closeDbPool, createDbPool } from './pool.js';
import { runMigrations } from './migrate.js';
import { PostgresMessageStore } from './pg-store.js';
import { PostgresDeviceRegistry } from './pg-devices.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipReason = DB_URL ? false : 'TEST_DATABASE_URL/DATABASE_URL not set (npm run db:up && npm run test:db)';

let pool: Pool | undefined;
let store: PostgresMessageStore | undefined;
let devices: PostgresDeviceRegistry | undefined;

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
  await runMigrations(pool);
});

after(async () => {
  if (pool) await closeDbPool(pool);
});

const base: Pick<CanonicalMessage, 'protocol' | 'direction' | 'raw' | 'status' | 'errors' | 'timeline'> = {
  protocol: 'ASTM',
  direction: 'device-to-host',
  raw: 'H|\\^&|',
  status: 'ROUTED',
  errors: [],
  timeline: [{ stage: 'RECEIVED', at: new Date().toISOString() }],
};

function message(id: string, receivedAt: string, overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return { id, ...base, deviceId: 'PG-DEV-1', receivedAt, ...overrides };
}

test('Postgres stores round-trip a full message with canonical payload', { skip: skipReason }, async () => {
  if (!pool || !store) return skipTest('no pool');
  const id = '00000000-0000-4000-8000-000000000001';
  const msg = message(id, '2026-09-04T08:00:00.000Z', {
    raw: 'H|\\^&||||PG-DEV^1|||||||P|1|20260904080000',
    records: [{ type: 'H', fields: ['\\^&', '', '', '', 'PG-DEV^1'] }],
    payload: {
      patient: { id: 'pg-test-1001', name: 'Doe, Jane', dateOfBirth: '19900101', gender: 'F' },
      order: { id: 'pg-test-order-1001', sampleId: 'S-1', tests: [{ code: 'GLUCOSE', name: 'Glucose' }] },
      results: [
        { testCode: 'GLUCOSE', originalTestCode: 'GLU', testName: 'Glucose', value: '95', unit: 'mg/dL', referenceRange: '70-110', flag: 'N', status: 'F' },
      ],
    },
  });
  await store.record(msg);

  const got = await store.get(id);
  assert.ok(got);
  assert.equal(got.status, 'ROUTED');
  assert.equal(got.deviceId, 'PG-DEV-1');
  assert.equal(got.raw, msg.raw);
  assert.equal(got.records?.length, 1);
  assert.equal(got.payload?.patient.id, 'pg-test-1001');
  assert.equal(got.payload?.patient.name, 'Doe, Jane');
  assert.equal(got.payload?.order.sampleId, 'S-1');
  assert.equal(got.payload?.results.length, 1);
  assert.equal(got.payload?.results[0]!.value, '95');
  assert.equal(got.timeline[0]!.stage, 'RECEIVED');

  // Clean up so sibling tests see a clean database.
  await pool.query('DELETE FROM results WHERE message_id = $1', [id]);
  await pool.query('DELETE FROM orders WHERE message_id = $1', [id]);
  await pool.query('DELETE FROM patients WHERE id = $1', ['pg-test-1001']);
  await pool.query('DELETE FROM messages WHERE id = $1', [id]);
});

test('Postgres store round-trips an imaging study event (M3.3 performed study)', { skip: skipReason }, async () => {
  if (!pool || !store) return skipTest('no pool');
  const id = '00000000-0000-4000-8000-000000000002';
  const msg = message(id, '2026-09-04T09:00:00.000Z', {
    protocol: 'REST',
    deviceId: 'orthanc',
    raw: 'ORTHANC study 1.2.840.10008 accession ACC-PG-IMG performed',
    imaging: {
      kind: 'imaging',
      accession: 'ACC-PG-IMG',
      performedAt: '2026-09-04T09:00:01.000Z',
      study: {
        orthancId: 'study-pg-1',
        patientOrthancId: 'pat-pg-1',
        studyInstanceUid: '1.2.840.10008.1',
        accessionNumber: 'ACC-PG-IMG',
        studyDescription: 'CT CHEST',
        series: [],
        storageUrl: 'http://orthanc:8042/studies/study-pg-1',
      },
    },
  });
  await store.record(msg);

  const got = await store.get(id);
  assert.ok(got);
  assert.ok(got.imaging, 'imaging field survives the PG round-trip');
  assert.equal(got.imaging!.kind, 'imaging');
  assert.equal(got.imaging!.accession, 'ACC-PG-IMG');
  assert.equal(got.imaging!.study.orthancId, 'study-pg-1');
  assert.equal(got.imaging!.study.storageUrl, 'http://orthanc:8042/studies/study-pg-1');
  assert.equal(got.payload, undefined, 'imaging events carry no lab payload');
  assert.equal(got.protocol, 'REST');
  assert.equal(got.deviceId, 'orthanc');

  // Clean up so sibling tests see a clean database.
  await pool.query('DELETE FROM messages WHERE id = $1', [id]);
});

test('Postgres store lists newest-first with device/status filters and stats', { skip: skipReason }, async () => {
  if (!pool || !store) return skipTest('no pool');
  const ids = [
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000012',
    '00000000-0000-4000-8000-000000000013',
  ];
  await store.record(message(ids[0]!, '2026-09-04T10:00:00.000Z'));
  await store.record(message(ids[1]!, '2026-09-04T10:01:00.000Z', { deviceId: 'PG-DEV-2', status: 'FAILED', errors: ['Missing order identifier'] }));
  await store.record(message(ids[2]!, '2026-09-04T10:02:00.000Z'));

  assert.deepEqual((await store.list()).map((m) => m.id), [ids[2], ids[1], ids[0]]);
  assert.deepEqual((await store.list({ limit: 2 })).map((m) => m.id), [ids[2], ids[1]]);
  assert.deepEqual((await store.list({ deviceId: 'PG-DEV-2' })).map((m) => m.id), [ids[1]]);
  assert.deepEqual((await store.list({ status: 'FAILED' })).map((m) => m.id), [ids[1]]);

  const stats = await store.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.byStatus['ROUTED'], 2);
  assert.equal(stats.byStatus['FAILED'], 1);
  assert.equal(stats.failed, 1);
});

test('Postgres mappings seed, override and read back', { skip: skipReason }, async () => {
  if (!pool || !store) return skipTest('no pool');
  await store.setMappings({ GLU: 'GLUCOSE', CREA: 'CREATININE' });
  const table = await store.getMappings();
  assert.equal(table['GLU'], 'GLUCOSE');
  assert.equal(table['CREA'], 'CREATININE');
  // Override an existing mapping.
  await store.setMappings({ GLU: 'GLUCOSE_2' });
  assert.equal((await store.getMappings())['GLU'], 'GLUCOSE_2');
});

test('Postgres device registry registers, upserts and stats', { skip: skipReason }, async () => {
  if (!pool || !devices) return skipTest('no pool');
  const record = await devices.register({ name: 'pg-test Mindray BS-430', manufacturer: 'Mindray' });
  assert.equal(record.state, 'unknown');
  assert.equal(record.name, 'pg-test Mindray BS-430');

  // Re-registering resets the connection state (mirrors the in-memory registry).
  const reRegistered = await devices.register({ name: 'pg-test Mindray BS-430' });
  assert.equal(reRegistered.state, 'unknown');

  // Wire-discovered devices update connection state via upsertFromConnection.
  await devices.upsertFromConnection({ id: record.id, state: 'connected' });
  const updated = await devices.get(record.id);
  assert.equal(updated?.state, 'connected');

  // Brand-new wire-discovered devices are flagged auto-registered.
  const auto = await devices.upsertFromConnection({ id: 'pg-test-auto-1', state: 'connected' });
  assert.equal(auto.autoRegistered, true);

  const stats = await devices.stats();
  assert.equal(stats.total, 2);
});

test('Postgres store persists match metadata and filters the held queue', { skip: skipReason }, async () => {
  if (!pool || !store) return skipTest('no pool');
  const id = '00000000-0000-4000-8000-000000000021';
  const msg = message(id, '2026-09-04T11:00:00.000Z', { status: 'HELD' });
  await store.record(msg);
  await store.mark(id, 'HELD', 'HELD: not matched: UNMATCHED', {
    match: { status: 'UNMATCHED', at: '2026-09-04T11:00:01.000Z', reason: 'no registered order matched' },
  });

  const heldList = await store.list({ held: true });
  assert.deepEqual(heldList.map((m) => m.id), [id]);
  const got = await store.get(id);
  assert.equal(got?.status, 'HELD');
  assert.equal(got?.match?.status, 'UNMATCHED');
  assert.equal(got?.match?.reason, 'no registered order matched');
  assert.equal(got?.match?.at, '2026-09-04T11:00:01.000Z');

  // Operator release moves it out of the held queue.
  await store.mark(id, 'QUEUED', 'released by operator after review');
  assert.equal((await store.list({ held: true })).length, 0);
  assert.equal((await store.get(id))?.status, 'QUEUED');

  // Clean up so sibling tests see a clean database.
  await pool.query('DELETE FROM messages WHERE id = $1', [id]);
});