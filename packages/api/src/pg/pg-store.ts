/**
 * PostgreSQL-backed message store (plan §13: replace the in-memory ring,
 * keep the `MessageSink` contract as the seam). Phase-1 entities from §5.1:
 * messages + canonical patients/orders/results, stored in one transaction.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  CanonicalMessage,
  ImagingPayload,
  LabPayload,
  MappingTable,
  MessageAttempt,
  MessageMatch,
  MessageSink,
  MessageStatus,
  ParsedRecord,
  TimelineEntry,
} from '@integration-hub/shared';
import type { MarkFields, StoreBackend } from '../backend.js';
import type { MessageFilter, StoreStats } from '../store.js';

const MESSAGE_COLUMNS = `id, protocol, direction, device_id, received_at, raw, records, payload, imaging, status, errors, timeline, dlq_at, duplicate_of, match_status, matched_order_id, matched_patient_id, match_strategy, match_at, match_reason`;

interface MessageRow {
  id: string;
  protocol: string;
  direction: string;
  device_id: string | null;
  received_at: Date | string;
  raw: string;
  records: unknown;
  payload: unknown;
  imaging: unknown;
  status: string;
  errors: unknown;
  timeline: unknown;
  dlq_at: Date | string | null;
  duplicate_of: string | null;
  match_status: string | null;
  matched_order_id: string | null;
  matched_patient_id: string | null;
  match_strategy: string | null;
  match_at: Date | string | null;
  match_reason: string | null;
}

export class PostgresMessageStore implements MessageSink, StoreBackend {
  readonly kind = 'postgres' as const;

  constructor(private readonly pool: Pool) {}

  /** Persist a pipeline message plus its canonical clinical rows, atomically. */
  async record(message: CanonicalMessage): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO messages (id, protocol, direction, device_id, received_at, raw,
                              records, payload, imaging, status, errors, timeline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
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
        ],
      );
      if (message.payload) await insertClinical(client, message.id, message.payload);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async list(filter: MessageFilter = {}): Promise<CanonicalMessage[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.deviceId) {
      params.push(filter.deviceId);
      clauses.push(`device_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    if (filter.dlq) clauses.push(`dlq_at IS NOT NULL`);
    if (filter.held) clauses.push(`status = 'HELD'`);
    const limit = Math.min(filter.limit ?? 100, 500);
    params.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages ${where}
       ORDER BY received_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(rowToMessage);
  }

  /** Advance the lifecycle (plan §5.3): update status + markers, append a timeline entry. */
  async mark(id: string, status: MessageStatus, note?: string, fields?: MarkFields): Promise<void> {
    const entry = JSON.stringify([{ stage: status, at: new Date().toISOString(), note }]);
    await this.pool.query(
      `UPDATE messages
       SET status = $2,
           dlq_at = COALESCE($3, dlq_at),
           duplicate_of = COALESCE($4, duplicate_of),
           match_status = COALESCE($6, match_status),
           matched_order_id = COALESCE($7, matched_order_id),
           matched_patient_id = COALESCE($8, matched_patient_id),
           match_strategy = COALESCE($9, match_strategy),
           match_at = COALESCE($10, match_at),
           match_reason = COALESCE($11, match_reason),
           timeline = timeline || $5::jsonb
       WHERE id = $1`,
      [
        id,
        status,
        fields?.dlqAt ?? null,
        fields?.duplicateOf ?? null,
        entry,
        fields?.match?.status ?? null,
        fields?.match?.matchedOrderId ?? null,
        fields?.match?.matchedPatientId ?? null,
        fields?.match?.strategy ?? null,
        fields?.match?.at ?? null,
        fields?.match?.reason ?? null,
      ],
    );
  }

  async recordAttempt(attempt: MessageAttempt): Promise<void> {
    await this.pool.query(
      `INSERT INTO message_attempts (message_id, destination_id, attempt, status, error)
       VALUES ($1,$2,$3,$4,$5)`,
      [attempt.messageId, attempt.destinationId, attempt.attempt, attempt.status, attempt.error ?? null],
    );
  }

  async get(id: string): Promise<CanonicalMessage | undefined> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? rowToMessage(row) : undefined;
  }

  async stats(): Promise<StoreStats> {
    const { rows } = await this.pool.query<{ status: string; n: number; today: number }>(
      `SELECT status, count(*)::int AS n,
              count(*) FILTER (WHERE received_at >= date_trunc('day', now()))::int AS today
       FROM messages GROUP BY status`,
    );
    let total = 0;
    let today = 0;
    let pending = 0;
    const byStatus: Record<string, number> = {};
    for (const row of rows) {
      total += row.n;
      today += row.today;
      byStatus[row.status] = row.n;
      if (row.status === 'RECEIVED' || row.status === 'QUEUED' || row.status === 'DELIVERING') pending += row.n;
    }
    return {
      total,
      today,
      failed: byStatus['FAILED'] ?? 0,
      pending,
      byStatus,
    };
  }

  /** Global (device_id NULL) test-code mappings; per-device overrides merge on top. */
  async getMappings(): Promise<MappingTable> {
    const { rows } = await this.pool.query<{ device_code: string; canonical_code: string }>(
      `SELECT device_code, canonical_code FROM test_mappings`,
    );
    const table: MappingTable = {};
    for (const row of rows) table[row.device_code] = row.canonical_code;
    return table;
  }

  /** Upsert mappings (seeding defaults); returns the merged table. */
  async setMappings(mappings: MappingTable): Promise<MappingTable> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [deviceCode, canonicalCode] of Object.entries(mappings)) {
        await client.query(
          `INSERT INTO test_mappings (device_id, device_code, canonical_code) VALUES (NULL, $1, $2)
           ON CONFLICT (device_id, device_code) DO UPDATE SET canonical_code = EXCLUDED.canonical_code`,
          [deviceCode, canonicalCode],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return this.getMappings();
  }
}

async function insertClinical(client: PoolClient, messageId: string, p: LabPayload): Promise<void> {
  await client.query(
    `INSERT INTO patients (id, name, date_of_birth, gender)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       date_of_birth = EXCLUDED.date_of_birth,
       gender = EXCLUDED.gender,
       last_seen = now()`,
    [p.patient.id, p.patient.name ?? null, p.patient.dateOfBirth ?? null, p.patient.gender ?? null],
  );
  await client.query(
    `INSERT INTO orders (id, patient_id, sample_id, tests, message_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET
       sample_id = EXCLUDED.sample_id,
       tests = EXCLUDED.tests,
       message_id = EXCLUDED.message_id`,
    [p.order.id, p.patient.id, p.order.sampleId ?? null, JSON.stringify(p.order.tests), messageId],
  );
  for (const r of p.results) {
    await client.query(
      `INSERT INTO results (order_id, message_id, test_code, original_test_code, test_name,
                            value, unit, reference_range, flag, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
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
      ],
    );
  }
}

