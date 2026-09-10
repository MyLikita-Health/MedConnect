/**
 * Edge gateway process: wires the ASTM gateway, the message store, the device
 * registry and the REST API together (PRD §8 Architecture layers).
 *
 * M0: when DATABASE_URL (or opts.databaseUrl) is set the hub persists messages
 * and devices in PostgreSQL (migrations auto-applied) and serves the default
 * mapping table from the DB; otherwise it falls back to the in-memory stores.
 */
import BetterSqlite3 from 'better-sqlite3';
import { SqliteLocalSettingsStore } from '@integration-hub/api';
import { closeDbPool, createDbPool, runMigrations, ApiServer, DeviceRegistry, InMemoryAuditStore, InMemoryFeatureFlagStore, InMemoryKeyStore, InMemoryLicenseStore, InMemoryQuotaStore, MessageStore, PostgresAuditStore, PostgresDeviceRegistry, PostgresIngestStore, PostgresKeyStore, PostgresMessageStore, PostgresOrgStore, PostgresFacilityStore, PostgresOutbox, SqliteAuditStore, SqliteAdmissionRegistry, SqliteAlertStore, SqliteDeviceRegistry, SqliteDedupStore, SqliteKeyStore, SqliteMessageStore, SqliteOrderRegistry, SqliteOutbox, SqliteProfileStore, SqliteRouteStore, SqliteWebhookStore, openSqliteDatabase, bootstrapCloudOrg, type AuditStore, type DeviceBackend, type KeyStore, type SqliteDb, type StoreBackend } from '@integration-hub/api';
import { AstmGateway } from '@integration-hub/gateway';
import { DicomOrthancAdapter } from '@integration-hub/dicom';
import { deliverHl7, Hl7Gateway, MllpConnectionPool } from '@integration-hub/hl7';
import { DEFAULT_MAPPINGS, defaultLayoutFor, type CanonicalMessage } from '@integration-hub/shared';
import { ImagingRouter } from './imaging-router.js';
import { ModalityMonitor } from './modality-monitor.js';
import { MwlMonitor } from './mwl-monitor.js';
import { ACME_CHEM_200_PROFILE, AlertService, DEFAULT_UNIT_CATALOG, Dispatcher, EventBus, InMemoryAdmissionRegistry, InMemoryAlertStore, InMemoryDedupStore,  InMemoryOrderRegistry, InMemoryProfileStore, InMemoryRouteStore, InMemoryGatewayRegistry, OutboxSyncer, PostgresAdmissionRegistry, PostgresAlertStore, PostgresDedupStore, PostgresOrderRegistry, PostgresProfileStore, PostgresRouteStore, PostgresWebhookStore, REFERENCE_PROFILE, UpdateAgent, loadGoldenForProfile, type AdmissionRegistry, type AlertRule, type AlertStore, type Destination, type DispatcherOptions, type OrderRegistry, type ProfileStore, type RouteStore, type ValidationConfig, type WebhookEventType, type WebhookSubscription } from '@integration-hub/core';
import { evaluateEntitlement, type FleetRoutesOptions } from '@integration-hub/api';
import type { NetworkSettings, OrthancSettings } from '@integration-hub/api';
import type { Pool } from 'pg';

/** PEM key + cert pair (HUB_TLS_KEY / HUB_TLS_CERT). */
export interface HubTls {
  key: string;
  cert: string;
}

export interface HubOptions {
  devicePort?: number;
  /**
   * Port for the inbound HL7 v2 MLLP listener (env HL7_PORT). When unset the
   * HL7 gateway is not started — the hub speaks ASTM only.
   */
  hl7Port?: number;
  httpPort?: number;
  host?: string;
  /** PEM key+cert: TLS-terminate BOTH the API (https) and device listener. */
  tls?: HubTls;
  mappings?: Record<string, string>;
  /** PostgreSQL connection string; falls back to the DATABASE_URL env var. */
  databaseUrl?: string;
  /**
   * W1 SQLite edge backend (D12): the embedded single-file store — the
   * Windows-desktop/local-edge mode with no Docker and no DB service.
   * `file` defaults to `<stateDir?> /hub.sqlite` (or HUB_SQLITE_FILE).
   * Precedence: explicit `sqlite` > `DB=sqlite` > `databaseUrl` > in-memory.
   */
  sqlite?: {
    /** DB file path (env HUB_SQLITE_FILE); default `./hub.sqlite` under stateDir. */
    file?: string;
  };
  /** Disable the patient/order matching hold (safety bypass; tests only). */
  matchOnUnmatched?: 'hold' | 'deliver';
  /** Skip seeding the default alert rules (tests/demos bring their own). */
  seedDefaultAlerts?: boolean;
  /**
   * Fixed admin key secret (env HUB_ADMIN_KEY). When unset, one is generated
   * and printed on first boot. Auth is ON by default; set authDisabled to
   * turn it off (dev only).
   */
  adminKey?: string;
  /** Disable API auth entirely (AUTH_DISABLED=1; local/dev only). */
  authDisabled?: boolean;
  /**
   * Signed-update state dir (env HUB_STATE_DIR). When set (and the hub runs
   * under the supervisor) the update agent + /api/v1/updates/* are live.
   */
  stateDir?: string;
  /**
   * D3 webhook event bus: subscriptions seeded at boot (tests/demos bring
   * their own; the webhook-subscriptions REST surface manages them at runtime
   * from D3 slice 3). The bus itself is always present — with zero
   * subscriptions `fire()` is a no-op, so wiring the fire points is free.
   */
  webhooks?: {
    subscriptions?: WebhookSubscription[];
    /** `source` stamped on every event envelope (default `hub:<host>`). */
    source?: string;
  };
  /** Signed-manifest source: https URL, .json path, or dir (env UPDATE_SOURCE). */
  updateSource?: string;
  /** PEM update public key (env UPDATE_PUBLIC_KEY) that must sign manifests. */
  updatePublicKey?: string;
  /**
   * Orthanc (workstream M3.2/M3.3): when set the hub runs the MWL study
   * monitor + the imaging storage router (env ORTHANC_URL / ORTHANC_USER /
   * ORTHANC_PASSWORD / MWL_POLL_MS). Present on hub as `hub.mwl`/`hub.imaging`.
   */
  orthanc?: {
    baseUrl: string;
    username?: string;
    password?: string;
    pollMs?: number;  /**
   * Forward performed studies to this Orthanc peer (M3.3 storage routing;
   * env ORTHANC_FORWARD_PEER — the peer must be configured in Orthanc, e.g.
   * via the adapter's configurePeer). Pixels move Orthanc→PACS; the hub
   * only triggers + records the routing.
   */
  forwardPeer?: string;
    /**
     * Modality C-ECHO cadence (env MODALITY_POLL_MS; default 30s). Orthanc's
     * configured DICOM modalities are mirrored into the device registry.
     */
    modalityPollMs?: number;
  };
  /**
   * Cloud tenancy (H1): when the hub runs as a cloud instance it bootstraps a
   * single org + first facility on the PG store (if present) and stamps every
   * device + message written through the PG stores with org_id/facility_id.
   * Absent → single-tenant edge mode (org_id/facility_id null, RLS permissive).
   */
  cloudOrg?: { orgName?: string; facilityName?: string; adminKeyName?: string };
  /**
   * Cloud tenancy context (H1): when set, every PG-backed write is stamped with
   * the current org_id + facility_id and RLS is pointed at the cloud org. Absent
   * on a single-tenant edge. Exposed on the returned Hub so callers can pass it
   * down to the PG stores for write-through.
   */
  cloudContext?: { orgId: string; facilityId: string; admin: boolean } | undefined;

