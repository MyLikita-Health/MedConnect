/**
 * PostgreSQL-backed API-key + audit stores (M2 security, migration 0007).
 * Same contracts as the in-memory stores in security.ts.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ApiKey, ApiKeyRole, AuditEntry, AuditResult, AuditStore, CreateKeyInput, KeyPatch, KeyStore } from '../security.js';
import { generateSecret, hashSecret, keyIsUsable } from '../security.js';

interface KeyRow {
  id: string;
  name: string;
  role: string;
  prefix: string;
  enabled: boolean;
  created_at: Date | string;
  last_used_at: Date | string | null;
  expires_at: Date | string | null;
  secret_issued_at: Date | string | null;
  created_by: string | null;
}

interface AuditRow {
  id: string;
  at: Date | string;
  actor_key: string | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  target: string | null;
  result: string;
  status_code: number | null;
  ip: string | null;
  detail: unknown;
}

const KEY_COLUMNS = `id, name, role, prefix, enabled, created_at, last_used_at, expires_at, secret_issued_at, created_by`;

export class PostgresKeyStore implements KeyStore {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<ApiKey[]> {
    const { rows } = await this.pool.query<KeyRow>(
      `SELECT ${KEY_COLUMNS} FROM api_keys ORDER BY created_at ASC`,
    );
    return rows.map(rowToKey);
  }

  async get(id: string): Promise<ApiKey | undefined> {
    const { rows } = await this.pool.query<KeyRow>(
      `SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? rowToKey(row) : undefined;
  }

  async findBySecret(secret: string): Promise<ApiKey | undefined> {
    const { rows } = await this.pool.query<KeyRow>(
      `SELECT ${KEY_COLUMNS} FROM api_keys WHERE key_hash = $1`,
      [hashSecret(secret)],
    );
    const row = rows[0];
    if (!row) return undefined;
    const key = rowToKey(row);
    return keyIsUsable(key) ? key : undefined;
  }

  async create(input: CreateKeyInput): Promise<{ key: ApiKey; secret: string }> {
    const secret = input.secret ?? generateSecret();
    const id = input.id ?? `key_${randomUUID().slice(0, 8)}`;
    const { rows } = await this.pool.query<KeyRow>(
      `INSERT INTO api_keys (id, name, role, key_hash, prefix, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${KEY_COLUMNS}`,
      [id, input.name, input.role, hashSecret(secret), secret.slice(0, 12), input.expiresAt ?? null, input.createdBy ?? null],
    );
    return { key: rowToKey(rows[0]!), secret };
  }

  async update(id: string, patch: KeyPatch): Promise<ApiKey | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (patch.name !== undefined) {
      params.push(patch.name);
      sets.push(`name = $${params.length}`);
    }
    if (patch.enabled !== undefined) {
      params.push(patch.enabled);
      sets.push(`enabled = $${params.length}`);
    }
    if ('expiresAt' in patch) {
      params.push(patch.expiresAt ?? null);
      sets.push(`expires_at = $${params.length}`);
    }
    if (sets.length === 0) return this.get(id);
    const { rows } = await this.pool.query<KeyRow>(
      `UPDATE api_keys SET ${sets.join(', ')} WHERE id = $1 RETURNING ${KEY_COLUMNS}`,
      params,
    );
    return rows[0] ? rowToKey(rows[0]) : undefined;
  }

  async rotateSecret(id: string): Promise<{ key: ApiKey; secret: string } | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    const secret = generateSecret();
    const { rows } = await this.pool.query<KeyRow>(
      // Issue strictly after any prior use (monotonic clock) so the new secret
      // counts as unseen until it itself authenticates.
      `UPDATE api_keys SET key_hash = $2, prefix = $3,
         secret_issued_at = greatest(now(), COALESCE(last_used_at, now()) + interval '1 millisecond')
       WHERE id = $1 RETURNING ${KEY_COLUMNS}`,
      [id, hashSecret(secret), secret.slice(0, 12)],
    );
    if (!rows[0]) return undefined;
    return { key: rowToKey(rows[0]), secret };
  }

  async remove(id: string): Promise<void> {
    await this.pool.query('DELETE FROM api_keys WHERE id = $1', [id]);
  }

  async touch(id: string): Promise<void> {
    // Monotonic per-key clock (never move backwards or tie): same-ms bursts
    // must stay ordered for the never-seen rotation warning to be
    // deterministic (mirrors stampAfter in the in-memory store).
    await this.pool.query(
      `UPDATE api_keys SET last_used_at = greatest(now(), COALESCE(last_used_at, now()) + interval '1 millisecond') WHERE id = $1`,
      [id],
    );
  }
}

function rowToKey(row: KeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    role: row.role as ApiKeyRole,
    prefix: row.prefix,
    enabled: row.enabled,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : undefined,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined,
    secretIssuedAt: row.secret_issued_at ? new Date(row.secret_issued_at).toISOString() : undefined,
    createdBy: row.created_by ?? undefined,
  };
}

export class PostgresAuditStore implements AuditStore {
  constructor(private readonly pool: Pool) {}

  async append(entry: Omit<AuditEntry, 'id' | 'at'>): Promise<AuditEntry> {
    const id = randomUUID();
    const at = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO audit_log (id, at, actor_key, actor_name, actor_role, action, target, result, status_code, ip, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        at,
        entry.actorKey ?? null,
        entry.actorName ?? null,
        entry.actorRole ?? null,
        entry.action,
        entry.target ?? null,
        entry.result,
        entry.statusCode ?? null,
        entry.ip ?? null,
        entry.detail !== undefined ? JSON.stringify(entry.detail) : null,
      ],
    );
    return { ...entry, id, at };
  }

  async list(filter: { limit?: number; result?: AuditResult } = {}): Promise<AuditEntry[]> {
    const params: unknown[] = [];
    let where = '';
    if (filter.result) {
      params.push(filter.result);
      where = `WHERE result = $${params.length}`;
    }
    const limit = Math.min(filter.limit ?? 100, 500);
    params.push(limit);
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT id, at, actor_key, actor_name, actor_role, action, target, result, status_code, ip, detail
       FROM audit_log ${where} ORDER BY at DESC, seq DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(rowToAudit);
  }
}

function rowToAudit(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    at: new Date(row.at).toISOString(),
    actorKey: row.actor_key ?? undefined,
    actorName: row.actor_name ?? undefined,
    actorRole: (row.actor_role as ApiKeyRole | null) ?? undefined,
    action: row.action,
    target: row.target ?? undefined,
    result: row.result as AuditResult,
    statusCode: row.status_code ?? undefined,
    ip: row.ip ?? undefined,
    detail: (row.detail as Record<string, unknown> | null) ?? undefined,
  };
}
