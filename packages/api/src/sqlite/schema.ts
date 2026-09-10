/** @packageDocumentation
 * W1 — SQLite edge schema + migration runner (D12, docs/windows-desktop-installer.md §3).
 *
 * Table/column names mirror the PostgreSQL migrations (0001–0015) so the mental
 * model is identical across backends; the dialect differs (JSON columns are
 * TEXT holding JSON, timestamps are ISO TEXT, `AUTOINCREMENT` replaces
 * bigserial, no `jsonb`/`now()`/`timestamptz`). `org_id`/`facility_id` columns
 * exist from day one (null on a single-tenant edge) so the W4 cloud-pairing
 * write-through is a data change, not a schema change.
 *
 * DDL lives in code (not .sql files) because better-sqlite3 applies statements
 * one at a time and the PG migration files are not valid SQLite anyway. The
 * `schema_migrations` runner keeps the same apply-in-order / record-version
 * pattern as `pg/migrate.ts`.
 */
import type BetterSqlite3 from 'better-sqlite3';

/** The subset of the better-sqlite3 API the stores depend on (test seam). */
export type SqliteDb = BetterSqlite3.Database;

const MIGRATIONS: { version: string; statements: string[] }[] = [
  {
    version: '0001_init',
    statements: [
      `CREATE TABLE IF NOT EXISTS messages (
         id           TEXT PRIMARY KEY,
         protocol     TEXT NOT NULL,
         direction    TEXT NOT NULL,
         device_id    TEXT,
         received_at  TEXT NOT NULL,
         raw          TEXT NOT NULL,
         records      TEXT,
         payload      TEXT,
         imaging      TEXT,
         status       TEXT NOT NULL,
         errors       TEXT NOT NULL DEFAULT '[]',
         timeline     TEXT NOT NULL DEFAULT '[]',
         dlq_at       TEXT,
         duplicate_of TEXT,
         match_status TEXT,
         matched_order_id   TEXT,
         matched_patient_id TEXT,
         match_strategy     TEXT,
         match_at           TEXT,
         match_reason       TEXT,
         org_id       TEXT,
         facility_id  TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_received ON messages (received_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_status ON messages (status)`,
      `CREATE TABLE IF NOT EXISTS message_attempts (
         id             INTEGER PRIMARY KEY AUTOINCREMENT,
         message_id     TEXT NOT NULL,
         destination_id TEXT NOT NULL,
         attempt        INTEGER NOT NULL,
         status         TEXT NOT NULL,
         error          TEXT,
         at             TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_attempts_message ON message_attempts (message_id)`,
      `CREATE TABLE IF NOT EXISTS devices (
         id              TEXT PRIMARY KEY,
         name            TEXT NOT NULL,
         manufacturer    TEXT,
         model           TEXT,
         protocol        TEXT NOT NULL DEFAULT 'ASTM',
         transport       TEXT NOT NULL DEFAULT 'tcp',
         host            TEXT,
         port            INTEGER,
         profile_id      TEXT,
         state           TEXT NOT NULL DEFAULT 'unknown',
         last_seen       TEXT,
         auto_registered INTEGER NOT NULL DEFAULT 0,
         created_at      TEXT NOT NULL,
         org_id          TEXT,
         facility_id     TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS order_registry (
         id         TEXT PRIMARY KEY,
         patient_id TEXT NOT NULL,
         sample_id  TEXT,
         tests      TEXT NOT NULL DEFAULT '[]',
         status     TEXT NOT NULL DEFAULT 'active',
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_orders_patient ON order_registry (patient_id)`,
      `CREATE TABLE IF NOT EXISTS admission_registry (
         patient_id    TEXT PRIMARY KEY,
         name          TEXT,
         date_of_birth TEXT,
         gender        TEXT,
         visit_id      TEXT,
         status        TEXT NOT NULL DEFAULT 'admitted',
         created_at    TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS destinations (
         id           TEXT PRIMARY KEY,
         kind         TEXT NOT NULL,
         name         TEXT NOT NULL,
         url          TEXT,
         hl7_config   TEXT,
         enabled      INTEGER NOT NULL DEFAULT 1,
         retry_policy TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS route_rules (
         id             TEXT PRIMARY KEY,
         destination_id TEXT NOT NULL,
         device_id      TEXT,
         status         TEXT,
         priority       INTEGER NOT NULL DEFAULT 100,
         enabled        INTEGER NOT NULL DEFAULT 1
       )`,
      `CREATE TABLE IF NOT EXISTS dedup_keys (
         key        TEXT PRIMARY KEY,
         message_id TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS test_mappings (
         device_id      TEXT,
         device_code    TEXT NOT NULL,
         canonical_code TEXT NOT NULL,
         PRIMARY KEY (device_id, device_code)
       )`,
      // Canonical clinical rows (PG 0001 mirror): patients/orders upserted,
      // results appended (no unique key — attempts-style history, as in PG).
      `CREATE TABLE IF NOT EXISTS patients (
         id            TEXT PRIMARY KEY,
         name          TEXT,
         date_of_birth TEXT,
         gender        TEXT,
         first_seen    TEXT NOT NULL,
         last_seen     TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS orders (
         id          TEXT PRIMARY KEY,
         patient_id  TEXT REFERENCES patients (id) ON DELETE CASCADE,
         sample_id   TEXT,
         tests       TEXT NOT NULL DEFAULT '[]',
         message_id  TEXT,
         received_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_orders_patient2 ON orders (patient_id)`,
      `CREATE TABLE IF NOT EXISTS results (
         id                 INTEGER PRIMARY KEY AUTOINCREMENT,
         order_id           TEXT REFERENCES orders (id) ON DELETE CASCADE,
         message_id         TEXT,
         test_code          TEXT NOT NULL,
         original_test_code TEXT,
         test_name          TEXT,
         value              TEXT NOT NULL,
         unit               TEXT,
         reference_range    TEXT,
         flag               TEXT,
         status             TEXT,
         measured_at        TEXT,
         received_at        TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_results_order ON results (order_id)`,
    ],
  },
  {
    version: '0002_alerts_profiles',
    statements: [
      `CREATE TABLE IF NOT EXISTS alert_rules (
         id          TEXT PRIMARY KEY,
         kind        TEXT NOT NULL,
         name        TEXT NOT NULL,
         subject     TEXT,
         threshold   INTEGER NOT NULL,
         cooldown_ms INTEGER,
         channels    TEXT NOT NULL DEFAULT '["console"]',
         webhook_url TEXT,
         enabled     INTEGER NOT NULL DEFAULT 1
       )`,
      `CREATE TABLE IF NOT EXISTS alerts (
         id          TEXT PRIMARY KEY,
         rule_id     TEXT NOT NULL,
         kind        TEXT NOT NULL,
         subject     TEXT,
         message     TEXT NOT NULL,
         status      TEXT NOT NULL DEFAULT 'FIRING',
         fired_at    TEXT NOT NULL,
         resolved_at TEXT,
         count       INTEGER NOT NULL DEFAULT 1
       )`,
      `CREATE TABLE IF NOT EXISTS profiles (
         id       TEXT PRIMARY KEY,
         profile  TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    ],
  },
  {
    version: '0003_security',
    statements: [
      `CREATE TABLE IF NOT EXISTS api_keys (
         id              TEXT PRIMARY KEY,
         name            TEXT NOT NULL,
         role            TEXT NOT NULL,
         key_hash        TEXT NOT NULL UNIQUE,
         prefix          TEXT NOT NULL,
         enabled         INTEGER NOT NULL DEFAULT 1,
         created_at      TEXT NOT NULL,
         last_used_at    TEXT,
         expires_at      TEXT,
         secret_issued_at TEXT NOT NULL,
         created_by      TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS audit_log (
         id          TEXT PRIMARY KEY,
         at          TEXT NOT NULL,
         actor_key   TEXT,
         actor_name  TEXT,
         actor_role  TEXT,
         action      TEXT NOT NULL,
         target      TEXT,
         result      TEXT NOT NULL,
         status_code INTEGER,
         ip          TEXT,
         detail      TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC)`,
    ],
  },
  {
    version: '0004_webhooks',
    statements: [
      `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
         id         TEXT PRIMARY KEY,
         name       TEXT NOT NULL,
         url        TEXT NOT NULL,
         secret     TEXT NOT NULL,
         events     TEXT NOT NULL,
         enabled    INTEGER NOT NULL DEFAULT 1,
         retry      TEXT,
         created_at TEXT NOT NULL
       )`,
    ],
  },
  {
    version: '0005_outbox',
    statements: [
      // The D11 durable outbox — the edge's sync backlog AND the local
      // crash-recovery journal. Same shape as the PG `outbox` table (0015).
      `CREATE TABLE IF NOT EXISTS outbox (
         seq         INTEGER PRIMARY KEY AUTOINCREMENT,
         table_name  TEXT NOT NULL,
         op          TEXT NOT NULL,
         pk          TEXT NOT NULL,
         payload     TEXT,
         org_id      TEXT,
         facility_id TEXT,
         acked       INTEGER NOT NULL DEFAULT 0,
         acked_at    TEXT,
         created_at  TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_unacked ON outbox (acked, seq)`,
    ],
  },
];

/** Open (creating if needed) + configure + migrate a SQLite edge database. */
export function openSqliteDatabase(
  open: (file: string) => SqliteDb,
  file: string,
  opts: { log?: (line: string) => void } = {},
): SqliteDb {
  const db = open(file);
  // Durability pragmas (plan §7.G2 edge-resilience bar): WAL for crash-safe
  // concurrent read/write, FULL so an acknowledged write survives power loss.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runSqliteMigrations(db, opts.log);
  return db;
}

/** Apply pending schema versions in order; returns the versions applied. */
export function runSqliteMigrations(db: SqliteDb, log: (line: string) => void = () => undefined): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
     version    TEXT PRIMARY KEY,
     applied_at TEXT NOT NULL
   )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version),
  );
  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
    });
    apply();
    log(`[db] applied sqlite migration: ${migration.version}`);
    ran.push(migration.version);
  }
  return ran;
}
