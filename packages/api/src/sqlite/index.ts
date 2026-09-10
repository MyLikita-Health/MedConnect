/** @packageDocumentation
 * W1 — SQLite edge backend (D12): the embedded single-file store behind the
 * existing StoreBackend/DeviceBackend seams. No Docker, no DB service.
 */
export { openSqliteDatabase, runSqliteMigrations, type SqliteDb } from './schema.js';
export { SqliteMessageStore } from './sqlite-store.js';
export { SqliteDeviceRegistry } from './sqlite-devices.js';
export {
  SqliteRouteStore,
  SqliteDedupStore,
  SqliteOrderRegistry,
  SqliteAdmissionRegistry,
  SqliteAlertStore,
  SqliteProfileStore,
  SqliteWebhookStore,
} from './sqlite-core-stores.js';
export { SqliteOutbox } from './sqlite-outbox.js';
export { SqliteKeyStore, SqliteAuditStore } from './sqlite-security.js';
export { SqliteLocalSettingsStore } from './sqlite-settings.js';
