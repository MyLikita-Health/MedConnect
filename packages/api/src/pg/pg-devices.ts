/** PostgreSQL-backed device registry (PRD §11, §32) with the same surface as the in-memory one. */
import type { Pool } from 'pg';
import type { DeviceBackend, DeviceStats } from '../backend.js';
import {
  slugify,
  type DeviceRecord,
  type RegisterDeviceInput,
} from '../devices.js';

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
}

const DEVICE_COLUMNS = `id, name, manufacturer, model, protocol, transport, host, port, profile_id, state, last_seen, auto_registered, created_at`;

export class PostgresDeviceRegistry implements DeviceBackend {
  readonly kind = 'postgres' as const;

  constructor(private readonly pool: Pool) {}

  async register(input: RegisterDeviceInput): Promise<DeviceRecord> {
    const id = input.id ?? slugify(input.name);
    const { rows } = await this.pool.query<DeviceRow>(
      `INSERT INTO devices (id, name, manufacturer, model, protocol, transport, host, port, profile_id, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unknown')
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
      ],
    );
    return rowToDevice(rows[0]!);
  }

  async upsertFromConnection(input: {
    id: string;
    name?: string;
    protocol?: DeviceRecord['protocol'];
    transport?: DeviceRecord['transport'];
    state: DeviceRecord['state'];
  }): Promise<DeviceRecord> {
    const { rows } = await this.pool.query<DeviceRow>(
      `INSERT INTO devices (id, name, protocol, transport, state, last_seen, auto_registered)
       VALUES ($1,$2,$3,$4,$5, now(), true)
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, last_seen = now()
       RETURNING ${DEVICE_COLUMNS}`,
      [
        input.id,
        input.name ?? input.id,
        input.protocol ?? 'ASTM',
        input.transport ?? 'tcp',
        input.state,
      ],
    );
    return rowToDevice(rows[0]!);
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
  };
}