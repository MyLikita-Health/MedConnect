/**
 * Edge gateway process: wires the ASTM gateway, the message store, the device
 * registry and the REST API together (PRD §8 Architecture layers).
 *
 * M0: when DATABASE_URL (or opts.databaseUrl) is set the hub persists messages
 * and devices in PostgreSQL (migrations auto-applied) and serves the default
 * mapping table from the DB; otherwise it falls back to the in-memory stores.
 */
import { closeDbPool, createDbPool, runMigrations, ApiServer, DeviceRegistry, MessageStore, PostgresDeviceRegistry, PostgresMessageStore, type DeviceBackend, type StoreBackend } from '@integration-hub/api';
import { AstmGateway } from '@integration-hub/gateway';
import { DEFAULT_MAPPINGS } from '@integration-hub/shared';
import { DEFAULT_UNIT_CATALOG, AlertService, Dispatcher, InMemoryAlertStore, InMemoryDedupStore, InMemoryOrderRegistry, InMemoryRouteStore, PostgresAlertStore, PostgresDedupStore, PostgresOrderRegistry, PostgresRouteStore, type AlertRule, type AlertStore, type DispatcherOptions, type OrderRegistry, type RouteStore, type ValidationConfig } from '@integration-hub/core';
import type { Pool } from 'pg';

export interface HubOptions {
  devicePort?: number;
  httpPort?: number;
  host?: string;
  mappings?: Record<string, string>;
  /** PostgreSQL connection string; falls back to the DATABASE_URL env var. */
  databaseUrl?: string;
  /** Disable the patient/order matching hold (safety bypass; tests only). */
  matchOnUnmatched?: 'hold' | 'deliver';
  /** Skip seeding the default alert rules (tests/demos bring their own). */
  seedDefaultAlerts?: boolean;
}

export interface Hub {
  gateway: AstmGateway;
  api: ApiServer;
  store: StoreBackend;
  devices: DeviceBackend;
  dispatcher: Dispatcher;
  routes: RouteStore;
  alerts: AlertService;
  alertStore: AlertStore;
  ports: { device: number; http: number };
  /** Present when running on PostgreSQL. */
  db?: { pool: Pool };
  stop(): Promise<void>;
}

export async function startHub(opts: HubOptions = {}): Promise<Hub> {
  const host = opts.host ?? '127.0.0.1';
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;

  let store: StoreBackend;
  let devices: DeviceBackend;
  let routes: RouteStore;
  let dedup: DispatcherOptions['dedup'];
  let orders: OrderRegistry;
  let alertStore: AlertStore;
  let mappings = opts.mappings ?? DEFAULT_MAPPINGS;
  let pool: Pool | undefined;

  if (databaseUrl) {
    pool = createDbPool(databaseUrl);
    const applied = await runMigrations(pool);
    if (applied.length > 0) console.log(`[db] applied migrations: ${applied.join(', ')}`);

    const pgStore = new PostgresMessageStore(pool);
    store = pgStore;
    devices = new PostgresDeviceRegistry(pool);
    routes = new PostgresRouteStore(pool);
    dedup = new PostgresDedupStore(pool);
    orders = new PostgresOrderRegistry(pool);
    alertStore = new PostgresAlertStore(pool);

    // Seed the default mapping table once so DB mappings match scaffold defaults.
    if (!opts.mappings) await pgStore.setMappings(DEFAULT_MAPPINGS);
    mappings = opts.mappings ?? (await pgStore.getMappings());
  } else {
    store = new MessageStore();
    devices = new DeviceRegistry();
    routes = new InMemoryRouteStore();
    dedup = new InMemoryDedupStore();
    orders = new InMemoryOrderRegistry();
    alertStore = new InMemoryAlertStore();
  }

  const alerts = new AlertService(alertStore, { log: (line) => console.log(line) });
  if (opts.seedDefaultAlerts !== false && (await alertStore.listRules()).length === 0) {
    await alertStore.upsertRule({ id: 'dev-offline', kind: 'device-offline', name: 'Device offline', threshold: 1, channels: ['console'], enabled: true });
    await alertStore.upsertRule({ id: 'dest-down', kind: 'destination-down', name: 'Destination down', threshold: 3, channels: ['console'], enabled: true });
    await alertStore.upsertRule({ id: 'dlq-growth', kind: 'dlq', name: 'Dead-letter queue growing', threshold: 3, channels: ['console'], enabled: true });
    await alertStore.upsertRule({ id: 'held-backlog', kind: 'held-backlog', name: 'Results awaiting review', threshold: 3, channels: ['console'], enabled: true });
  }

  // The dispatcher owns delivery: match (E6) → validate (E5) → dedup → route
  // → queue → retry → DLQ (plan §5.3). Matching is the clinical safety gate:
  // results that don't uniquely match a registered order are HELD, not delivered.
  const dispatcher = new Dispatcher({
    store,
    dedup,
    routes,
    matching: {
      registry: orders,
      config: { strategies: [['patientId', 'orderId'], ['patientId', 'sampleId']], onUnmatched: opts.matchOnUnmatched ?? 'hold' },
    },
    validation: { config: defaultValidationConfig(mappings) },
    events: {
      onDelivery: async (event) => {
        if (event.ok) await alerts.deliverySucceeded(event.destinationId);
        else await alerts.deliveryFailed(event.destinationId, event.error ?? 'delivery failed');
      },
      onDlq: async () => alerts.checkBacklog('dlq', (await store.list({ dlq: true, limit: 500 })).length),
      onHold: async () => alerts.checkBacklog('held-backlog', (await store.list({ status: 'HELD', limit: 500 })).length),
      onRelease: async () => alerts.checkBacklog('held-backlog', (await store.list({ status: 'HELD', limit: 500 })).length),
    },
    log: (line) => console.log(line),
  });
  dispatcher.start();

  const gateway = new AstmGateway({
    host,
    port: opts.devicePort ?? 0,
    sink: dispatcher,
    mappings,
    onDeviceState: async (deviceId, state) => {
      try {
        await devices.upsertFromConnection({
          id: deviceId,
          protocol: 'ASTM',
          transport: 'tcp',
          state,
        });
      } catch (err) {
        console.error(`[gateway] device state update failed: ${(err as Error).message}`);
      }
      await alerts.deviceState(deviceId, state).catch((err) => console.error(`[alerts] ${(err as Error).message}`));
    },
    onSessionError: (err) => console.error(`[gateway] session error: ${err.message}`),
  });

  const api = new ApiServer({
    host,
    port: opts.httpPort ?? 0,
    store,
    devices,
    routes,
    orders,
    alerts: alertStore,
    mappings,
    replayHandler: (message) => gateway.replay(message),
    releaseHandler: (id) => dispatcher.release(id),
  });

  const { port: devicePort } = await gateway.start();
  const { port: httpPort } = await api.start();

  return {
    gateway,
    api,
    store,
    devices,
    dispatcher,
    routes,
    alerts,
    alertStore,
    ports: { device: devicePort, http: httpPort },
    db: pool ? { pool } : undefined,
    stop: async () => {
      await dispatcher.stop();
      await api.stop();
      await gateway.stop();
      if (pool) await closeDbPool(pool);
    },
  };
}

/**
 * Default validation configuration (PRD §28). The test catalog derives from
 * the active mapping table (canonical codes); unit and plausibility rules are
 * conservative (warn-level) so the safe matching hold stays the main gate.
 */
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