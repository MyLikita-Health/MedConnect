/**
 * W1 — SQLite edge-backend contract tests (D12, docs/windows-desktop-installer.md §8.1).
 * No Docker, no server: pure better-sqlite3 over a temp file.
 *
 * Covers every seam the hub uses locally: message lifecycle + mappings, device
 * registry, routing, dedup, matching registries, alerts, profiles, webhooks,
 * keys/audit, the D11 outbox (write-through + reader/ack) — and persistence
 * across close/reopen with migrations NOT re-applied.
 */
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';

import type { CanonicalMessage } from '@integration-hub/shared';
import {
  openSqliteDatabase,
  SqliteMessageStore,
  SqliteDeviceRegistry,
  SqliteRouteStore,
  SqliteDedupStore,
  SqliteOrderRegistry,
  SqliteAdmissionRegistry,
  SqliteAlertStore,
  SqliteProfileStore,
  SqliteWebhookStore,
  SqliteKeyStore,
  SqliteAuditStore,
  SqliteOutbox,
  runSqliteMigrations,
  type SqliteDb,
} from './index.js';
import { REFERENCE_PROFILE, parseDeviceProfile } from '@integration-hub/core';

let dir: string;
let file: string;
let db: SqliteDb;
let store: SqliteMessageStore;
let devices: SqliteDeviceRegistry;
let outbox: SqliteOutbox;

function msg(overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    protocol: 'ASTM',
    direction: 'inbound',
    deviceId: 'analyzer-1',
    receivedAt: new Date().toISOString(),
    raw: 'H|\\^&|||Analyzer^1\r\nP|1||P1||Doe^John||19700101|M\r\nR|1|^^^GLU|100|mg/dL|70-99|N||F||Operator\r\nL|1',
    records: [],
    status: 'RECEIVED',
    errors: [],
    timeline: [{ stage: 'RECEIVED', at: new Date().toISOString() }],
    ...overrides,
  } as CanonicalMessage;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-sqlite-'));
  file = join(dir, 'hub.sqlite');
  db = openSqliteDatabase((f) => new BetterSqlite3(f), file);
  store = new SqliteMessageStore(db);
  devices = new SqliteDeviceRegistry(db);
  outbox = new SqliteOutbox(db);
  store.outbox = outbox;
  devices.outbox = outbox;
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('message lifecycle: record → list/get → mark/DLQ → stats', () => {
  const m = msg();
  store.record(m);
  assert.equal(store.get(m.id)?.id, m.id);
  assert.equal(store.list({ deviceId: 'analyzer-1' })[0]?.id, m.id);
  assert.equal(store.list().length, 1);

  store.mark(m.id, 'MAPPED', 'matched by order id', {
    match: { status: 'MATCHED', matchedOrderId: 'ORD-1', strategy: 'orderId', at: new Date().toISOString() },
  });
  const matched = store.get(m.id);
  assert.equal(matched?.status, 'MAPPED');
  assert.equal(matched?.match?.matchedOrderId, 'ORD-1');
  assert.equal(matched?.timeline.filter((t) => t.stage === 'MAPPED').length, 1);

  store.mark(m.id, 'FAILED', 'delivery exhausted', { dlqAt: new Date().toISOString() });
  const failed = store.get(m.id);
  assert.ok(failed?.dlqAt);
  assert.equal(store.list({ dlq: true }).length, 1);
  store.mark(m.id, 'FAILED', 'clear', { clearDlq: true });
  assert.equal(store.list({ dlq: true }).length, 0);

  store.mark(m.id, 'HELD', 'unmatched');
  assert.equal(store.list({ held: true }).length, 1);

  const stats = store.stats();
  assert.equal(stats.total >= 1, true);
  assert.equal(stats.byStatus['HELD'], 1);
});

