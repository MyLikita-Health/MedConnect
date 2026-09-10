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
export { PostgresOrgStore, PostgresFacilityStore, bootstrapCloudOrg, type CloudContext, RLS, type BootstrapResult, withCloudContext, } from './pg/pg-tenancy.js';
export { PostgresOutbox, PostgresIngestStore, type SyncedMessageRow, type SyncedDeviceRow, type IngestCursor } from './pg/pg-outbox.js';
export * from './sqlite/index.js';
export { InMemoryFeatureFlagStore, InMemoryQuotaStore, InMemoryLicenseStore, evaluateEntitlement, type Entitlement, type FacilityQuota, type FeatureFlag, type FeatureFlagStore, type FleetRoutesOptions, type LicenseRecord, type LicenseStore, type QuotaStore } from './fleet.js';
export { PUBLIC_ROUTES } from './security.js';
export { registerSetupRoutes, type DomainSettings, type FacilitySettings, type NetworkSettings, type OrthancSettings, type SetupStatus } from './setup.js';
export { registerPairingRoutes, type CloudSyncSettings, type PairingRoutesOptions, type PairingState } from './pairing.js';

/**
 * JS/TS SDK (workstream D5): typed client wrapping the v1 REST surface —
 * orders, results, devices, webhooks — plus auth helpers and the shared
 * version shape. Imported from `@integration-hub/api` alongside the server
 * types so integrators get the client + the API contract together.
 *
 * Device-level types (`Device`, `DeviceProtocol`, `DeviceTransport`,
 * `DeviceState`, `RegisterDeviceInput`) are re-exported from `./devices.js`
 * below so the canonical source stays in `devices.ts`; the SDK block only
 * contributes the client + webhook/result/order types + auth helper.
 */
export { HubClient, type HubClientOptions, type HubHealth, type Order, type CreateOrderInput, type ResultRow, type WebhookSubscription, type WebhookEventType, type CreateWebhookSubscriptionInput, type UpdateWebhookSubscriptionInput, type WebhookDelivery, type ReplayDeliveryResponse, type TestWebhookResponse, type ApiError, apiKeyAuth, } from './sdk.js';