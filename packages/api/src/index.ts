export { ApiServer, type ApiServerOptions } from './server.js';
export { MessageStore, type MessageFilter, type StoreStats } from './store.js';
export {
  DeviceRegistry,
  slugify,
  type DeviceRecord,
  type DeviceState,
  type DeviceStats,
  type RegisterDeviceInput,
} from './devices.js';
export type {
  DeviceBackend,
  DeviceKind,
  StoreBackend,
  StoreKind,
  UpsertFromConnectionInput,
} from './backend.js';
export {
  API_KEY_ROLES,
  InMemoryAuditStore,
  InMemoryKeyStore,
  ROLE_SCOPES,
  ROUTE_SCOPES,
  generateSecret,
  hashSecret,
  roleHasScope,
  type ApiKey,
  type ApiKeyRole,
  type ApiScope,
  type AuditEntry,
  type AuditFilter,
  type AuditResult,
  type AuditStore,
  type CreateKeyInput,
  type KeyStore,
} from './security.js';
export { PostgresAuditStore, PostgresKeyStore } from './pg/pg-security.js';
export { PostgresMessageStore } from './pg/pg-store.js';
export { PostgresDeviceRegistry } from './pg/pg-devices.js';
export { createDbPool, closeDbPool, DEFAULT_DATABASE_URL } from './pg/pool.js';
export { runMigrations } from './pg/migrate.js';