test('clinical payload persistence mirrors the PG shape', () => {
  const m = msg({
    payload: {
      patient: { id: 'P9', name: 'Doe, Jane', dateOfBirth: '1980-02-02', gender: 'F' },
      order: { id: 'ORD-9', sampleId: 'S-9', tests: [{ code: 'GLUCOSE' }] },
      results: [
        { testCode: 'GLUCOSE', value: '99', unit: 'mg/dL', flag: 'N', status: 'F' },
        { testCode: 'CREATININE', value: '1.0', unit: 'mg/dL', status: 'F' },
      ],
    },
  } as Partial<CanonicalMessage>);
  store.record(m);
  const patients = db.prepare(`SELECT * FROM patients WHERE id = 'P9'`).all();
  const orders = db.prepare(`SELECT * FROM orders WHERE id = 'ORD-9'`).all();
  const results = db.prepare(`SELECT * FROM results WHERE message_id = ?`).all(m.id);
  assert.equal(patients.length, 1);
  assert.equal(orders.length, 1);
  assert.equal(results.length, 2);
  const orderTests = JSON.parse((orders[0] as { tests: string }).tests) as { code: string }[];
  assert.equal(orderTests[0]?.code, 'GLUCOSE');
});

test('mappings: set then get round-trips (global table)', () => {
  const written = store.setMappings({ GLU: 'GLUCOSE', CREA: 'CREATININE' });
  assert.equal(written['GLU'], 'GLUCOSE');
  const read = store.getMappings();
  assert.equal(read['CREA'], 'CREATININE');
});

test('attempts persist and read back oldest-first', () => {
  const m = msg();
  store.record(m);
  store.recordAttempt({ messageId: m.id, destinationId: 'console', attempt: 1, status: 'FAILED', error: 'boom', at: new Date().toISOString() });
  store.recordAttempt({ messageId: m.id, destinationId: 'console', attempt: 2, status: 'OK', at: new Date().toISOString() });
  const attempts = store.attemptsFor(m.id);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.attempt, 1);
  assert.equal(attempts[1]!.status, 'OK');
});

test('device registry: register, upsertFromConnection, stats, remove', () => {
  const d = devices.register({ id: 'analyzer-1', name: 'ACME Chem 200', protocol: 'ASTM', transport: 'tcp', port: 5100 });
  assert.equal(d.id, 'analyzer-1');
  const seen = devices.upsertFromConnection({ id: 'analyzer-1', state: 'connected' });
  assert.equal(seen.state, 'connected');
  assert.ok(seen.lastSeen);
  const auto = devices.upsertFromConnection({ id: 'auto-1', name: 'New Analyzer', state: 'connected' });
  assert.equal(auto.autoRegistered, true);
  const stats = devices.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.connected, 2);
  assert.equal(devices.remove('auto-1'), true);
  assert.equal(devices.remove('auto-1'), false);
  assert.equal(devices.list().length, 1);
});

test('routing: destinations + rules round-trip', async () => {
  const routes = new SqliteRouteStore(db);
  await routes.upsertDestination({ id: 'lis', kind: 'http', name: 'LIS', url: 'https://lis.internal/hook', enabled: true, retry: { maxAttempts: 2, backoffMs: 10, backoffFactor: 2, jitter: false } });
  await routes.upsertRule({ id: 'r1', destinationId: 'lis', priority: 1, enabled: true });
  const destinations = await routes.listDestinations();
  assert.equal(destinations.length, 1);
  assert.ok(destinations[0]!.retry); // DEFAULT_RETRY applied when null
  assert.equal((await routes.listRules())[0]!.destinationId, 'lis');
  await routes.deleteRule('r1');
  await routes.deleteDestination('lis');
  assert.equal((await routes.listDestinations()).length, 0);
});

test('dedup: find/add + expiry', async () => {
  let now = 1_000_000;
  const dedup = new SqliteDedupStore(db, () => now);
  await dedup.add('k1', 'm1', 5_000);
  assert.equal(await dedup.find('k1'), 'm1');
  now += 6_000;
  assert.equal(await dedup.find('k1'), undefined); // expired
  await dedup.add('k1', 'm2', 5_000);
  assert.equal(await dedup.find('k1'), 'm2'); // upsert replaces
});