  /**
   * D11 edge→cloud sync (plan §7.G G4): when set, the hub runs the outbox
   * syncer — unacked outbox rows ship to the cloud ingest over the
   * outbound-only channel (PRD §42). Env: HUB_CLOUD_URL + HUB_GATEWAY_ID +
   * HUB_GATEWAY_KEY (the H3 provisioning bundle's values).
   */
  cloudSync?: {
    cloudBaseUrl: string;
    gatewayId: string;
    apiKey: string;
    /** Batch size per POST (default 200). */
    batchSize?: number;
    /** Poll cadence ms (default 5000). */
    pollMs?: number;
  };

  /**
   * M4 cloud mode (plan §7.H): mount the fleet surface on the API — gateway
   * registry (H3 pairing), sync ingest (D11), facilities + fleet overview
   * (H2), platform flags/quotas (H4), licenses + entitlements + analytics
   * export (H5). Requires cloudOrg (the fleet belongs to an org) + Postgres.
   */
  fleet?: {
    /** Profiles handed to edges in the provisioning bundle (default: none). */
    provisioningProfiles?: (facilityId: string) => Promise<unknown[]>;
  };
  /**
   * W2 first-boot setup (docs/windows-desktop-installer.md §4.5): serve the
   * /api/v1/setup/* flow and defer the auto admin-key print until completion.
   * Default: auto-on for the SQLite backend (local mode), off otherwise.
   * Env: HUB_LOCAL_SETUP=1 forces on; =0 forces off.
   */
  localSetup?: { enabled?: boolean };
  };

export interface Hub {
  gateway: AstmGateway;
  /** Present when hl7Port is configured (inbound HL7 v2 listener). */
  hl7?: Hl7Gateway;
  api: ApiServer;
  store: StoreBackend;
  devices: DeviceBackend;
  dispatcher: Dispatcher;
  routes: RouteStore;
  orders: OrderRegistry;
  admissions: AdmissionRegistry;
  alerts: AlertService;
  alertStore: AlertStore;
  profileStore: ProfileStore;
  /** Present when Orthanc is configured: the M3.2 MWL study monitor. */
  mwl?: MwlMonitor;
  /**
   * Present when Orthanc is configured: C-ECHOes Orthanc's modalities into
   * device rows + device-offline alerts (M3 C6 modality health).
   */
  modalities?: ModalityMonitor;
  /**
   * Present when Orthanc is configured: routes performed studies through the
   * dispatcher (M3.3 storage routing — dedup → DB-driven rules → delivery).
   */
  imaging?: ImagingRouter;
  /** API-key auth + audit (present unless authDisabled). */
  keys?: KeyStore;
  audit?: AuditStore;
  /**
   * D3 webhook event bus (always present; `fire()` no-ops with zero
   * subscriptions). Domain events are fired at the hub's real seams: message
   * recorded/failed (result.received/failed, message.failed), device state
   * flips (device.connected/disconnected) and order registration
   * (order.received).
   */
  webhooks: EventBus;
  ports: { device: number; hl7?: number; http: number };
  /** Present when the M4 fleet surface is mounted (cloud mode). */
  fleetRegistry?: InMemoryGatewayRegistry | undefined;
  /** Present when the D11 edge→cloud syncer runs (paired edge). */
  syncer?: OutboxSyncer | undefined;
  /** Present when running on PostgreSQL. */
  db?: { pool: Pool } | undefined;
  /** Present when running on the embedded SQLite store (W1 edge mode). */
  sqlite?: { db: SqliteDb; file: string } | undefined;
  /** W2 first-boot setup surface (local mode) — settings store + key store.
   *  W3 §8.3: `listeners` reports the ports this process actually bound. */
  setup?:
    | {
        settings: SqliteLocalSettingsStore;
        keys?: KeyStore;
        listeners?: () => { host: string; device?: number; hl7?: number; http?: number };
      }
    | undefined;
  stop(): Promise<void>;
  cloudContext?: { orgId: string; facilityId: string; admin: boolean } | undefined;
}

