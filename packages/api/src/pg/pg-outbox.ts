/** @packageDocumentation
 * D11 — PostgreSQL outbox stores (plan §7.G G4; decision D11).
 *
 * Two roles for the same table (`outbox`, migration 0015):
 *
 * - EDGE (`PostgresOutbox`): local writes append rows through {@link append}
 *   (same transaction as the source row, via the write-through helpers in
 *   outbox-write.ts); {@link OutboxSyncer} (core) reads unacked rows and acks
 *   them after the cloud applies a batch.
 *
 * - CLOUD (`PostgresIngestStore`): applies shipped batches into `ingest_ledger`
 *   (PK (facility_id, seq)) + whole-row upserts of messages/devices. A
 *   redelivered batch (edge crashed between cloud-write and edge-ack) is a
 *   no-op — the ledger insert conflicts and reports the highest seq it
 *   actually applied, so the edge ack is always truthful.
 */

import type { Pool } from 'pg';
import type { OutboxEntry, OutboxReader, OutboxWriter } from '@integration-hub/core';

// ---------------------------------------------------------------------------
// Row <-> entry mapping
// ---------------------------------------------------------------------------

interface OutboxRow {
  seq: string;
  table_name: string;
  op: string;
  pk: string;
  payload: unknown;
  org_id: string | null;
  facility_id: string | null;
  created_at: Date | string;
  acked: boolean;
}