test('matching registries: orders + admissions', async () => {
  const orders = new SqliteOrderRegistry(db);
  await orders.register({ id: 'ORD-1', patientId: 'P1', sampleId: 'S1', tests: ['GLUCOSE'], status: 'active', receivedAt: new Date().toISOString() });
  const found = await orders.find({ patientId: 'P1', orderId: 'ORD-1' });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]!.tests, ['GLUCOSE']);
  assert.equal((await orders.list()).length, 1);
  await orders.remove('ORD-1');
  assert.equal((await orders.list()).length, 0);

  const admissions = new SqliteAdmissionRegistry(db);
  await admissions.register({ patientId: 'P1', name: 'Doe, John', status: 'admitted', receivedAt: new Date().toISOString() });
  const admitted = await admissions.find('P1');
  assert.equal(admitted.length, 1);
  await admissions.register({ patientId: 'P1', status: 'discharged', receivedAt: new Date().toISOString() });
  assert.equal((await admissions.find('P1'))[0]!.status, 'discharged');
});

test('alerts: rules + fire/resolve lifecycle', async () => {
  const alerts = new SqliteAlertStore(db);
  await alerts.upsertRule({ id: 'dlq-growth', kind: 'dlq', name: 'DLQ growing', threshold: 3, channels: ['console'], enabled: true });
  assert.equal((await alerts.listRules()).length, 1);
  const record = {
    id: 'a1', ruleId: 'dlq-growth', kind: 'dlq' as const, subject: 'edge',
    message: 'DLQ at 4', status: 'FIRING' as const, firedAt: new Date().toISOString(), count: 4,
  };
  await alerts.fire(record);
  const open = await alerts.openAlert('dlq-growth', 'edge');
  assert.equal(open?.id, 'a1');
  assert.equal(await alerts.resolveOpen('dlq-growth', 'edge'), true);
  assert.equal(await alerts.resolveOpen('dlq-growth', 'edge'), false);
  const list = await alerts.listAlerts();
  assert.equal(list[0]!.status, 'RESOLVED');
  assert.ok(list[0]!.resolvedAt);
  await alerts.deleteRule('dlq-growth');
  assert.equal((await alerts.listRules()).length, 0);
});

test('profiles: upsert validates on write AND read-back', async () => {
  const profiles = new SqliteProfileStore(db);
  await profiles.upsert(REFERENCE_PROFILE);
  const got = await profiles.get('astm-reference');
  assert.equal(got?.id, 'astm-reference');
  assert.equal(got?.status, 'certified');
  // Corrupt row fails LOUDLY on read (read-back validation, pg-profiles pattern).
  db.prepare(`UPDATE profiles SET profile = '{not json' WHERE id = 'astm-reference'`).run();
  await assert.rejects(() => profiles.get('astm-reference'), SyntaxError);
  db.prepare(`DELETE FROM profiles WHERE id = 'astm-reference'`).run();
  await profiles.upsert(parseDeviceProfile(REFERENCE_PROFILE));
  await profiles.remove('astm-reference');
  assert.equal(await profiles.get('astm-reference'), undefined);
});

test('webhook subscriptions: write-through + validated read-back', async () => {
  const webhooks = new SqliteWebhookStore(db);
  await webhooks.upsert({
    id: 'sub-1', name: 'LIS hook', url: 'https://lis.internal/hook', secret: 's3cret',
    events: '*', enabled: true, createdAt: new Date().toISOString(),
  });
  const subs = await webhooks.list();
  assert.equal(subs.length, 1);
  assert.equal(subs[0]!.secret, 's3cret');
  await webhooks.remove('sub-1');
  assert.equal((await webhooks.list()).length, 0);
});