export async function startHub(opts: HubOptions = {}): Promise<Hub> {
  let host = opts.host ?? '127.0.0.1';
  // W1 backend selection (D12): explicit SQLite opts > DB=sqlite env > PG
  // (DATABASE_URL) > in-memory. SQLite is checked first because a local edge
  // must never accidentally reach for a DB server that is not there.
  const sqliteRequested = opts.sqlite !== undefined || process.env.DB === 'sqlite';
  const databaseUrl = sqliteRequested ? undefined : opts.databaseUrl ?? process.env.DATABASE_URL;

  let store: StoreBackend;
  let devices: DeviceBackend;
  let routes: RouteStore;
  let dedup: DispatcherOptions['dedup'];
  let orders: OrderRegistry;
  let admissions: AdmissionRegistry;
  let alertStore: AlertStore;
  let profileStore: ProfileStore;
  let mappings = opts.mappings ?? DEFAULT_MAPPINGS;
  let pool: Pool | undefined;
  let keys: KeyStore | undefined;
  let audit: AuditStore | undefined;
  let cloudContext: { orgId: string; facilityId: string; admin: boolean } | undefined;
  let sqliteDb: SqliteDb | undefined;
  let localSettings: SqliteLocalSettingsStore | undefined;

  const authDisabled = opts.authDisabled ?? process.env.AUTH_DISABLED === '1';
  const adminKeySecret = opts.adminKey ?? process.env.HUB_ADMIN_KEY;
  const stateDir = opts.stateDir ?? process.env.HUB_STATE_DIR;
  const sqliteFile = opts.sqlite?.file ?? process.env.HUB_SQLITE_FILE ?? (stateDir ? `${stateDir}/hub.sqlite` : 'hub.sqlite');
  const updateSource = opts.updateSource ?? process.env.UPDATE_SOURCE;
  const updatePublicKey = opts.updatePublicKey ?? process.env.UPDATE_PUBLIC_KEY;
  let orthancUrl = opts.orthanc?.baseUrl ?? process.env.ORTHANC_URL;
  // D11 edge→cloud sync (env fallback: the H3 provisioning bundle writes these
  // into the edge's environment/state dir; opts win).
  const cloudSyncOpts = opts.cloudSync
    ? opts.cloudSync
    : process.env.HUB_CLOUD_URL && process.env.HUB_GATEWAY_ID && process.env.HUB_GATEWAY_KEY
      ? {
          cloudBaseUrl: process.env.HUB_CLOUD_URL,
          gatewayId: process.env.HUB_GATEWAY_ID,
          apiKey: process.env.HUB_GATEWAY_KEY,
        }
      : undefined;
  let orthancUser = opts.orthanc?.username ?? process.env.ORTHANC_USER;
  let orthancPass = opts.orthanc?.password ?? process.env.ORTHANC_PASSWORD;
  const envPollMs = Number(process.env.MWL_POLL_MS);
  const orthancPollMs = opts.orthanc?.pollMs ?? (Number.isFinite(envPollMs) && envPollMs > 0 ? envPollMs : 60_000);
  const tls = opts.tls ?? (await loadTlsFromEnv());
  // W2 first-boot setup (§4.5): auto-on for the SQLite local edge, off for
  // cloud/PG/in-memory unless explicitly forced via env or opts.
  const envLocalSetup = process.env.HUB_LOCAL_SETUP;
  const localSetupEnabled =
    opts.localSetup?.enabled ?? (envLocalSetup === '1' ? true : envLocalSetup === '0' ? false : sqliteRequested);

  if (sqliteRequested) {
    // W1 SQLite edge mode (D12): the embedded single-file store. No Docker,
    // no DB service — the file IS the store. Same seams, same seeding, same
    // auth bootstrap as the PG path below.
    sqliteDb = openSqliteDatabase((file) => new BetterSqlite3(file), sqliteFile, { log: (line) => console.log(line) });
    console.log(`[db] sqlite edge store: ${sqliteFile}`);
    // W2 first-boot settings live in the same store (same durability).
    localSettings = new SqliteLocalSettingsStore(sqliteDb);
    const sqliteStore = new SqliteMessageStore(sqliteDb);
    const sqliteDevices = new SqliteDeviceRegistry(sqliteDb);
    store = sqliteStore;
    devices = sqliteDevices;
    routes = new SqliteRouteStore(sqliteDb);
    dedup = new SqliteDedupStore(sqliteDb);
    orders = new SqliteOrderRegistry(sqliteDb);
    admissions = new SqliteAdmissionRegistry(sqliteDb);
    alertStore = new SqliteAlertStore(sqliteDb);
    profileStore = new SqliteProfileStore(sqliteDb);
    if (!authDisabled) {
      keys = new SqliteKeyStore(sqliteDb);
      audit = new SqliteAuditStore(sqliteDb);
    }
    // Seed the default mapping table so edge mappings match scaffold defaults.
    if (!opts.mappings) sqliteStore.setMappings(DEFAULT_MAPPINGS);
    mappings = opts.mappings ?? sqliteStore.getMappings();
    // D11 write-through on a paired edge: the outbox is the sync backlog AND
    // the local crash-recovery journal (same-transaction append, G4).
    if (cloudSyncOpts) {
      const outbox = new SqliteOutbox(sqliteDb);
      sqliteStore.outbox = outbox;
      sqliteDevices.outbox = outbox;
    }
  } else if (databaseUrl) {
    pool = createDbPool(databaseUrl);
    const applied = await runMigrations(pool);
    if (applied.length > 0) console.log(`[db] applied migrations: ${applied.join(', ')}`);

    const pgStore = new PostgresMessageStore(pool);
    store = pgStore;
    devices = new PostgresDeviceRegistry(pool);
    // D11 + H1 write-through: attach the outbox + cloud tenancy stamps BEFORE
    // the stores see their first write. On a cloud instance (cloudOrg) the
    // same stamps scope the API to the org; on a paired edge (cloudSync) they
    // mark every row with the facility it ships for.
    if (cloudSyncOpts) {
      const outbox = new PostgresOutbox(pool);
      pgStore.outbox = outbox;
      devices.outbox = outbox;
    }
    routes = new PostgresRouteStore(pool);
    dedup = new PostgresDedupStore(pool);
    orders = new PostgresOrderRegistry(pool);
    admissions = new PostgresAdmissionRegistry(pool);
    alertStore = new PostgresAlertStore(pool);
    profileStore = new PostgresProfileStore(pool);
    const orgStore = new PostgresOrgStore(pool!);
    const facilityStore = new PostgresFacilityStore(pool!);
    if (!authDisabled) {
      keys = new PostgresKeyStore(pool);
      audit = new PostgresAuditStore(pool);
    }

    // Seed the default mapping table once so DB mappings match scaffold defaults.
    if (!opts.mappings) await pgStore.setMappings(DEFAULT_MAPPINGS);
    mappings = opts.mappings ?? (await pgStore.getMappings());

    // H1 cloud tenancy bootstrap (idempotent): on a PG store, ensure a single
    // cloud org + first facility exist. The bootstrap is the get-started path for
    // a cloud instance; the H3 pairing flow drives onboarding in production.
    // When absent the API is a single-tenant edge (org_id/facility_id null,
    // RLS permissive until enableRlPolicies points it at the cloud org).
    if (opts.cloudOrg) {
      const boot = await bootstrapCloudOrg(orgStore, facilityStore, opts.cloudOrg);
      cloudContext = { orgId: boot.org.id, facilityId: boot.facility.id, admin: false };
      // Point RLS at the cloud org so tenant-scoped reads are isolated to this org.
      await orgStore.enableRlPolicies(boot.org.id, boot.facility.id);
      // H1 write-through (completing the D11 seam the tenancy test named): a
      // cloud instance stamps every device + message it writes with its org.
      (pgStore as { tenancy?: { orgId: string; facilityId: string } }).tenancy = {
        orgId: boot.org.id,
        facilityId: boot.facility.id,
      };
      (devices as { tenancy?: { orgId: string; facilityId: string } }).tenancy = {
        orgId: boot.org.id,
        facilityId: boot.facility.id,
      };
      if (opts.cloudOrg.adminKeyName) {
        const ks = keys as PostgresKeyStore;
        const created = await ks.create({ name: opts.cloudOrg.adminKeyName, role: 'admin', createdBy: 'cloud-bootstrap' });
        cloudContext.admin = true;
        console.log(`[cloud] admin API key created (${created.key.id}): ${created.secret}`);
        console.log(`[cloud] save this secret — it is shown exactly once`);
      }
    }
  } else {
    store = new MessageStore();
    devices = new DeviceRegistry();
    routes = new InMemoryRouteStore();
    dedup = new InMemoryDedupStore();
    orders = new InMemoryOrderRegistry();
    admissions = new InMemoryAdmissionRegistry();
    alertStore = new InMemoryAlertStore();
    profileStore = new InMemoryProfileStore();
    if (!authDisabled) {
      keys = new InMemoryKeyStore();
      audit = new InMemoryAuditStore();
    }
  }

  // ---------------------------------------------------------------------------
  // W3 — first-boot settings apply (§8.3 LAN/imaging polish): a local (SQLite)
  // hub re-reads the W2 setup settings each boot. Stored values FILL UNSET env
  // (env/opts still win — the service definition carries the install-time env
  // contract), so changes made in the console are picked up on the next
  // restart without editing service definitions.
  // ---------------------------------------------------------------------------
  if (localSettings?.isConfigured()) {
    const domains = localSettings.get<{ lab: boolean; imaging: boolean }>('domains');
    const network = localSettings.get<NetworkSettings>('network');
    const orthanc = localSettings.get<OrthancSettings>('orthanc');

    // LAN reach (§8.3): the stored host wins when the env left the listener
    // on loopback — a wizard-configured 0.0.0.0 (LAN) must take effect.
    if (network?.host && host === '127.0.0.1') {
      host = network.host;
      console.log(`[setup]   network host from first-boot settings: ${host}`);
    }
    // Imaging (§8.3): domains.imaging enables the Orthanc wiring — URL from
    // the wizard (default: the colocated bundle endpoint), env can override.
    if (domains?.imaging && !orthancUrl && orthanc?.baseUrl) {
      orthancUrl = orthanc.baseUrl;
      orthancUser = orthancUser ?? orthanc.username;
      orthancPass = orthancPass ?? orthanc.password;
      console.log(`[setup]   imaging enabled — Orthanc at ${orthancUrl}`);
    }
  }

  // M2 security: every API call is authenticated by default. Bootstrap an
  // admin key — from HUB_ADMIN_KEY when set (idempotent: recreates 'admin'
  // to match), otherwise generate one and print it once.
  // W2 local mode: when the hub is unconfigured, the SETUP FLOW mints the
  // key at completion (shown once in the wizard) — so skip the auto print.
  const setupPending = localSetupEnabled && localSettings !== undefined && !localSettings.isConfigured();
  if (keys) {
    const admin = await keys.get('admin');
    if (adminKeySecret) {
      const match = await keys.findBySecret(adminKeySecret);
      if (!match) {
        if (admin) await keys.remove('admin');
        await keys.create({ id: 'admin', name: 'Administrator (HUB_ADMIN_KEY)', role: 'admin', secret: adminKeySecret });
        console.log('[api]     admin key configured from HUB_ADMIN_KEY');
      }
    } else if (!admin && setupPending) {
      console.log('[setup]   first boot — complete setup in the console to create the admin key');
    } else if (!admin) {
      const { secret } = await keys.create({ id: 'admin', name: 'Administrator (auto-generated)', role: 'admin' });
      console.log(`[api]     API auth enabled — generated admin API key:`);
      console.log(`[api]       ${secret}`);
      console.log(`[api]     Console UI and curl need: Authorization: Bearer ${secret}`);
      console.log(`[api]     Set HUB_ADMIN_KEY to pin a fixed key.`);
    }
  } else if (authDisabled) {
    console.log('[api]     API auth DISABLED (AUTH_DISABLED=1) — every /api/v1 route is open');
  }

  // Seed the reference + example certified profiles so CRUD/API demos work and
  // the store never starts empty (goldens/*.json embed the authoritative copy).
  if ((await profileStore.list()).length === 0) {
    await profileStore.upsert(REFERENCE_PROFILE);
    await profileStore.upsert(ACME_CHEM_200_PROFILE);
  }

  // Seed the reference + example certified profiles so CRUD/API demos work and
  // the store never starts empty (goldens/*.json embed the authoritative copy).
  if ((await profileStore.list()).length === 0) {
    await profileStore.upsert(REFERENCE_PROFILE);
    await profileStore.upsert(ACME_CHEM_200_PROFILE);
  }

  const alerts = new AlertService(alertStore, { log: (line) => console.log(line) });
  if (opts.seedDefaultAlerts !== false && (await alertStore.listRules()).length === 0) {
    await alertStore.upsertRule({ id: 'dev-offline', kind: 'device-offline', name: 'Device offline', threshold: 1, channels: ['console'], enabled: true });
    await alertStore.upsertRule({ id: 'dest-down', kind: 'destination-down', name: 'Destination down', threshold: 3, channels: ['console'], enabled: true });
    await alertStore.upsertRule({ id: 'dlq-growth', kind: 'dlq', name: 'Dead-letter queue growing', threshold: 3, channels: ['console'], enabled: true });
    await alertStore.upsertRule({ id: 'held-backlog', kind: 'held-backlog', name: 'Results awaiting review', threshold: 3, channels: ['console'], enabled: true });
    await alertStore.upsertRule({ id: 'profile-drift', kind: 'profile-drift', name: 'Profile drifted', threshold: 1, channels: ['console'], enabled: true });
    // M3.2 — Orthanc MWL down: fires after 3 consecutive failed polls (a
    // single flake does not page); any successful poll resolves it.
    await alertStore.upsertRule({ id: 'orthanc-down', kind: 'orthanc-down', name: 'Orthanc MWL unreachable', threshold: 3, channels: ['console'], enabled: true });
  }

  // D3 — the webhook event bus (PRD §37). Always present: the fire points
  // below call `fireEvent` at the hub's real seams, and with zero subscriptions
  // a fire is a no-op (no network). Deliveries are fire-and-forget — the event
  // bus retries per subscription policy internally and never throws, so a slow
  // subscriber can never hold up the message pipeline.
  const webhookSource = opts.webhooks?.source ?? `hub:${host}`;
  const webhooks = new EventBus({
    subscriptions: opts.webhooks?.subscriptions ?? [],
    // PG mode (D3): subscriptions persist — the bus loads them at boot and
    // writes through on every add/update/remove, so they survive restarts.
    store: pool ? new PostgresWebhookStore(pool) : undefined,
    log: (line) => console.log(line),
  });
  if (pool) await webhooks.ready;
  const fireEvent = (type: WebhookEventType, data: Record<string, unknown>) =>
    webhooks.fire({ type, data, source: webhookSource });

  // ---------------------------------------------------------------------------
  // M4 cloud mode (plan §7.H): fleet surface + D11 syncer.
  // ---------------------------------------------------------------------------
  let fleet: FleetRoutesOptions | undefined;

  // D11 — the edge syncer: ships unacked outbox rows to the cloud over the
  // outbound-only channel. Started only when configured (a plain edge or a
  // cloud instance has nothing to ship). Never blocks the pipeline: failures
  // log + retry on the next tick; the outbox IS the durable backlog.
  let syncer: OutboxSyncer | undefined;
  if (cloudSyncOpts && pool) {
    const outbox = new PostgresOutbox(pool);
    syncer = new OutboxSyncer({
      reader: outbox,
      ...cloudSyncOpts,
      pollMs: cloudSyncOpts.pollMs ?? (Number.isFinite(Number(process.env.HUB_SYNC_POLL_MS)) && Number(process.env.HUB_SYNC_POLL_MS) > 0 ? Number(process.env.HUB_SYNC_POLL_MS) : undefined),
      log: (line) => console.log(line),
    });
    syncer.start();
    console.log(`[sync]    outbox syncer enabled — shipping to ${cloudSyncOpts.cloudBaseUrl} as gateway ${cloudSyncOpts.gatewayId}`);
  }

  // H3/H2/H4/H5 — the fleet surface (cloud instances only; needs the org).
  let fleetRegistry: InMemoryGatewayRegistry | undefined;
  if (opts.fleet && pool && cloudContext) {
    fleetRegistry = new InMemoryGatewayRegistry(
      15 * 60 * 1000,
      '', // cloudBaseUrl is per-deployment; the bundle stamps it from env
      opts.fleet.provisioningProfiles ?? (async () => []),
    );
    const ingestStore = new PostgresIngestStore(pool);
    const flags = new InMemoryFeatureFlagStore();
    const quotas = new InMemoryQuotaStore();
    const licenses = new InMemoryLicenseStore();
    fleet = {
      gateways: fleetRegistry,
      ingest: {
        store: ingestStore,
        // Gateway credentials verify against the H3 registry (hash compare).
        authorizer: {
          verify: (gatewayId, apiKey) => fleetRegistry!.verifyIngestCredential(gatewayId, apiKey),
        },
        recordSync: (gatewayId, seq) => fleetRegistry!.recordSync(gatewayId, seq).then(() => undefined),
      },
      orgs: {
        get: async (idOrSlug) => {
          const org = await new PostgresOrgStore(pool!).get(idOrSlug);
          return org ? { id: org.id, name: org.name, slug: org.slug } : undefined;
        },
      },
      facilities: new PostgresFacilityStore(pool!),
      flags,
      quotas,
      licenses,
      overview: {
        facilities: () => new PostgresFacilityStore(pool!).list(cloudContext!.orgId),
        facilityStats: async (facilityId) => {
          const [messages, deviceStats] = await Promise.all([
            pool!.query<{ n: string }>(`SELECT count(*) AS n FROM messages WHERE facility_id = $1`, [facilityId]),
            pool!.query<{ total: string; connected: string }>(
              `SELECT count(*) AS total, count(*) FILTER (WHERE state = 'connected') AS connected FROM devices WHERE facility_id = $1`,
              [facilityId],
            ),
          ]);
          return {
            messages: Number(messages.rows[0]!.n),
            devices: Number(deviceStats.rows[0]!.total),
            connected: Number(deviceStats.rows[0]!.connected),
          };
        },
      },
      entitlements: {
        forFacility: async (facilityId) => {
          const license = await licenses.forFacility(facilityId);
          return evaluateEntitlement(license);
        },
      },
    };
    console.log('[fleet]   cloud fleet surface enabled (H2/H3/H4/H5) — /api/v1/fleet, /api/v1/provision, /api/v1/sync, /api/v1/licenses');
  }

  // The dispatcher owns delivery: match (E6) → validate (E5) → dedup → route
  // → queue → retry → DLQ (plan §5.3). Matching is the clinical safety gate:
  // results that don't uniquely match a registered order are HELD, not delivered.
  // Delivery/alert + D3-webhook wiring shared by the lab dispatcher and the
  // imaging dispatcher (M3.3): a successful delivery clears the
  // destination-down alert, a failure raises it, and DLQ growth re-checks the
  // backlog alert. D3 fire points live here so BOTH dispatchers emit domain
  // events at the same lifecycle moments.
  const alertEvents = (): NonNullable<DispatcherOptions['events']> => ({
    onRecorded: (message) => {
      // A new lab message entered the pipeline (imaging study events carry no
      // `payload` — they have no result.* lifecycle; message.failed covers them).
      if (!message.payload) return;
      void fireEvent('result.received', {
        messageId: message.id,
        protocol: message.protocol,
        deviceId: message.deviceId,
        accession: message.payload.order.id,
        patientId: message.payload.patient.id,
        sampleId: message.payload.order.sampleId,
      });
    },
    onDelivery: async (event) => {
      if (event.ok) await alerts.deliverySucceeded(event.destinationId);
      else await alerts.deliveryFailed(event.destinationId, event.error ?? 'delivery failed');
    },
    onDlq: async (message, reason) => {
      // message.failed is the generic DLQ event (lab AND imaging); result.failed
      // additionally fires for lab results (the PRD §37 result lifecycle).
      void fireEvent('message.failed', {
        messageId: message.id,
        protocol: message.protocol,
        deviceId: message.deviceId,
        kind: message.imaging ? 'imaging' : 'result',
        reason,
      });
      if (message.payload) {
        void fireEvent('result.failed', {
          messageId: message.id,
          accession: message.payload.order.id,
          patientId: message.payload.patient.id,
          reason,
        });
      }
      await alerts.checkBacklog('dlq', (await store.list({ dlq: true, limit: 500 })).length);
    },
  });

  // Outbound connection manager (B3.3 refinement): one held-open MLLP
  // connection per destination endpoint, reused across deliveries.
  const hl7OutboundPool = new MllpConnectionPool({ debug: (line) => console.log(`[outbound:hl7] ${line}`) });

  // B3.3 outbound HL7 deliverer, shared by every dispatcher the hub wires
  // (results + imaging/M3.3): `hl7` destinations deliver over MLLP with one
  // held-open connection pool per (host, port). A non-AA application ACK
  // throws → retry per policy → DLQ with the MSA-3 reason — never dropped.
  const deliverHl7Destination = async (destination: Destination, message: CanonicalMessage): Promise<void> => {
    if (destination.kind !== 'hl7' || !destination.hl7) throw new Error(`cannot deliver kind ${destination.kind} over HL7`);
    await deliverHl7(destination.hl7, message, {
      pool: hl7OutboundPool,
      debug: (line) => console.log(`[outbound:hl7] ${line}`),
    });
  };

  const dispatcher = new Dispatcher({
    store,
    dedup,
    routes,
    matching: {
      registry: orders,
      config: { strategies: [['patientId', 'orderId'], ['patientId', 'sampleId']], onUnmatched: opts.matchOnUnmatched ?? 'hold' },
    },
    validation: { config: defaultValidationConfig(mappings) },
    // B3.3 — outbound HL7: deliver `hl7` destinations over MLLP (the
    // integration core stays protocol-blind; this is the only HL7-aware wire).
    // A non-AA application ACK throws → the dispatcher retries per policy,
    // then DLQs with the MSA-3 reason — never silently dropped. Deliveries
    // share one held-open connection pool per (host, port) — LIS peers
    // expect persistent MLLP connections (reconnect + idle close handled).
    deliver: deliverHl7Destination,
    events: {
      ...alertEvents(),
      onHold: async () => alerts.checkBacklog('held-backlog', (await store.list({ status: 'HELD', limit: 500 })).length),
      onRelease: async () => alerts.checkBacklog('held-backlog', (await store.list({ status: 'HELD', limit: 500 })).length),
    },
    log: (line) => console.log(line),
  });
  dispatcher.start();

  // A4 AdapterRegistry seam: registered device → DeviceProfile binding. The
  // gateway canonicalizes that device's stream with the profile's layout +
  // code mappings instead of the generic reference layout.
  //
  // Profile version stamping: the binding carries the profile's identity, and
  // `certifiedVersion` is read from the profile's golden file (the version
  // its transcripts were recorded under). Golden files are static per deploy,
  // so the lookup is cached per hub process; the gateway compares it against
  // the STORED version on every message and flags drift when an edit after
  // certification bumped (or rolled back) the version.
  const certifiedByProfile = new Map<string, Promise<number | undefined>>();
  const certifiedVersionFor = (id: string): Promise<number | undefined> => {
    let cached = certifiedByProfile.get(id);
    if (!cached) {
      cached = loadGoldenForProfile(id)
        .then((found) => found?.golden.profile.version)
        .catch(() => undefined);
      certifiedByProfile.set(id, cached);
    }
    return cached;
  };
  const resolveProfile = async (deviceId: string) => {
    const device = await devices.get(deviceId);
    if (!device?.profileId) return undefined;
    const profile = await profileStore.get(device.profileId);
    if (!profile) return undefined;
    return {
      layout: defaultLayoutFor(profile),
      mappings: profile.mappings,
      profile: { id: profile.id, version: profile.version },
      certifiedVersion: await certifiedVersionFor(profile.id),
    };
  };

  // Device-state seam shared by both gateways: auto-register wire devices in
  // the registry (keyed by protocol) and feed the device-offline alerts.
  const onDeviceState = (protocol: 'ASTM' | 'HL7') => async (deviceId: string, state: 'connected' | 'disconnected') => {
    try {
      await devices.upsertFromConnection({ id: deviceId, protocol, transport: 'tcp', state });
    } catch (err) {
      console.error(`[gateway] device state update failed: ${(err as Error).message}`);
    }
    await alerts.deviceState(deviceId, state).catch((err) => console.error(`[alerts] ${(err as Error).message}`));
    // D3: every registry state flip from a wire gateway is a domain event.
    void fireEvent(state === 'connected' ? 'device.connected' : 'device.disconnected', {
      deviceId,
      protocol,
      state,
    });
  };

  const gateway = new AstmGateway({
    host,
    port: opts.devicePort ?? 0,
    sink: dispatcher,
    mappings,
    ...(tls ? { tls } : {}),
    resolveProfile,
    onDeviceState: onDeviceState('ASTM'),
    // Drift alert seam: a bound device delivering under a profile whose
    // stored version drifted from its goldens fires profile-drift (page); a
    // non-drifted delivery resolves it. The message itself is still stamped
    // + FLAGGED — this makes the annotation operational.
    onDrift: (event) => {
      alerts.profileDrift(event).catch((err) => console.error(`[alerts] ${(err as Error).message}`));
    },
    onSessionError: (err) => console.error(`[gateway] session error: ${err.message}`),
  });

  // Workstream B: the inbound HL7 v2 leg. Same dispatcher sink, mappings,
  // TLS and device-state seams as the ASTM gateway — an ORU^R01 over MLLP
  // flows through the exact same lifecycle (dedup → match → HELD → route).
  const hl7Gateway = opts.hl7Port !== undefined
    ? new Hl7Gateway({
        host,
        port: opts.hl7Port ?? 0,
        sink: dispatcher,
        mappings,
        ...(tls ? { tls } : {}),
        // B4 — profile-bound HL7 parsing: a device registered with an HL7
        // profile (its `hl7` segment-level layout) is canonicalized with that
        // profile's positions + delimiters; unbound devices parse generically.
        resolveLayout: async (deviceId) => {
          const device = await devices.get(deviceId);
          if (!device?.profileId) return undefined;
          const profile = await profileStore.get(device.profileId);
          return profile?.hl7;
        },
        // B2c — the LIS seam: inbound ORM^O01 order messages register the
        // expected order (replacing the manual POST /api/v1/orders flow);
        // matching then sees it, so results against it route instead of HELD.
        orders: {
          register: (order) => {
            const registered = { ...order, receivedAt: order.receivedAt ?? new Date().toISOString() };
            // D3: the LIS feed registering an expected order is order.received.
            void fireEvent('order.received', {
              orderId: registered.id,
              patientId: registered.patientId,
              sampleId: registered.sampleId,
              tests: registered.tests,
              status: registered.status,
            });
            return orders.register(registered);
          },
        },
        // B2c extension — the ADT patient-admission feed: ADT^A01/A04/A08
        // register the patient admission (the patient-side LIS master feed).
        admissions: {
          register: (admission) => admissions.register({ ...admission, receivedAt: admission.receivedAt ?? new Date().toISOString() }),
        },
        onDeviceState: onDeviceState('HL7'),
        onSessionError: (err) => console.error(`[gateway] HL7 session error: ${err.message}`),
      })
    : undefined;

  // M2 installer/update: when a state dir is configured, the update agent
  // reads/writes release state there so the supervisor (which owns the hub
  // process) can swap + health-gate signed releases. Without a source/public
  // key the agent is present but disabled (status is still reported).
  let updates: UpdateAgent | undefined;
  if (stateDir) {
    updates = new UpdateAgent({ stateDir, source: updateSource, publicKeyPem: updatePublicKey });
    console.log(`[updates] agent ${updates.enabled ? 'enabled' : 'present but disabled (set UPDATE_SOURCE + UPDATE_PUBLIC_KEY)'} — state dir ${stateDir}`);
  }

  // Workstream M3.2 + M3.3 — the MWL study monitor + imaging storage router
  // (enabled by ORTHANC_URL / the opts.orthanc block). The monitor pushes
  // active registry orders onto the real Orthanc worklist and polls performed
  // studies; each performed study is then routed by the IMAGING dispatcher —
  // a second, gate-free Dispatcher instance over the same store/dedup/routes:
  // imaging events are not lab results (no patient matching, no E5 validation)
  // but they dedup, follow the DB-driven route rules, retry and DLQ exactly
  // like any message. The accession is retired only after routing succeeds.
  let mwl: MwlMonitor | undefined;
  let modalities: ModalityMonitor | undefined;
  let imaging: ImagingRouter | undefined;
  if (orthancUrl) {
    const orthancAdapter = new DicomOrthancAdapter({ baseUrl: orthancUrl, username: orthancUser, password: orthancPass });
    const forwardPeer = opts.orthanc?.forwardPeer ?? process.env.ORTHANC_FORWARD_PEER;
    const imagingDispatcher = new Dispatcher({
      store,
      dedup,
      routes,
      // No matching/validation — the imaging event pipeline (protocol-blind
      // core: dedup → route → deliver → ROUTED/DLQ). Like the results
      // dispatcher, `hl7` destinations deliver over MLLP (shared pool) and
      // fail → retry → DLQ when the peer is unreachable.
      deliver: deliverHl7Destination,
      events: alertEvents(),
      log: (line) => console.log(line),
    });
    imagingDispatcher.start();
    imaging = new ImagingRouter(imagingDispatcher);
    mwl = new MwlMonitor({
      baseUrl: orthancUrl,
      username: orthancUser,
      password: orthancPass,
      adapter: orthancAdapter,
      pollMs: orthancPollMs,
      orders,
      admissions,
      // M3.3: route the study metadata through the dispatcher, then (when a
      // PACS peer is configured) forward the pixels Orthanc→peer. Only when
      // both succeed is the accession retired — a failure leaves it re-syncable
      // so the next cycle re-routes (never a lost study event).
      onPerformed: async (performed) => {
        await imaging!.routePerformed(performed);
        if (forwardPeer) {
          for (const p of performed) {
            await orthancAdapter.storeToPeer(forwardPeer, [{ id: p.study.orthancId, type: 'Study' }]);
            console.log(`[mwl]   forwarded study ${p.study.orthancId.slice(0, 8)}… to Orthanc peer ${forwardPeer}`);
          }
        }
      },
      // M3.2 alerting (workstream I): consecutive failed polls raise the
      // `orthanc-down` alert (subject = this Orthanc's base URL), any
      // successful poll clears it — surfaced in the console + webhook channels
      // like every other alert.
      // Await the alert update (the monitor's reportOutcome try/catches it) so
      // the write stays inside the poll chain — hub.stop drains the chain
      // before closing the pool, instead of an unhandled rejection racing it.
      alerts: { orthancPoll: (ok, error) => alerts.orthancPoll(orthancUrl, ok, error) },
      // M3 C6 — Orthanc health as a device (PRD §32–33): every poll outcome
      // flips the `orthanc` device row (connected/disconnected + lastSeen) in
      // the same registry the gateways auto-register wire devices into, so the
      // Devices panel shows the imaging server's health like any modality.
      // The device id matches the deviceId imaging messages carry, and the
      // orthanc-down alert (above) holds the failure detail + thresholds.
      onPollOutcome: async ({ ok }) => {
        // Awaited (the monitor's reportOutcome try/catches it) so the write
        // stays inside the poll chain — hub.stop drains the chain before
        // closing the pool, instead of the flip racing an ended pool. The
        // webhook fire stays fire-and-forget: the bus retries internally and
        // never throws.
        try {
          await devices.upsertFromConnection({
            id: 'orthanc',
            name: 'Orthanc',
            protocol: 'DICOM',
            transport: 'api',
            state: ok ? 'connected' : 'disconnected',
          });
        } catch (err) {
          console.error(`[mwl] device state update failed: ${(err as Error).message}`);
        }
        // D3: the Orthanc health row is a device like any other.
        void fireEvent(ok ? 'device.connected' : 'device.disconnected', {
          deviceId: 'orthanc',
          protocol: 'DICOM',
          state: ok ? 'connected' : 'disconnected',
        });
      },
      log: (line) => console.log(line),
    });
    mwl.start();
    console.log(`[mwl]    Orthanc study monitor enabled — ${orthancUrl} (sync+poll every ${orthancPollMs}ms; performed studies route through the dispatcher${forwardPeer ? ` and forward to peer ${forwardPeer}` : ''})`);

    // M3 C6 — Orthanc-registered modalities as devices: the DICOM modalities
    // Orthanc has configured are mirrored into the device registry and the
    // device-offline alerting, one row per modality (protocol DICOM, same
    // auto-registration seam the wire gateways use). C-ECHO runs on its own
    // cadence (modality probes are independent of the MWL sync). Rows for
    // auto-registered DICOM devices that are no longer configured are dropped,
    // so the Devices panel tracks Orthanc's actual modality list — the
    // manually-registered `orthanc` row (id 'orthanc') and any API-registered
    // devices are left alone.
    const envModalityPollMs = Number(process.env.MODALITY_POLL_MS);
    const modalityPollMs = opts.orthanc?.modalityPollMs ?? (Number.isFinite(envModalityPollMs) && envModalityPollMs > 0 ? envModalityPollMs : 30_000);
    modalities = new ModalityMonitor({
      baseUrl: orthancUrl,
      username: orthancUser,
      password: orthancPass,
      adapter: orthancAdapter,
      pollMs: modalityPollMs,
      onStates: async (states) => {
        const seen = new Set<string>();
        for (const s of states) {
          seen.add(s.name);
          try {
            await devices.upsertFromConnection({ id: s.name, name: s.name, protocol: 'DICOM', transport: 'tcp', state: s.state });
          } catch (err) {
            console.error(`[modality] device state update failed: ${(err as Error).message}`);
          }
          await alerts.deviceState(s.name, s.state).catch((err) => console.error(`[alerts] ${(err as Error).message}`));
          // D3: each Orthanc-registered modality flip is a domain event too.
          void fireEvent(s.state === 'connected' ? 'device.connected' : 'device.disconnected', {
            deviceId: s.name,
            protocol: 'DICOM',
            state: s.state,
          });
        }
        // Reconcile: drop auto-registered DICOM rows whose modality vanished
        // from Orthanc's config (never the orthanc row itself).
        try {
          for (const d of await devices.list()) {
            if (d.id !== 'orthanc' && d.autoRegistered && d.protocol === 'DICOM' && !seen.has(d.id)) {
              await devices.remove(d.id);
            }
          }
        } catch (err) {
          console.error(`[modality] device reconcile failed: ${(err as Error).message}`);
        }
      },
      log: (line) => console.log(line),
    });
    modalities.start();
    console.log(`[modality] Orthanc modality health monitor enabled — C-ECHO ${modalityPollMs}ms cadence`);
  }

  // W3 §8.3: the setup status echoes the listeners this process actually
  // bound — evaluated per request via these lets (ports are assigned by the
  // .start() calls below, after the ApiServer is constructed).
  let boundDevice: number | undefined;
  let boundHl7: number | undefined;
  let boundHttp: number | undefined;
  const setupListeners = (): { host: string; device?: number; hl7?: number; http?: number } => ({
    host,
    ...(boundDevice !== undefined ? { device: boundDevice } : {}),
    ...(boundHl7 !== undefined ? { hl7: boundHl7 } : {}),
    ...(boundHttp !== undefined ? { http: boundHttp } : {}),
  });

  const api = new ApiServer({
    host,
    port: opts.httpPort ?? 0,
    tls,
    store,
    devices,
    routes,
    orders,
    admissions,
    // M3.2/M3.3: the MWL monitor surface (status + live worklist at
    // GET /api/v1/mwl) and the imaging study-status view (GET /api/v1/imaging,
    // store-backed). Both present only when Orthanc is configured.
    mwl,
    imaging: imaging !== undefined,
    // D3 slice 3: the REST surface manages subscriptions on the live bus.
    webhooks,
    // M4 cloud surface (H2/H3/H4/H5 + D11 ingest) — undefined on an edge.
    fleet,
    // W2 first-boot setup surface (local mode) — undefined elsewhere.
    // W3 §8.3: the status route also reports the bound listeners.
    ...(localSetupEnabled && localSettings
      ? { setup: { settings: localSettings, keys, listeners: setupListeners } }
      : {}),
    alerts: alertStore,
    profiles: profileStore,
    mappings,
    keys,
    audit,
    updates,
    replayHandler: (message) => gateway.replay(message),
    releaseHandler: (id) => dispatcher.release(id),
    // M3.4 — dead-letter retry: requeue under the CURRENT route rules. Imaging
    // messages are hub-originated (no records to re-canonicalize), so they
    // retry through the imaging dispatcher; lab messages through the lab one.
    retryHandler: async (id) => {
      const message = await store.get(id);
      if (!message) return false;
      if (message.imaging) return imaging ? imaging.dispatcher.retry(id) : false;
      return dispatcher.retry(id);
    },
  });

  const { port: devicePort } = await gateway.start();
  const hl7Port = hl7Gateway ? (await hl7Gateway.start()).port : undefined;
  const { port: httpPort } = await api.start();
  boundDevice = devicePort;
  boundHl7 = hl7Port;
  boundHttp = httpPort;
  if (hl7Gateway && hl7Port !== undefined) {
    console.log(`[gateway] HL7 v2 (MLLP) listening on tcp://${host}:${hl7Port} — ORU^R01 in, app ACK out`);
  }

  if (tls) {
    console.log('[tls]     API + device listener are TLS-terminated (HTTPS / TLS on both endpoints)');
  }

  // H1: stamp the cloud operating context onto the returned Hub so callers can
  // pass it down to the PG stores for write-through (devices + messages).
  const hub: Hub = {
    gateway,
    ...(hl7Gateway ? { hl7: hl7Gateway } : {}),
    api,
    store,
    devices,
    dispatcher,
    routes,
    orders,
    admissions,
    alerts,
    alertStore,
    profileStore,
    webhooks,
    mwl,
    modalities,
    imaging,
    keys,
    audit,
    ports: { device: devicePort, ...(hl7Port !== undefined ? { hl7: hl7Port } : {}), http: httpPort },
    db: pool ? { pool } : undefined,
    ...(sqliteDb ? { sqlite: { db: sqliteDb, file: sqliteFile } } : {}),
    ...(localSetupEnabled && localSettings ? { setup: { settings: localSettings, keys, listeners: setupListeners } } : {}),
    stop: async () => {
      if (mwl) await mwl.stop();
      if (modalities) await modalities.stop();
      if (imaging) await imaging.dispatcher.stop();
      if (syncer) await syncer.stop();
      await dispatcher.stop();
      await api.stop();
      await gateway.stop();
      if (hl7Gateway) await hl7Gateway.stop();
      await hl7OutboundPool.close();
      if (pool) await closeDbPool(pool);
      sqliteDb?.close();
    },
    cloudContext,
    ...(fleetRegistry ? { fleetRegistry } : {}),
    ...(syncer ? { syncer } : {}),
  };
  return hub;
}

