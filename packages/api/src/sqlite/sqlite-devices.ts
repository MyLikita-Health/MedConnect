/** @packageDocumentation
 * W1 — SQLite-backed device registry (D12; same seam as pg/pg-devices.ts).
 * Auto-registration on first sighting, connection-state upserts, profile
 * binding, and the D11 outbox write-through (best-effort on state flips).
 */
import type { OutboxWriter } from '@integration-hub/core';
import type { DeviceBackend, DeviceStats, UpsertFromConnectionInput } from '../backend.js';
import { slugify, type DeviceRecord, type RegisterDeviceInput } from '../devices.js';
import type { SyncedDeviceRow } from '../pg/pg-outbox.js';
import type { SqliteDb } from './schema.js';

interface DeviceRow {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  protocol: string;
  transport: string;
  host: string | null;
  port: number | null;
  profile_id: string | null;
  state: string;
  last_seen: string | null;
  auto_registered: number;
  created_at: string;
  org_id: string | null;
  facility_id: string | null;
}

function rowToRecord(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    name: row.name,
    manufacturer: row.manufacturer ?? undefined,
    model: row.model ?? undefined,
    protocol: row.protocol as DeviceRecord['protocol'],
    transport: row.transport as DeviceRecord['transport'],
    host: row.host ?? undefined,
    port: row.port ?? undefined,
    profileId: row.profile_id ?? undefined,
    state: row.state as DeviceRecord['state'],
    lastSeen: row.last_seen ?? undefined,
    autoRegistered: row.auto_registered === 1,
    createdAt: row.created_at,
    orgId: row.org_id ?? undefined,
    facilityId: row.facility_id ?? undefined,
  };
}

export class SqliteDeviceRegistry implements DeviceBackend {
  readonly kind = 'sqlite' as const;

  /** D11 write-through (see OutboxWriter). Present on a paired edge. */
  outbox?: { append: OutboxWriter['append'] };
  /** H1/W4 tenancy stamps — null on a single-tenant edge. */
  tenancy?: { orgId: string; facilityId: string };

  constructor(private readonly db: SqliteDb) {}

  register(input: RegisterDeviceInput): DeviceRecord {
    const id = input.id ?? slugify(input.name);
    const now = new Date().toISOString();
    const record: DeviceRecord = {
      id,
      name: input.name,
      manufacturer: input.manufacturer,
      model: input.model,
      protocol: input.protocol ?? 'ASTM',
      transport: input.transport ?? 'tcp',
      host: input.host,
      port: input.port,
      profileId: input.profileId,
      state: 'unknown',
      createdAt: now,
      orgId: input.orgId ?? this.tenancy?.orgId,
      facilityId: input.facilityId ?? this.tenancy?.facilityId,
    };
    this.db
      .prepare(
        `INSERT INTO devices (id, name, manufacturer, model, protocol, transport, host, port, profile_id, state, auto_registered, created_at, org_id, facility_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 0, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, manufacturer = excluded.manufacturer, model = excluded.model,
           protocol = excluded.protocol, transport = excluded.transport, host = excluded.host,
           port = excluded.port, profile_id = excluded.profile_id, org_id = excluded.org_id, facility_id = excluded.facility_id`,
      )
      .run(
        record.id,
        record.name,
        record.manufacturer ?? null,
        record.model ?? null,
        record.protocol,
        record.transport,
        record.host ?? null,
        record.port ?? null,
        record.profileId ?? null,
        now,
        record.orgId ?? null,
        record.facilityId ?? null,
      );
    this.appendSync(record, 'INSERT');
    return record;
  }

  /** Register (or refresh) a device discovered on the wire (mirrors pg-devices). */
  upsertFromConnection(input: UpsertFromConnectionInput): DeviceRecord {
    const now = new Date().toISOString();
    const existing = this.get(input.id);
    if (existing) {
      const state = input.state ?? existing.state;
      this.db
        .prepare(`UPDATE devices SET state = ?, last_seen = ? WHERE id = ?`)
        .run(state, now, input.id);
      this.appendSync({ ...existing, state, lastSeen: now }, 'UPDATE');
      return { ...existing, state, lastSeen: now };
    }
    const record: DeviceRecord = {
      id: input.id,
      name: input.name ?? input.id,
      protocol: input.protocol ?? 'ASTM',
      transport: input.transport ?? 'tcp',
      state: input.state,
      lastSeen: now,
      autoRegistered: true,
      createdAt: now,
      orgId: this.tenancy?.orgId,
      facilityId: this.tenancy?.facilityId,
    };
    this.db
      .prepare(
        `INSERT INTO devices (id, name, protocol, transport, state, last_seen, auto_registered, created_at, org_id, facility_id)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.protocol,
        record.transport,
        record.state,
        now,
        now,
        record.orgId ?? null,
        record.facilityId ?? null,
      );
    this.appendSync(record, 'INSERT');
    return record;
  }

  get(id: string): DeviceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(): DeviceRecord[] {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY name ASC').all() as unknown as DeviceRow[];
    return rows.map(rowToRecord);
  }

  stats(): DeviceStats {
    const rows = this.db
      .prepare(`SELECT state, count(*) AS n FROM devices GROUP BY state`)
      .all() as unknown as { state: string; n: number }[];
    let connected = 0;
    let offline = 0;
    let total = 0;
    for (const row of rows) {
      total += row.n;
      if (row.state === 'connected') connected = row.n;
      if (row.state === 'disconnected') offline = row.n;
    }
    return { total, connected, offline };
  }

  remove(id: string): boolean {
    const info = this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** D11 write-through — best-effort: a sync entry must never fail a device
   *  lifecycle transition (matches pg-devices semantics). */
  private appendSync(record: DeviceRecord, op: 'INSERT' | 'UPDATE'): void {
    if (!this.outbox) return;
    try {
      const row = deviceToSyncRow(record);
      this.outbox.append({
        table: 'devices',
        op,
        pk: record.id,
        payload: row,
        ...(row.orgId ? { orgId: row.orgId } : {}),
        ...(row.facilityId ? { facilityId: row.facilityId } : {}),
      });
    } catch {
      // never propagate — the next full write re-ships anyway
    }
  }
}

function deviceToSyncRow(record: DeviceRecord): SyncedDeviceRow {
  return {
    id: record.id,
    name: record.name,
    manufacturer: record.manufacturer,
    model: record.model,
    protocol: record.protocol,
    transport: record.transport,
    host: record.host,
    port: record.port,
    profileId: record.profileId,
    state: record.state,
    orgId: record.orgId,
    facilityId: record.facilityId,
  };
}