function rowToEntry(row: OutboxRow): OutboxEntry {
  return {
    seq: Number(row.seq),
    table: row.table_name as OutboxEntry['table'],
    op: row.op as OutboxEntry['op'],
    pk: row.pk,
    payload: row.payload,
    ...(row.org_id ? { orgId: row.org_id } : {}),
    ...(row.facility_id ? { facilityId: row.facility_id } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// EDGE — reader + writer over the local outbox table
// ---------------------------------------------------------------------------

/** Edge-side outbox: appends (write-through) + the OutboxReader the syncer drives. */
export class PostgresOutbox implements OutboxReader, OutboxWriter {
  constructor(private readonly pool: Pool) {}

  /** Append one entry; returns the assigned sequence. Runs in its own
   *  transaction context when no client is passed (tests/simple paths) — the
   *  write-through passes the source-row client so both commit together. */
  async append(
    entry: Omit<OutboxEntry, 'seq' | 'createdAt'>,
    client?: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  ): Promise<number> {
    const runner = client ?? this.pool;
    const { rows } = (await runner.query(
      `INSERT INTO outbox (table_name, op, pk, payload, org_id, facility_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING seq`,
      [entry.table, entry.op, entry.pk, JSON.stringify(entry.payload ?? null), entry.orgId ?? null, entry.facilityId ?? null],
    )) as { rows: { seq: string }[] };
    return Number(rows[0]!.seq);
  }

  async listUnacked(limit: number): Promise<OutboxEntry[]> {
    const { rows } = await this.pool.query<OutboxRow>(
      `SELECT seq, table_name, op, pk, payload, org_id, facility_id, created_at, acked
       FROM outbox WHERE acked = false ORDER BY seq ASC LIMIT $1`,
      [limit],
    );
    return rows.map(rowToEntry);
  }

  async markAcked(throughSeq: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE outbox SET acked = true, acked_at = now()
       WHERE acked = false AND seq <= $1`,
      [throughSeq],
    );
    return rowCount ?? 0;
  }

  async maxSeq(): Promise<number> {
    const { rows } = await this.pool.query<{ m: string | null }>(`SELECT max(seq) AS m FROM outbox`);
    return rows[0]?.m ? Number(rows[0].m) : 0;
  }

  async pendingCount(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM outbox WHERE acked = false`);
    return Number(rows[0]!.n);
  }
}

// ---------------------------------------------------------------------------
// CLOUD — ingest: whole-row upserts of messages + devices
// ---------------------------------------------------------------------------

/** Full message row as shipped by the edge (the CanonicalMessage envelope plus
 *  the tenancy stamps). The cloud store upserts it into `messages`. */
export interface SyncedMessageRow {
  id: string;
  protocol: string;
  direction: string;
  deviceId?: string;
  receivedAt: string;
  raw: string;
  records?: unknown;
  payload?: unknown;
  imaging?: unknown;
  status: string;
  errors?: string[];
  timeline?: unknown[];
  orgId?: string;
  facilityId?: string;
}

/** Full device row as shipped by the edge (RegisterDeviceInput-ish + state). */
export interface SyncedDeviceRow {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  protocol?: string;
  transport?: string;
  host?: string;
  port?: number;
  profileId?: string;
  state?: string;
  orgId?: string;
  facilityId?: string;
}

/** Per-facility ingest cursor: the highest seq applied from each gateway. */
export interface IngestCursor {
  facilityId: string;
  maxSeq: number;
  updatedAt: string;
}

export class PostgresIngestStore {
  constructor(private readonly pool: Pool) {}/** Apply one shipped entry. Returns true when it was applied (new), false
 *  when the (facility, seq) pair was already applied (redelivery no-op). */
  async apply(entry: OutboxEntry): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Idempotency gate: claim the (facility, seq) slot first. A concurrent
      // or redelivered entry loses here and reports "already applied".
      const claim = await client.query(
        `INSERT INTO ingest_ledger (facility_id, seq, table_name, op, pk, payload, org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (facility_id, seq) DO NOTHING
         RETURNING facility_id`,
        [entry.facilityId ?? 'unassigned', entry.seq, entry.table, entry.op, entry.pk, JSON.stringify(entry.payload ?? null), entry.orgId ?? null],
      );
      if ((claim.rowCount ?? 0) === 0) {
        await client.query('COMMIT');
        return false;
      }
      if (entry.table === 'messages') {
        await this.upsertMessage(client, entry.payload as SyncedMessageRow, entry);
      } else if (entry.table === 'devices') {
        await this.upsertDevice(client, entry.payload as SyncedDeviceRow, entry);
      } else {
        throw new Error(`unknown outbox table: ${entry.table}`);
      }
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Apply a batch; returns the highest seq applied (only rows that were NEW). */
  async applyBatch(entries: OutboxEntry[]): Promise<number> {
    let appliedThrough = 0;
    for (const entry of entries) {
      const applied = await this.apply(entry);
      if (applied && entry.seq > appliedThrough) appliedThrough = entry.seq;
    }
    return appliedThrough;
  }

  /** Ingest cursors per facility (sync status visibility, H4 analytics). */
  async cursors(): Promise<IngestCursor[]> {
    const { rows } = await this.pool.query<{ facility_id: string; m: string; updated_at: Date | string }>(
      `SELECT facility_id, max(seq) AS m, max(applied_at) AS updated_at
       FROM ingest_ledger GROUP BY facility_id ORDER BY facility_id`,
    );
    return rows.map((r) => ({
      facilityId: r.facility_id,
      maxSeq: r.m ? Number(r.m) : 0,
      updatedAt: new Date(r.updated_at ?? new Date()).toISOString(),
    }));
  }

  private async upsertMessage(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    row: SyncedMessageRow,
    entry: OutboxEntry,
  ): Promise<void> {
    await client.query(
      `INSERT INTO messages (id, protocol, direction, device_id, received_at, raw,
                             records, payload, imaging, status, errors, timeline, org_id, facility_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         errors = EXCLUDED.errors,
         timeline = EXCLUDED.timeline`,
      [
        row.id,
        row.protocol,
        row.direction,
        row.deviceId ?? null,
        row.receivedAt,
        row.raw,
        JSON.stringify(row.records ?? null),
        JSON.stringify(row.payload ?? null),
        JSON.stringify(row.imaging ?? null),
        row.status,
        JSON.stringify(row.errors ?? []),
        JSON.stringify(row.timeline ?? []),
        row.orgId ?? entry.orgId ?? null,
        row.facilityId ?? entry.facilityId ?? null,
      ],
    );
  }

  private async upsertDevice(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    row: SyncedDeviceRow,
    entry: OutboxEntry,
  ): Promise<void> {
    await client.query(
      `INSERT INTO devices (id, name, manufacturer, model, protocol, transport, host, port, profile_id, state, auto_registered, org_id, facility_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         state = EXCLUDED.state,
         last_seen = now()`,
      [
        row.id,
        row.name,
        row.manufacturer ?? null,
        row.model ?? null,
        row.protocol ?? 'ASTM',
        row.transport ?? 'tcp',
        row.host ?? null,
        row.port ?? null,
        row.profileId ?? null,
        row.state ?? 'unknown',
        row.orgId ?? entry.orgId ?? null,
        row.facilityId ?? entry.facilityId ?? null,
      ],
    );
  }
}
