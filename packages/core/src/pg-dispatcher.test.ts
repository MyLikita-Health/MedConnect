/**
 * PostgreSQL dispatcher integration tests (M1 durable delivery). Uses the same
 * dedicated `hub_test` database as packages/api pg-store tests — dropped and
 * recreated per run. Skipped unless TEST_DATABASE_URL / DATABASE_URL is set
 * (`npm run test:db`).
 */
import { after, before, test } from 'node:test';
import { skip as skipTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { CanonicalMessage } from '@integration-hub/shared';
import { PostgresMessageStore, closeDbPool, createDbPool, runMigrations } from '@integration-hub/api';
import { Dispatcher, PostgresAdmissionRegistry, PostgresDedupStore, PostgresOrderRegistry, PostgresRouteStore } from './index.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipReason = DB_URL ? false : 'TEST_DATABASE_URL/DATABASE_URL not set (npm run db:up && npm run test:db)';

// messages.id is uuid-typed; tests use fixed, readable UUIDs.
const M1 = '11111111-1111-4111-8111-111111111111';
const D1 = '22222222-2222-4222-8222-222222222222';
const D2 = '33333333-3333-4333-8333-333333333333';
const DLQ1 = '44444444-4444-4444-8444-444444444444';
const HELD1 = '55555555-5555-4555-8555-555555555555';

let pool: Pool | undefined;
let store: PostgresMessageStore | undefined;
let routes: PostgresRouteStore | undefined;

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
  store = new PostgresMessageStore(pool);
  routes = new PostgresRouteStore(pool);
});

after(async () => {
  if (pool) await closeDbPool(pool);
});

function message(id: string, raw = `H|1|${id}`): CanonicalMessage {
  return {
    id,
    protocol: 'ASTM',
    direction: 'device-to-host',
    deviceId: 'PG-DEV-1',
    receivedAt: new Date().toISOString(),
    raw,
    records: [{ type: 'H', fields: ['\\^&'] }],
    payload: {
      patient: { id: `pg-pat-${id}` },
      order: { id: `pg-ord-${id}`, tests: [] },
      results: [{ testCode: 'GLUCOSE', value: '95' }],
    },
    status: 'MAPPED',
    errors: [],
    timeline: [{ stage: 'RECEIVED', at: new Date().toISOString() }],
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('Postgres dispatcher delivers MAPPED → ROUTED and records the attempt', { skip: skipReason }, async (t) => {
  if (!pool || !store || !routes) return skipTest('no pool');
  const s = store;
  const r = routes;
  const dispatcher = new Dispatcher({ store: s, dedup: new PostgresDedupStore(pool), routes: r, pollMs: 5, sleep: () => Promise.resolve() });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message(M1));
  await waitFor(async () => (await s.get(M1))?.status === 'ROUTED');

  const got = await s.get(M1);
  assert.ok(got);
  assert.equal(got.status, 'ROUTED');
  assert.equal(got.dlqAt, undefined);
  const stages = got.timeline.map((e) => e.stage);
  assert.ok(stages.includes('QUEUED') && stages.includes('DELIVERING') && stages.includes('ROUTED'));

  const { rows } = await pool.query<{ status: string }>('SELECT status FROM message_attempts WHERE message_id = $1', [M1]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'OK');
});

test('Postgres dispatcher marks repeats as DUPLICATE', { skip: skipReason }, async (t) => {
  if (!pool || !store || !routes) return skipTest('no pool');
  const s = store;
  const r = routes;
  const dispatcher = new Dispatcher({ store: s, dedup: new PostgresDedupStore(pool), routes: r, pollMs: 5, sleep: () => Promise.resolve() });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message(D1, 'H|1|same-raw'));
  await waitFor(async () => (await s.get(D1))?.status === 'ROUTED');
  await dispatcher.record(message(D2, 'H|1|same-raw'));

  const dup = await s.get(D2);
  assert.ok(dup);
  assert.equal(dup.status, 'DUPLICATE');
  assert.equal(dup.duplicateOf, D1);
});

test('Postgres dispatcher exhausts retries into the DLQ with attempt history', { skip: skipReason }, async (t) => {
  if (!pool || !store || !routes) return skipTest('no pool');
  const s = store;
  const r = routes;
  // An unreachable HTTP destination: every attempt fails fast.
  await r.upsertDestination({
    id: 'down-lis',
    kind: 'http',
    name: 'Down LIS',
    url: 'http://127.0.0.1:1/hook',
    enabled: true,
    retry: { maxAttempts: 3, backoffMs: 1, backoffFactor: 2, jitter: false },
  });
  await r.upsertRule({ id: 'pg-rule-down', destinationId: 'down-lis', priority: 100, enabled: true });

  const dispatcher = new Dispatcher({ store: s, dedup: new PostgresDedupStore(pool), routes: r, pollMs: 5, sleep: () => Promise.resolve() });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  await dispatcher.record(message(DLQ1));
  await waitFor(async () => {
    const m = await s.get(DLQ1);
    return m?.status === 'FAILED' && m.dlqAt !== undefined;
  });

  const got = await s.get(DLQ1);
  assert.ok(got);
  assert.ok(got.dlqAt);
  assert.ok(got.timeline.some((e) => e.note?.includes('DLQ')));

  const { rows } = await pool.query<{ status: string }>('SELECT status FROM message_attempts WHERE message_id = $1', [DLQ1]);
  assert.deepEqual(rows.map((r) => r.status), ['FAILED', 'FAILED', 'FAILED']);

  // The DLQ view finds it.
  const dlqList = await s.list({ status: 'FAILED', dlq: true });
  assert.ok(dlqList.some((m) => m.id === DLQ1));

  // Cleanup so sibling suites stay isolated.
  await r.deleteDestination('down-lis');
});