function rowToMessage(row: MessageRow): CanonicalMessage {
  return {
    id: row.id,
    protocol: row.protocol as CanonicalMessage['protocol'],
    direction: row.direction as CanonicalMessage['direction'],
    deviceId: row.device_id ?? undefined,
    receivedAt: new Date(row.received_at).toISOString(),
    raw: row.raw,
    records: (row.records as ParsedRecord[] | null) ?? undefined,
    payload: (row.payload as LabPayload | null) ?? undefined,
    imaging: (row.imaging as ImagingPayload | null) ?? undefined,
    status: row.status as CanonicalMessage['status'],
    errors: (row.errors as string[]) ?? [],
    timeline: (row.timeline as TimelineEntry[]) ?? [],
    dlqAt: row.dlq_at ? new Date(row.dlq_at).toISOString() : undefined,
    duplicateOf: row.duplicate_of ?? undefined,
    match: row.match_status
      ? {
          status: row.match_status as MessageMatch['status'],
          matchedOrderId: row.matched_order_id ?? undefined,
          matchedPatientId: row.matched_patient_id ?? undefined,
          strategy: row.match_strategy ?? undefined,
          reason: row.match_reason ?? undefined,
          at: new Date(row.match_at ?? new Date()).toISOString(),
        }
      : undefined,
  };
}