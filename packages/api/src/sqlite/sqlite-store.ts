/** @packageDocumentation
 * W1 — SQLite-backed message store (D12; same seam as pg/pg-store.ts).
 *
 * Implements `StoreBackend` + `MessageSink` over the embedded SQLite file.
 * better-sqlite3 is synchronous; the contracts accept `void | Promise<void>`
 * so the sync impls drop straight in — the API layer awaits either way.
 *
 * D11 write-through: `record` wraps the message insert AND the outbox append
 * in one `db.transaction(...)` — the no-dual-write invariant holds by
 * construction (a committed message is always a pending sync entry). `mark`
 * write-through is best-effort (never fails a lifecycle transition), matching
 * the PG semantics.
 */
import type {
  CanonicalMessage,
  LabPayload,
  MappingTable,
  MessageAttempt,
  MessageSink,
  MessageStatus,
} from '@integration-hub/shared';
import type { OutboxWriter } from '@integration-hub/core';
import type { MarkFields, StoreBackend } from '../backend.js';
import type { MessageFilter, StoreStats } from '../store.js';
import type { SqliteDb } from './schema.js';

interface MessageRow {
  id: string;
  protocol: string;
  direction: string;
  device_id: string | null;
  received_at: string;
  raw: string;
  records: string | null;
  payload: string | null;
  imaging: string | null;
  status: string;
  errors: string;
  timeline: string;
  dlq_at: string | null;
  duplicate_of: string | null;
  match_status: string | null;
  matched_order_id: string | null;
  matched_patient_id: string | null;
  match_strategy: string | null;
  match_at: string | null;
  match_reason: string | null;
  org_id: string | null;
  facility_id: string | null;
}

const PENDING_STATUSES: MessageStatus[] = ['RECEIVED', 'QUEUED', 'DELIVERING'];

/** Row -> CanonicalMessage (mirrors pg-store's rowToMessage). */
function rowToMessage(row: MessageRow): CanonicalMessage {
  return {
    id: row.id,
    protocol: row.protocol as CanonicalMessage['protocol'],
    direction: row.direction as CanonicalMessage['direction'],
    deviceId: row.device_id ?? undefined,
    receivedAt: row.received_at,
    raw: row.raw,
    records: row.records ? (JSON.parse(row.records) as CanonicalMessage['records']) : undefined,
    payload: row.payload ? (JSON.parse(row.payload) as CanonicalMessage['payload']) : undefined,
    imaging: row.imaging ? (JSON.parse(row.imaging) as CanonicalMessage['imaging']) : undefined,
    status: row.status as MessageStatus,
    errors: JSON.parse(row.errors) as string[],
    timeline: JSON.parse(row.timeline) as CanonicalMessage['timeline'],
    dlqAt: row.dlq_at ?? undefined,
    duplicateOf: row.duplicate_of ?? undefined,
    match:
      row.match_status !== null
        ? {
            status: row.match_status as NonNullable<CanonicalMessage['match']>['status'],
            matchedOrderId: row.matched_order_id ?? undefined,
            matchedPatientId: row.matched_patient_id ?? undefined,
            strategy: row.match_strategy as NonNullable<CanonicalMessage['match']>['strategy'],
            at: row.match_at ?? '',
            reason: row.match_reason ?? undefined,
          }
        : undefined,
    orgId: row.org_id ?? undefined,
    facilityId: row.facility_id ?? undefined,
  } as CanonicalMessage;
}

export class SqliteMessageStore implements StoreBackend, MessageSink {
  readonly kind = 'sqlite' as const;

  /** D11 write-through (see OutboxWriter). Present on a paired edge. */
  outbox?: { append: OutboxWriter['append'] };
  /** H1/W4 tenancy stamps — null on a single-tenant edge. */
  tenancy?: { orgId: string; facilityId: string };

  constructor(private readonly db: SqliteDb) {}

