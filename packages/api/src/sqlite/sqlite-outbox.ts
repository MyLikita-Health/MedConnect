/** @packageDocumentation
 * W1 — SQLite outbox (D11 edge role; cloud ingest stays PG — the cloud side
 * is Postgres by design, D12). Same `OutboxReader`/`OutboxWriter` contracts as
 * `PostgresOutbox`, so `OutboxSyncer` (core) drives either backend unchanged:
 * the paired-edge sync story is one code path for a PG edge and a SQLite edge.
 *
 * AUTOINCREMENT `seq` = the PG bigserial; `acked` 0/1 = the PG boolean. The
 * append runs inside the caller's better-sqlite3 transaction when invoked from
 * a store write-through (same-connection sync execution = same transaction);
 * standalone appends auto-commit.
 */
import type BetterSqlite3 from 'better-sqlite3';
import type { OutboxEntry, OutboxReader, OutboxWriter } from '@integration-hub/core';
import type { SqliteDb } from './schema.js';

interface OutboxRow {
  seq: number;
  table_name: string;
  op: string;
  pk: string;
  payload: string | null;
  org_id: string | null;
  facility_id: string | null;
  acked: number;
  created_at: string;
}

function rowToEntry(row: OutboxRow): OutboxEntry {
  return {
    seq: Number(row.seq),
    table: row.table_name as OutboxEntry['table'],
    op: row.op as OutboxEntry['op'],
    pk: row.pk,
    payload: row.payload ? (JSON.parse(row.payload) as unknown) : null,
    ...(row.org_id ? { orgId: row.org_id } : {}),
    ...(row.facility_id ? { facilityId: row.facility_id } : {}),
    createdAt: row.created_at,
  };
}

/** Edge-side outbox: appends (write-through) + the reader the syncer drives. */
export class SqliteOutbox implements OutboxReader, OutboxWriter {
  private readonly insert: BetterSqlite3.Statement;
  private readonly listUnackedStmt: BetterSqlite3.Statement;

  constructor(private readonly db: SqliteDb) {
    this.insert = db.prepare(
      `INSERT INTO outbox (table_name, op, pk, payload, org_id, facility_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.listUnackedStmt = db.prepare(
      `SELECT seq, table_name, op, pk, payload, org_id, facility_id, acked, created_at
       FROM outbox WHERE acked = 0 ORDER BY seq ASC LIMIT ?`,
    );
  }

  append(entry: Omit<OutboxEntry, 'seq' | 'createdAt'>): number {
    const { lastInsertRowid } = this.insert.run(
      entry.table,
      entry.op,
      entry.pk,
      JSON.stringify(entry.payload ?? null),
      entry.orgId ?? null,
      entry.facilityId ?? null,
      new Date().toISOString(),
    );
    return Number(lastInsertRowid);
  }

  listUnacked(limit: number): OutboxEntry[] {
    return (this.listUnackedStmt.all(limit) as unknown as OutboxRow[]).map(rowToEntry);
  }

  markAcked(throughSeq: number): number {
    const info = this.db
      .prepare(`UPDATE outbox SET acked = 1, acked_at = ? WHERE acked = 0 AND seq <= ?`)
      .run(new Date().toISOString(), throughSeq);
    return info.changes;
  }

  maxSeq(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM outbox`).get() as { m: number };
    return Number(row.m);
  }

  pendingCount(): number {
    const row = this.db.prepare(`SELECT count(*) AS n FROM outbox WHERE acked = 0`).get() as { n: number };
    return Number(row.n);
  }
}
