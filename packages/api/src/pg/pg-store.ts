/**
 * PostgreSQL-backed message store (plan §13: replace the in-memory ring,
 * keep the `MessageSink` contract as the seam). Phase-1 entities from §5.1:
 * messages + canonical patients/orders/results, stored in one transaction.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  CanonicalMessage,
  LabPayload,
  MappingTable,
  MessageSink,
  ParsedRecord,
  TimelineEntry,
} from '@integration-hub/shared';
import type { StoreBackend } from '../backend.js';
import type { MessageFilter, StoreStats } from '../store.js';

const MESSAGE_COLUMNS = `id, protocol, direction, device_id, received_at, raw, records, payload, status, errors, timeline`;

interface MessageRow {
  id: string;
  protocol: string;
  direction: string;
  device_id: string | null;
  received_at: Date | string;
  raw: string;
  records: unknown;
  payload: unknown;
  status: string;
  errors: unknown;
  timeline: unknown;
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
        `INSERT INTO messages (${MESSAGE_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          message.id,
          message.protocol,
          message.direction,
          message.deviceId ?? null,
          message.receivedAt,
          message.raw,
          JSON.stringify(message.records ?? null),
          JSON.stringify(message.payload ?? null),
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
    const byStatus: Record<string, number> = {};
    for (const row of rows) {
      total += row.n;
      today += row.today;
      byStatus[row.status] = row.n;
    }
    return {
      total,
      today,
      failed: byStatus['FAILED'] ?? 0,
      pending: byStatus['RECEIVED'] ?? 0,
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
    status: row.status as CanonicalMessage['status'],
    errors: (row.errors as string[]) ?? [],
    timeline: (row.timeline as TimelineEntry[]) ?? [],
  };
}