  record(message: CanonicalMessage): void {
    const insert = this.db.prepare(
      `INSERT INTO messages (id, protocol, direction, device_id, received_at, raw,
                             records, payload, imaging, status, errors, timeline, org_id, facility_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         status = excluded.status, errors = excluded.errors, timeline = excluded.timeline`,
    );
    const apply = this.db.transaction(() => {
      insert.run(
        message.id,
        message.protocol,
        message.direction,
        message.deviceId ?? null,
        message.receivedAt,
        message.raw,
        JSON.stringify(message.records ?? null),
        JSON.stringify(message.payload ?? null),
        JSON.stringify(message.imaging ?? null),
        message.status,
        JSON.stringify(message.errors),
        JSON.stringify(message.timeline),
        message.orgId ?? this.tenancy?.orgId ?? null,
        message.facilityId ?? this.tenancy?.facilityId ?? null,
      );
      if (message.payload) insertClinical(this.db, message.id, message.payload as LabPayload);
      if (this.outbox) {
        this.outbox.append(
          {
            table: 'messages',
            op: 'INSERT',
            pk: message.id,
            payload: messageToSyncRow(message, this.tenancy),
            ...(this.tenancy ?? {}),
          },
          // better-sqlite3 is sync: there is no separate client handle; the
          // transaction() above IS the same-transaction guarantee.
        );
      }
    });
    apply();
  }

