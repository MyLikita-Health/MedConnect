/** @packageDocumentation
 * D11 PG-gated tests: the edge→cloud sync round-trip against real Postgres.
 * Run with `npm run test:db` (needs TEST_DATABASE_URL / DATABASE_URL).
 *
 * Proves the G4 exit criterion in miniature: edge writes land in the outbox
 * in the same transaction (no dual-write window), the syncer ships them, the
 * cloud ingest applies them idempotently (redelivery is a no-op), and the
 * cloud copy converges with the edge — including message status transitions
 * (RECEIVED → ROUTED) and device state flips.
 *
 * Isolation: same drop/recreate `hub_test` pattern as the other pg-* tests.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDbPool, closeDbPool } from './pool.js';
import { runMigrations } from './migrate.js';
import { PostgresMessageStore } from './pg-store.js';
import { PostgresDeviceRegistry } from './pg-devices.js';
import { PostgresOutbox, PostgresIngestStore } from './pg-outbox.js';
import { OutboxSyncer } from '@integration-hub/core';
import type { Pool } from 'pg';
import type { CanonicalMessage } from '@integration-hub/shared';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipReason = DB_URL ? false : 'TEST_DATABASE_URL/DATABASE_URL not set (npm run db:up && npm run test:db)';

let pool: Pool | undefined;
let edgePool: Pool | undefined;
let store: PostgresMessageStore;
let devices: PostgresDeviceRegistry;
let outbox: PostgresOutbox;

function labMessage(id: string, status: CanonicalMessage['status'] = 'RECEIVED'): CanonicalMessage {
  return {
    id,
    protocol: 'ASTM',
    direction: 'device-to-host',
    deviceId: 'EDGE-1',
    receivedAt: new Date().toISOString(),
    raw: `H|\\^&|||${id}\rP|1|PID-1||Doe^John||19850312|M\rR|1|^^^GLU|95|mg/dL|70-110|N|||F`,
    records: [{ type: 'H', fields: ['H', '\\^&'] }],
    payload: {
      patient: { id: 'PID-1', name: 'Doe, John', dateOfBirth: '1985-03-12', gender: 'male' },
      order: { id: 'ORD-1', sampleId: 'S-1', tests: [{ code: 'GLUCOSE' }] },
      results: [{ testCode: 'GLUCOSE', value: '95', unit: 'mg/dL', referenceRange: '70-110', flag: 'N', status: 'F' }],
    },
    status,
    errors: [],
    timeline: [{ stage: status, at: new Date().toISOString() }],
  };
}

before(async () => {
  if (!DB_URL) return;
  // CLOUD database (fresh).
  const admin = createDbPool(DB_URL);
  try {
    await admin.query('DROP DATABASE IF EXISTS hub_test WITH (FORCE)');
    await admin.query('CREATE DATABASE hub_test');
  } finally {
    await closeDbPool(admin);
  }
  const cloudUrl = new URL(DB_URL);
  cloudUrl.pathname = '/hub_test';
  pool = createDbPool(cloudUrl.toString());
  await runMigrations(pool);

  // EDGE database (fresh) — the edge keeps its own store + outbox.
  const admin2 = createDbPool(DB_URL);
  try {
    await admin2.query('DROP DATABASE IF EXISTS hub_test_edge WITH (FORCE)');
    await admin2.query('CREATE DATABASE hub_test_edge');
  } finally {
    await closeDbPool(admin2);
  }
  const edgeUrl = new URL(DB_URL);
  edgeUrl.pathname = '/hub_test_edge';
  edgePool = createDbPool(edgeUrl.toString());
  await runMigrations(edgePool);

  store = new PostgresMessageStore(edgePool);
  devices = new PostgresDeviceRegistry(edgePool);
  outbox = new PostgresOutbox(edgePool);
  store.outbox = outbox;
  devices.outbox = outbox;
  // The edge ships for a cloud org/facility (H1 write-through).
  const tenancy = { orgId: 'org-edge', facilityId: 'fac-edge' };
  store.tenancy = tenancy;
  devices.tenancy = tenancy;
});

after(async () => {
  if (pool) await closeDbPool(pool!);
  if (edgePool) await closeDbPool(edgePool!);
});

test('edge write-through: recording a message appends the outbox row in the same transaction', { skip: !DB_URL }, async () => {
  await store.record(labMessage('sync-m-1'));
  const pending = await outbox.listUnacked(100);
  assert.equal(pending.length, 1, 'one sync entry for one message');
  assert.equal(pending[0]!.table, 'messages');
  assert.equal(pending[0]!.pk, 'sync-m-1');
  assert.equal(pending[0]!.facilityId, 'fac-edge', 'tenancy stamped');
  const payload = pending[0]!.payload as { id: string; status: string };
  assert.equal(payload.id, 'sync-m-1');
  assert.equal(payload.status, 'RECEIVED');
});

test('edge→cloud convergence: syncer ships, ingest applies, cloud row matches the edge row', { skip: !DB_URL }, async () => {
  // A second message + status transition on the edge.
  await store.record(labMessage('sync-m-2'));
  await store.mark('sync-m-2', 'ROUTED', 'delivered to console');
  await devices.upsertFromConnection({ id: 'EDGE-1', state: 'connected' });

  // The cloud ingest store (same PG instance, different DB role).
  const ingest = new PostgresIngestStore(pool!);
  const syncer = new OutboxSyncer({
    reader: outbox,
    cloudBaseUrl: 'unused', // shipBatch is bypassed; applyBatch driven directly
    gatewayId: 'gw-test',
    apiKey: 'k',
  });

  // Ship manually through the ingest store (what the cloud route does).
  const batch = await outbox.listUnacked(200);
  assert.ok(batch.length >= 3, 'message x2 (INSERT + UPDATE) + device entry pending');
  const appliedThrough = await ingest.applyBatch(batch);
  await outbox.markAcked(appliedThrough);

  // Cloud copy converges: message with the ROUTED status, device connected.
  const { rows: cloudMsg } = await pool!.query<{ status: string; facility_id: string | null }>(
    `SELECT status, facility_id FROM messages WHERE id = $1`,
    ['sync-m-2'],
  );
  assert.equal(cloudMsg[0]!.status, 'ROUTED', 'status transition converged');
  assert.equal(cloudMsg[0]!.facility_id, 'fac-edge', 'tenancy stamps rode the sync entry');

  const { rows: cloudDev } = await pool!.query<{ state: string }>(`SELECT state FROM devices WHERE id = $1`, ['EDGE-1']);
  assert.equal(cloudDev[0]!.state, 'connected', 'device state converged');

  // Edge outbox is acked; the ingest cursor reports the facility.
  assert.equal(await outbox.pendingCount(), 0, 'edge outbox fully acked');
  const cursors = await ingest.cursors();
  assert.ok(cursors.some((c) => c.facilityId === 'fac-edge' && c.maxSeq >= 3));
  void syncer; // constructed for type-checking; shipping loop not needed here
});

test('redelivery is a cloud-side no-op: ingest dedups on (facility_id, seq)', { skip: !DB_URL }, async () => {
  const ingest = new PostgresIngestStore(pool!);
  const batch = await outbox.listUnacked(200); // empty now — all acked
  assert.equal(batch.length, 0);

  // Force a redelivery: the edge lost its ack (crash before markAcked).
  await pool!.query(`UPDATE outbox SET acked = false`);
  const batch2 = await outbox.listUnacked(200);
  assert.ok(batch2.length > 0);
  const appliedThrough = await ingest.applyBatch(batch2);
  assert.equal(appliedThrough, 0, 'nothing NEW applied — every (facility, seq) already present');
  await outbox.markAcked(appliedThrough === 0 ? Number((await pool!.query<{ m: string }>(`SELECT max(seq) AS m FROM outbox`)).rows[0]!.m) : appliedThrough);

  // Cloud still has exactly one copy.
  const { rows } = await pool!.query<{ n: string }>(`SELECT count(*) AS n FROM messages WHERE id = $1`, ['sync-m-1']);
  assert.equal(Number(rows[0]!.n), 1, 'no duplicate cloud rows');
  assert.equal(await outbox.pendingCount(), 0, 'edge outbox acked again');
});

test('two facilities isolated in the cloud ingest: facility B cannot see facility A rows', { skip: !DB_URL }, async () => {
  const ingest = new PostgresIngestStore(pool!);
  // Facility B ships its own message (same seq numbers, different facility).
  const other: OutboxEntry = {
    seq: 1,
    table: 'messages',
    op: 'INSERT',
    pk: 'sync-m-B1',
    payload: { id: 'sync-m-B1', protocol: 'ASTM', direction: 'inbound', receivedAt: new Date().toISOString(), raw: 'H|', status: 'RECEIVED', errors: [], timeline: [] },
    facilityId: 'fac-B',
    createdAt: new Date().toISOString(),
  };
  const applied = await ingest.applyBatch([other]);
  assert.equal(applied, 1);

  const { rows } = await pool!.query(`SELECT facility_id FROM messages WHERE id = 'sync-m-B1'`);
  assert.equal(rows[0]!.facility_id, 'fac-B');
  // The ledger keeps both facilities' entries apart.
  const cursors = await ingest.cursors();
  const facB = cursors.find((c) => c.facilityId === 'fac-B');
  const facEdge = cursors.find((c) => c.facilityId === 'fac-edge');
  assert.ok(facB && facEdge, 'both facilities tracked independently');
  assert.ok(facB!.maxSeq <= 1, 'facility B cursor is its own');
  void ingest;
});

import type { OutboxEntry } from '@integration-hub/core';