test('keys: create → findBySecret → rotate revokes old → update/remove/touch', () => {
  const keys = new SqliteKeyStore(db);
  const { key, secret } = keys.create({ id: 'admin', name: 'Administrator', role: 'admin' });
  assert.ok(secret.length >= 20);
  assert.equal(keys.findBySecret(secret)?.id, 'admin');
  const rotated = keys.rotateSecret('admin');
  assert.ok(rotated && rotated.secret !== secret);
  assert.equal(keys.findBySecret(secret), undefined); // old secret revoked
  assert.equal(keys.findBySecret(rotated.secret)?.id, 'admin');
  const patched = keys.update('admin', { name: 'Admin', enabled: false });
  assert.equal(patched?.enabled, false);
  assert.equal(keys.findBySecret(rotated.secret), undefined); // disabled keys don't auth
  keys.update('admin', { enabled: true });
  keys.touch('admin');
  assert.ok(keys.get('admin')?.lastUsedAt);
  keys.remove('admin');
  assert.equal(keys.get('admin'), undefined);
});

test('audit: append + newest-first list + result filter', () => {
  const audit = new SqliteAuditStore(db);
  audit.append({ actorKey: 'admin', actorName: 'Administrator', actorRole: 'admin', action: 'messages.list', result: 'ok', statusCode: 200 });
  audit.append({ actorKey: 'admin', action: 'keys.rotate', result: 'denied', statusCode: 403 });
  const all = audit.list();
  assert.equal(all.length, 2);
  assert.equal(all[0]!.action, 'keys.rotate');
  assert.equal(audit.list({ result: 'denied' }).length, 1);
});

test('outbox: write-through appends in the same transaction; reader + ack work', () => {
  // Drains acked rows so this test's expectations are exact.
  outbox.markAcked(outbox.maxSeq());
  const before = outbox.pendingCount();
  assert.equal(before, 0);
  const m = msg();
  store.record(m); // store has outbox attached → entry must appear
  assert.equal(outbox.pendingCount(), before + 1);
  const entries = outbox.listUnacked(10);
  const last = entries[entries.length - 1]!;
  assert.equal(last.table, 'messages');
  assert.equal(last.op, 'INSERT');
  assert.equal(last.pk, m.id);
  assert.equal((last.payload as { id: string }).id, m.id);
  const ackedCount = outbox.markAcked(last.seq);
  assert.ok(ackedCount >= 1);
  assert.equal(outbox.pendingCount(), before);
  assert.equal(outbox.maxSeq() >= last.seq, true);

  // Device write-through: register → devices entry
  outbox.markAcked(outbox.maxSeq());
  const beforeDevices = outbox.pendingCount();
  devices.register({ id: 'dev-sync', name: 'Synced Device' });
  assert.equal(outbox.pendingCount(), beforeDevices + 1);
  const deviceEntry = outbox.listUnacked(10).find((e) => e.table === 'devices' && e.pk === 'dev-sync');
  assert.ok(deviceEntry);
});

test('persistence across close/reopen: data intact, migrations not re-applied', () => {
  const m = msg();
  store.record(m);
  devices.register({ id: 'persistent-1', name: 'Persistent Device' });
  const appliedBefore = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version),
  );
  db.close();

  const reopened = openSqliteDatabase((f) => new BetterSqlite3(f), file);
  const reopenedStore = new SqliteMessageStore(reopened);
  assert.equal(reopenedStore.get(m.id)?.id, m.id);
  const reopenedDevices = new SqliteDeviceRegistry(reopened);
  assert.ok(reopenedDevices.get('persistent-1'));
  // Migrations re-run must be a no-op (idempotent runner).
  const appliedAfter = new Set(
    (reopened.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version),
  );
  assert.deepEqual(appliedAfter, appliedBefore);
  // And re-running the runner returns no applied versions.
  assert.deepEqual(runSqliteMigrations(reopened), []);
  reopened.close();
});