  /** Newest first (mirrors the memory store's list). */
  list(filter: MessageFilter = {}): CanonicalMessage[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.deviceId) {
      clauses.push('device_id = ?');
      params.push(filter.deviceId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.dlq) clauses.push('dlq_at IS NOT NULL');
    if (filter.held) clauses.push(`status = 'HELD'`);
    const limit = Math.min(filter.limit ?? 100, 500);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM messages ${where} ORDER BY received_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  get(id: string): CanonicalMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  mark(id: string, status: MessageStatus, note?: string, fields?: MarkFields): void {
    // SQLite appends ONE json value per json_insert path — pass the entry
    // object (PG concats the jsonb array wholesale; same resulting timeline).
    const entry = JSON.stringify({ stage: status, at: new Date().toISOString(), note });
    const info = this.db
      .prepare(
        `UPDATE messages
         SET status = ?,
             dlq_at = CASE WHEN ? THEN NULL ELSE COALESCE(?, dlq_at) END,
             duplicate_of = COALESCE(?, duplicate_of),
             match_status = COALESCE(?, match_status),
             matched_order_id = COALESCE(?, matched_order_id),
             matched_patient_id = COALESCE(?, matched_patient_id),
             match_strategy = COALESCE(?, match_strategy),
             match_at = COALESCE(?, match_at),
             match_reason = COALESCE(?, match_reason),
             timeline = json_insert(COALESCE(timeline, json('[]')), '$[#]', json(?))
         WHERE id = ?`,
      )
      .run(
        status,
        fields?.clearDlq ? 1 : 0,
        fields?.dlqAt ?? null,
        fields?.duplicateOf ?? null,
        fields?.match?.status ?? null,
        fields?.match?.matchedOrderId ?? null,
        fields?.match?.matchedPatientId ?? null,
        fields?.match?.strategy ?? null,
        fields?.match?.at ?? null,
        fields?.match?.reason ?? null,
        entry,
        id,
      );
    if (info.changes === 0) return;
    // D11 write-through (best-effort, matching pg-store): ship the status
    // change as a full-row UPDATE so the cloud copy converges.
    if (this.outbox) {
      const updated = this.get(id);
      if (updated) {
        this.outbox.append({
          table: 'messages',
          op: 'UPDATE',
          pk: id,
          payload: messageToSyncRow(updated, this.tenancy),
          ...(this.tenancy ?? {}),
        });
      }
    }
  }

  recordAttempt(attempt: MessageAttempt): void {
    this.db
      .prepare(
        `INSERT INTO message_attempts (message_id, destination_id, attempt, status, error, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(attempt.messageId, attempt.destinationId, attempt.attempt, attempt.status, attempt.error ?? null, attempt.at);
  }

  /** Read one message's delivery attempts, oldest first (memory-store parity helper). */
  attemptsFor(messageId: string): MessageAttempt[] {
    const rows = this.db
      .prepare(
        `SELECT message_id, destination_id, attempt, status, error, at
         FROM message_attempts WHERE message_id = ? ORDER BY id ASC`,
      )
      .all(messageId) as unknown as { message_id: string; destination_id: string; attempt: number; status: string; error: string | null; at: string }[];
    return rows.map((r) => ({
      messageId: r.message_id,
      destinationId: r.destination_id,
      attempt: r.attempt,
      status: r.status as MessageAttempt['status'],
      error: r.error ?? undefined,
      at: r.at,
    }));
  }

  stats(): StoreStats {
    const today = new Date().toISOString().slice(0, 10);
    const byStatus: Record<string, number> = {};
    let total = 0;
    let todayCount = 0;
    let pending = 0;
    const rows = this.db
      .prepare(`SELECT status, received_at FROM messages`)
      .all() as unknown as { status: string; received_at: string }[];
    for (const row of rows) {
      total++;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      if (row.received_at.startsWith(today)) todayCount++;
      if ((PENDING_STATUSES as string[]).includes(row.status)) pending++;
    }
    return { total, today: todayCount, failed: byStatus['FAILED'] ?? 0, pending, byStatus };
  }

  /** Global (device_id NULL) test-code mappings; per-device overrides merge on top. */
  getMappings(): MappingTable {
    const rows = this.db
      .prepare(`SELECT device_id, device_code, canonical_code FROM test_mappings`)
      .all() as unknown as { device_id: string | null; device_code: string; canonical_code: string }[];
    const table: MappingTable = {};
    for (const row of rows) table[row.device_code] = row.canonical_code;
    return table;
  }

  setMappings(mappings: MappingTable): MappingTable {
    const upsert = this.db.prepare(
      `INSERT INTO test_mappings (device_id, device_code, canonical_code) VALUES (NULL, ?, ?)
       ON CONFLICT (device_id, device_code) DO UPDATE SET canonical_code = excluded.canonical_code`,
    );
    const apply = this.db.transaction(() => {
      for (const [deviceCode, canonicalCode] of Object.entries(mappings)) upsert.run(deviceCode, canonicalCode);
    });
    apply();
    return this.getMappings();
  }
}

/** Persist canonical clinical rows (patients/orders upsert, results append)
 *  — mirrors pg-store's insertClinical. */
function insertClinical(db: SqliteDb, messageId: string, p: LabPayload): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO patients (id, name, date_of_birth, gender, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, date_of_birth = excluded.date_of_birth, gender = excluded.gender,
       last_seen = excluded.last_seen`,
  ).run(p.patient.id, p.patient.name ?? null, p.patient.dateOfBirth ?? null, p.patient.gender ?? null, now, now);
  db.prepare(
    `INSERT INTO orders (id, patient_id, sample_id, tests, message_id, received_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       sample_id = excluded.sample_id, tests = excluded.tests, message_id = excluded.message_id`,
  ).run(
    p.order.id,
    p.patient.id,
    p.order.sampleId ?? null,
    JSON.stringify(p.order.tests),
    messageId,
    now,
  );
  for (const r of p.results) {
    db.prepare(
      `INSERT INTO results (order_id, message_id, test_code, original_test_code, test_name,
                            value, unit, reference_range, flag, status, measured_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.order.id,
      messageId,
      r.testCode,
      r.originalTestCode ?? null,
      r.testName ?? null,
      r.value,
      r.unit ?? null,
      r.referenceRange ?? null,
      r.flag ?? null,
      r.status ?? null,
      r.measuredAt ?? null,
      now,
    );
  }
}

/** CanonicalMessage -> the D11 sync payload (mirrors pg-store's messageToSyncRow). */
function messageToSyncRow(
  message: CanonicalMessage,
  tenancy?: { orgId: string; facilityId: string },
): Record<string, unknown> {
  return {
    id: message.id,
    protocol: message.protocol,
    direction: message.direction,
    deviceId: message.deviceId,
    receivedAt: message.receivedAt,
    raw: message.raw,
    records: message.records,
    payload: message.payload,
    imaging: message.imaging,
    status: message.status,
    errors: message.errors,
    timeline: message.timeline,
    orgId: message.orgId ?? tenancy?.orgId,
    facilityId: message.facilityId ?? tenancy?.facilityId,
  };
}
