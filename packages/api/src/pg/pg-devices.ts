/** PostgreSQL-backed device registry (PRD §11, §32) with the same surface as the in-memory one.
 *
 * D11 write-through: with an outbox attached, every register/upsert also
 * appends a sync entry (the cloud copy converges on device state).
 */
import type { Pool } from 'pg';
import type { OutboxWriter } from '@integration-hub/core';
import type { DeviceBackend, DeviceStats } from '../backend.js';
import {
  slugify,
  type DeviceRecord,
  type RegisterDeviceInput,
} from '../devices.js';
import { appendOutboxRow } from './pg-store.js';
import type { SyncedDeviceRow } from './pg-outbox.js';

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
  last_seen: Date | string | null;
  auto_registered: boolean;
  created_at: Date | string;
  org_id: string | null;
  facility_id: string | null;
}

const DEVICE_COLUMNS = `id, name, manufacturer, model, protocol, transport, host, port, profile_id, state, last_seen, auto_registered, created_at, org_id, facility_id`;

export class PostgresDeviceRegistry implements DeviceBackend {
  readonly kind = 'postgres' as const;

  /** D11 write-through: the outbox append (same shape as the message store's). */
  outbox?: { append: OutboxWriter['append'] };

  /** H1 cloud tenancy write-through (same semantics as the message store's). */
  tenancy?: { orgId: string; facilityId: string };

  constructor(private readonly pool: Pool) {}

  /** Append a device sync entry (best-effort on the hot path; the next full
   *  write re-ships — sync must never fail a state flip). */
  private shipDevice(row: DeviceRecord): void {
    if (!this.outbox) return;
    const payload: SyncedDeviceRow = {
      id: row.id,
      name: row.name,
      ...(row.manufacturer ? { manufacturer: row.manufacturer } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.protocol ? { protocol: row.protocol } : {}),
      ...(row.transport ? { transport: row.transport } : {}),
      ...(row.host ? { host: row.host } : {}),
      ...(row.port ? { port: row.port } : {}),
      ...(row.profileId ? { profileId: row.profileId } : {}),
      orgId: row.orgId ?? this.tenancy?.orgId,
      facilityId: row.facilityId ?? this.tenancy?.facilityId,
      state: row.state,
  };
    void appendOutboxRow(
      this.pool,
      this.outbox,
      { table: 'devices', op: 'UPDATE', pk: row.id },
      payload,
    ).catch(() => undefined);
  }

  async register(input: RegisterDeviceInput): Promise<DeviceRecord> {
    const id = input.id ?? slugify(input.name);
    const { rows } = await this.pool.query<DeviceRow>(
      `INSERT INTO devices (id, name, manufacturer, model, protocol, transport, host, port, profile_id, state, org_id, facility_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unknown',$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         manufacturer = EXCLUDED.manufacturer,
         model = EXCLUDED.model,
         protocol = EXCLUDED.protocol,
         transport = EXCLUDED.transport,
         host = EXCLUDED.host,
         port = EXCLUDED.port,
         profile_id = EXCLUDED.profile_id,
         state = EXCLUDED.state,
         last_seen = NULL
       RETURNING ${DEVICE_COLUMNS}`,
      [
        id,
        input.name,
        input.manufacturer ?? null,
        input.model ?? null,
        input.protocol ?? 'ASTM',
        input.transport ?? 'tcp',
        input.host ?? null,
        input.port ?? null,
        input.profileId ?? null,
        input.orgId ?? this.tenancy?.orgId ?? null,
        input.facilityId ?? this.tenancy?.facilityId ?? null,
      ],
    );
    const record = rowToDevice(rows[0]!);
    this.shipDevice(record);
    return record;
  }

  async upsertFromConnection(input: {
    id: string;
    name?: string;
    protocol?: DeviceRecord['protocol'];
    transport?: DeviceRecord['transport'];
    state: DeviceRecord['state'];
  }): Promise<DeviceRecord> {
    const { rows } = await this.pool.query<DeviceRow>(
      `INSERT INTO devices (id, name, protocol, transport, state, last_seen, auto_registered, org_id, facility_id)
       VALUES ($1,$2,$3,$4,$5, now(), true, $6, $7)
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, last_seen = now()
       RETURNING ${DEVICE_COLUMNS}`,
      [
        input.id,
        input.name ?? input.id,
        input.protocol ?? 'ASTM',
        input.transport ?? 'tcp',
        input.state,
        this.tenancy?.orgId ?? null,
        this.tenancy?.facilityId ?? null,
      ],
    );
    const record = rowToDevice(rows[0]!);
    this.shipDevice(record);
    return record;
  }

  async get(id: string): Promise<DeviceRecord | undefined> {
    const { rows } = await this.pool.query<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? rowToDevice(row) : undefined;
  }

  async list(): Promise<DeviceRecord[]> {
    const { rows } = await this.pool.query<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM devices ORDER BY name ASC`,
    );
    return rows.map(rowToDevice);
  }

  async stats(): Promise<DeviceStats> {
    const { rows } = await this.pool.query<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM devices GROUP BY state`,
    );
    let connected = 0;
    let offline = 0;
    let total = 0;
    for (const row of rows) {
      total += row.n;
      if (row.state === 'connected') connected += row.n;
      else if (row.state === 'disconnected') offline += row.n;
    }
    return { total, connected, offline };
  }

  async remove(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM devices WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }
}

function rowToDevice(row: DeviceRow): DeviceRecord {
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
    lastSeen: row.last_seen ? new Date(row.last_seen).toISOString() : undefined,
    autoRegistered: row.auto_registered,
    createdAt: new Date(row.created_at).toISOString(),
    orgId: row.org_id ?? undefined,
    facilityId: row.facility_id ?? undefined,
  };
}