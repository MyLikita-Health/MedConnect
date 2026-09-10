/** @packageDocumentation
 * W1 — SQLite-backed API-key + audit stores (M2 security; same seams as
 * pg/pg-security.ts). Secrets are stored hashed (hashSecret), never plaintext.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ApiKey, ApiKeyRole, AuditEntry, AuditResult, AuditFilter, AuditStore, CreateKeyInput, KeyPatch, KeyStore } from '../security.js';
import { generateSecret, hashSecret, keyIsUsable } from '../security.js';
import type { SqliteDb } from './schema.js';

interface KeyRow {
  id: string;
  name: string;
  role: string;
  prefix: string;
  enabled: number;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  secret_issued_at: string;
  created_by: string | null;
}

function rowToKey(row: KeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    role: row.role as ApiKeyRole,
    prefix: row.prefix,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    secretIssuedAt: row.secret_issued_at,
    createdBy: row.created_by ?? undefined,
  };
}

export class SqliteKeyStore implements KeyStore {
  private readonly insert: BetterSqlite3.Statement;
  private readonly insertHash: BetterSqlite3.Statement;

  constructor(private readonly db: SqliteDb) {
    this.insert = db.prepare(
      `INSERT INTO api_keys (id, name, role, key_hash, prefix, enabled, created_at, expires_at, secret_issued_at, created_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    );
    this.insertHash = db.prepare(`UPDATE api_keys SET key_hash = ? WHERE id = ?`);
  }

  list(): ApiKey[] {
    const rows = this.db
      .prepare(`SELECT * FROM api_keys ORDER BY created_at ASC`)
      .all() as unknown as KeyRow[];
    return rows.map(rowToKey);
  }

  get(id: string): ApiKey | undefined {
    const row = this.db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(id) as KeyRow | undefined;
    return row ? rowToKey(row) : undefined;
  }

  findBySecret(secret: string): ApiKey | undefined {
    const row = this.db
      .prepare(`SELECT * FROM api_keys WHERE key_hash = ?`)
      .get(hashSecret(secret)) as KeyRow | undefined;
    if (!row) return undefined;
    const key = rowToKey(row);
    return keyIsUsable(key) ? key : undefined;
  }

  create(input: CreateKeyInput): { key: ApiKey; secret: string } {
    const secret = input.secret ?? generateSecret();
    const id = input.id ?? `key_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.insert.run(
      id,
      input.name,
      input.role,
      hashSecret(secret),
      secret.slice(0, 12),
      now,
      input.expiresAt ?? null,
      now,
      input.createdBy ?? null,
    );
    const key = this.get(id)!;
    return { key, secret };
  }

  update(id: string, patch: KeyPatch): ApiKey | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next: ApiKey = { ...existing };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if ('expiresAt' in patch) next.expiresAt = patch.expiresAt ?? undefined;
    this.db
      .prepare(`UPDATE api_keys SET name = ?, enabled = ?, expires_at = ? WHERE id = ?`)
      .run(next.name, next.enabled ? 1 : 0, next.expiresAt ?? null, id);
    return next;
  }

  /** Mint a NEW secret for an existing key (old hash revoked); plaintext shown once. */
  rotateSecret(id: string): { key: ApiKey; secret: string } | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const secret = generateSecret();
    const issuedAt = new Date();
    // Strictly after any prior use so the new secret counts as unseen until it
    // itself authenticates — even within the same real ms (security.ts rule).
    issuedAt.setMilliseconds(issuedAt.getMilliseconds() + 1);
    this.db
      .prepare(`UPDATE api_keys SET key_hash = ?, prefix = ?, secret_issued_at = ? WHERE id = ?`)
      .run(hashSecret(secret), secret.slice(0, 12), issuedAt.toISOString(), id);
    return { key: this.get(id)!, secret };
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  }

  touch(id: string): void {
    const existing = this.get(id);
    if (!existing) return;
    // Stamp strictly after any prior value (mirrors InMemoryKeyStore.stampAfter).
    const now = new Date();
    const prior = existing.lastUsedAt ? Date.parse(existing.lastUsedAt) : 0;
    if (now.getTime() <= prior) now.setTime(prior + 1);
    this.db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(now.toISOString(), id);
  }
}

// ---------------------------------------------------------------------------
// Audit log (PRD §30: who/what/when/where/result)
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  at: string;
  actor_key: string | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  target: string | null;
  result: string;
  status_code: number | null;
  ip: string | null;
  detail: string | null;
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    at: row.at,
    actorKey: row.actor_key ?? undefined,
    actorName: row.actor_name ?? undefined,
    actorRole: (row.actor_role ?? undefined) as AuditEntry['actorRole'],
    action: row.action,
    target: row.target ?? undefined,
    result: row.result as AuditResult,
    statusCode: row.status_code ?? undefined,
    ip: row.ip ?? undefined,
    detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : undefined,
  };
}

export class SqliteAuditStore implements AuditStore {
  constructor(private readonly db: SqliteDb) {}

  append(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const full: AuditEntry = { ...entry, id: randomUUID(), at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO audit_log (id, at, actor_key, actor_name, actor_role, action, target, result, status_code, ip, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.at,
        full.actorKey ?? null,
        full.actorName ?? null,
        full.actorRole ?? null,
        full.action,
        full.target ?? null,
        full.result,
        full.statusCode ?? null,
        full.ip ?? null,
        full.detail ? JSON.stringify(full.detail) : null,
      );
    return full;
  }

  /** Newest first (mirrors InMemoryAuditStore.list). */
  list(filter: AuditFilter = {}): AuditEntry[] {
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = (
      filter.result
        ? this.db
            .prepare(`SELECT * FROM audit_log WHERE result = ? ORDER BY at DESC LIMIT ?`)
            .all(filter.result, limit)
        : this.db.prepare(`SELECT * FROM audit_log ORDER BY at DESC, rowid DESC LIMIT ?`).all(limit)
    ) as unknown as AuditRow[];
    return rows.map(rowToEntry);
  }
}