/**
 * Default validation configuration (PRD §28). The test catalog derives from
 * the active mapping table (canonical codes); unit and plausibility rules are
 * conservative (warn-level) so the safe matching hold stays the main gate.
 */

/** Reads HUB_TLS_CERT / HUB_TLS_KEY (file paths) when both are set. */
async function loadTlsFromEnv(): Promise<HubTls | undefined> {
  const certPath = process.env.HUB_TLS_CERT;
  const keyPath = process.env.HUB_TLS_KEY;
  if (!certPath || !keyPath) return undefined;
  const { readFile } = await import('node:fs/promises');
  const [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
  return { cert, key };
}

function defaultValidationConfig(mappings: Record<string, string>): ValidationConfig {
  const testCatalog = [...new Set(Object.values(mappings))];
  return {
    rules: {
      patientMatched: { enabled: true, severity: 'error' },
      orderExists: { enabled: true, severity: 'error' },
      testKnown: { enabled: true, severity: 'warn' },
      unitRecognized: { enabled: true, severity: 'warn' },
      resultPlausible: { enabled: true, severity: 'error' },
      deviceAuthorized: { enabled: false, severity: 'error' },
    },
    testCatalog,
    unitCatalog: DEFAULT_UNIT_CATALOG,
    // Plausibility seeds. Bounds are unit-dependent: these assume the
    // US-style conventions the reference simulator emits (mg/dL for
    // metabolites, g/dL for hemoglobin). Per-site config replaces them
    // for the facility's unit convention — a mismatch shows up as HELD
    // messages, which is exactly the safety gate working.
    numericBounds: {
      GLUCOSE: { min: 10, max: 600 },          // mg/dL
      CREATININE: { min: 0.1, max: 25 },       // mg/dL
      UREA: { min: 2, max: 200 },              // mg/dL
      SODIUM: { min: 90, max: 180 },           // mmol/L
      POTASSIUM: { min: 1, max: 10 },          // mmol/L
      CHLORIDE: { min: 60, max: 140 },         // mmol/L
      CALCIUM: { min: 5, max: 15 },            // mg/dL
      ALT: { min: 1, max: 1000 },              // U/L
      AST: { min: 1, max: 1000 },              // U/L
      GGT: { min: 1, max: 1000 },              // U/L
      ALKALINE_PHOSPHATASE: { min: 1, max: 2000 }, // U/L
      WBC: { min: 0.1, max: 300 },             // 10^3/uL
      RBC: { min: 0.5, max: 10 },              // 10^6/uL
      HEMOGLOBIN: { min: 3, max: 25 },         // g/dL
      HEMATOCRIT: { min: 5, max: 70 },         // %
      PLATELET_COUNT: { min: 10, max: 1500 },  // 10^3/uL
      NEUTROPHILS: { min: 0.1, max: 30 },      // 10^3/uL
      LYMPHOCYTES: { min: 0.1, max: 30 },      // 10^3/uL
    },
  };
}