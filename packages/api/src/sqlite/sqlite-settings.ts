/** @packageDocumentation
 * W2 — local-settings store (docs/windows-desktop-installer.md §4.5): the
 * first-boot configuration lives in the SAME SQLite store as everything else
 * (key/value JSON rows), so setup data survives restarts with the identical
 * durability story. No parallel config-file format to drift or lose.
 *
 * Keys used by the setup flow: `facility`, `domains`, `network`,
 * `firstBootComplete`. Values are arbitrary JSON — the API layer validates
 * shapes with zod before writing.
 */
import type BetterSqlite3 from 'better-sqlite3';
import type { SqliteDb } from './schema.js';

export class SqliteLocalSettingsStore {
  private readonly getStmt: BetterSqlite3.Statement;
  private readonly upsertStmt: BetterSqlite3.Statement;
  private readonly deleteStmt: BetterSqlite3.Statement;

  constructor(private readonly db: SqliteDb) {
    this.getStmt = db.prepare('SELECT value FROM local_settings WHERE key = ?');
    this.upsertStmt = db.prepare(
      `INSERT INTO local_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.deleteStmt = db.prepare('DELETE FROM local_settings WHERE key = ?');
  }

  /** Read one setting (JSON-parsed); undefined when unset. */
  get<T = unknown>(key: string): T | undefined {
    const row = this.getStmt.get(key) as { value: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value) as T;
  }

  /** Write one setting (JSON-encoded). Returns the ISO timestamp written. */
  set(key: string, value: unknown): string {
    const at = new Date().toISOString();
    this.upsertStmt.run(key, JSON.stringify(value ?? null), at);
    return at;
  }

  /** Delete one setting (test/reset helper). */
  delete(key: string): void {
    this.deleteStmt.run(key);
  }

  /** Every setting as a plain object (diagnostics + tests). */
  all(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM local_settings').all() as unknown as {
      key: string;
      value: string;
    }[];
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = JSON.parse(row.value);
    return out;
  }

  /** True when the first-boot flow has completed. */
  isConfigured(): boolean {
    const flag = this.get<{ complete: boolean; completedAt?: string }>('firstBootComplete');
    return flag?.complete === true;
  }
}