test('Postgres route store round-trips an hl7 destination config', { skip: skipReason }, async () => {
  if (!pool || !routes) return skipTest('no pool');
  const r = routes;
  await r.upsertDestination({
    id: 'pg-lis-mllp',
    kind: 'hl7',
    name: 'PG LIS MLLP',
    hl7: { host: '127.0.0.1', port: 6661, sendingApp: 'HUB', receivingApp: 'ACME_LIS', version: '2.5.1' },
    enabled: true,
    retry: { maxAttempts: 3, backoffMs: 10, backoffFactor: 2, jitter: false },
  });

  const listed = await r.listDestinations();
  const hl7 = listed.find((d) => d.id === 'pg-lis-mllp');
  assert.ok(hl7);
  assert.equal(hl7.kind, 'hl7');
  assert.deepEqual(hl7.hl7, { host: '127.0.0.1', port: 6661, sendingApp: 'HUB', receivingApp: 'ACME_LIS', version: '2.5.1' });

  // Cleanup so sibling suites stay isolated.
  await r.deleteDestination('pg-lis-mllp');
});

test('Postgres admission registry round-trips ADT admissions (upsert on re-admit)', { skip: skipReason }, async () => {
  if (!pool) return skipTest('no pool');
  const registry = new PostgresAdmissionRegistry(pool);

  await registry.register({
    patientId: 'PG-ADM-1',
    name: 'Doe, Jane',
    dateOfBirth: '19850312',
    gender: 'F',
    visitId: 'VIS-9',
    status: 'admitted',
    receivedAt: new Date().toISOString(),
  });
  const [admitted] = await registry.find('PG-ADM-1');
  assert.ok(admitted);
  assert.equal(admitted.name, 'Doe, Jane');
  assert.equal(admitted.dateOfBirth, '19850312');
  assert.equal(admitted.visitId, 'VIS-9');
  assert.equal(admitted.status, 'admitted');
  assert.ok((await registry.list()).some((a) => a.patientId === 'PG-ADM-1'));

  // An A03 discharge for the same patient replaces the current admission.
  await registry.register({ patientId: 'PG-ADM-1', status: 'discharged', receivedAt: new Date().toISOString() });
  assert.equal((await registry.find('PG-ADM-1'))[0]!.status, 'discharged');
});

test('Postgres dispatcher matches the registry, holds unmatched, and releases into delivery', { skip: skipReason }, async (t) => {
  if (!pool || !store || !routes) return skipTest('no pool');
  const s = store;
  const registry = new PostgresOrderRegistry(pool);
  const dispatcher = new Dispatcher({
    store: s,
    dedup: new PostgresDedupStore(pool),
    routes: routes,
    matching: { registry },
    pollMs: 5,
    sleep: () => Promise.resolve(),
  });
  dispatcher.start();
  t.after(() => dispatcher.stop());

  // No registered order → UNMATCHED → HELD (never delivered, never dropped).
  await dispatcher.record(message(HELD1));
  await waitFor(async () => (await s.get(HELD1))?.status === 'HELD');
  const held = await s.get(HELD1);
  assert.ok(held);
  assert.equal(held.match?.status, 'UNMATCHED');
  assert.ok(held.timeline.some((e) => e.stage === 'HELD'));

  // The LIS registers the order; the operator reviews and releases.
  await registry.register({
    id: `pg-ord-${HELD1}`,
    patientId: `pg-pat-${HELD1}`,
    sampleId: `S-${HELD1}`,
    tests: ['GLUCOSE'],
    status: 'active',
    receivedAt: new Date().toISOString(),
  });
  assert.equal(await dispatcher.release(HELD1), true);
  await waitFor(async () => (await s.get(HELD1))?.status === 'ROUTED');

  const routed = await s.get(HELD1);
  assert.ok(routed);
  assert.equal(routed.status, 'ROUTED');
  assert.ok(routed.timeline.some((e) => e.note?.includes('released by operator')));

  // The held filter finds it only before release — verify final state is clean.
  const heldList = await s.list({ held: true });
  assert.ok(!heldList.some((m) => m.id === HELD1));

  // Cleanup so sibling suites stay isolated.
  await registry.remove(`pg-ord-${HELD1}`);
});