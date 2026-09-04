/**
 * PostgreSQL-backed DeviceProfile store (workstream A2). Profiles are stored
 * as validated JSONB payloads; reading them back runs zod validation so a
 * corrupt row fails loudly instead of silently mis-parsing results.
 */
import type { Pool } from 'pg';
import type { DeviceProfile } from '@integration-hub/shared';
import { parseDeviceProfile, type ProfileStore } from './profiles.js';

interface ProfileRow {
  id: string;
  payload: unknown;
}

export class PostgresProfileStore implements ProfileStore {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<DeviceProfile[]> {
    const { rows } = await this.pool.query<ProfileRow>(`SELECT id, payload FROM device_profiles ORDER BY manufacturer, model`);
    return rows.map((r) => parseDeviceProfile(r.payload));
  }

  async get(id: string): Promise<DeviceProfile | undefined> {
    const { rows } = await this.pool.query<ProfileRow>(`SELECT id, payload FROM device_profiles WHERE id = $1`, [id]);
    return rows[0] ? parseDeviceProfile(rows[0].payload) : undefined;
  }

  async upsert(profile: DeviceProfile): Promise<void> {
    const parsed = parseDeviceProfile(profile);
    await this.pool.query(
      `INSERT INTO device_profiles (id, version, manufacturer, model, protocol, transport, status, certified_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         version = EXCLUDED.version,
         manufacturer = EXCLUDED.manufacturer,
         model = EXCLUDED.model,
         protocol = EXCLUDED.protocol,
         transport = EXCLUDED.transport,
         status = EXCLUDED.status,
         certified_at = EXCLUDED.certified_at,
         payload = EXCLUDED.payload,
         updated_at = now()`,
      [
        parsed.id,
        parsed.version,
        parsed.manufacturer,
        parsed.model,
        parsed.protocol,
        parsed.transport,
        parsed.status,
        parsed.certifiedAt ?? null,
        JSON.stringify(parsed),
      ],
    );
  }

  async remove(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM device_profiles WHERE id = $1`, [id]);
  }
}