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
import { Dispatcher, InMemoryDedupStore, InMemoryRouteStore, PostgresDedupStore, PostgresRouteStore, type DispatcherOptions, type RouteStore } from '@integration-hub/core';
import type { Pool } from 'pg';

export interface HubOptions {
  devicePort?: number;
  httpPort?: number;
  host?: string;
  mappings?: Record<string, string>;
  /** PostgreSQL connection string; falls back to the DATABASE_URL env var. */
  databaseUrl?: string;
}

export interface Hub {
  gateway: AstmGateway;
  api: ApiServer;
  store: StoreBackend;
  devices: DeviceBackend;
  dispatcher: Dispatcher;
  routes: RouteStore;
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

    // Seed the default mapping table once so DB mappings match scaffold defaults.
    if (!opts.mappings) await pgStore.setMappings(DEFAULT_MAPPINGS);
    mappings = opts.mappings ?? (await pgStore.getMappings());
  } else {
    store = new MessageStore();
    devices = new DeviceRegistry();
    routes = new InMemoryRouteStore();
    dedup = new InMemoryDedupStore();
  }

  // The dispatcher owns delivery: dedup → route → queue → retry → DLQ (plan §5.3).
  const dispatcher = new Dispatcher({
    store,
    dedup,
    routes,
    log: (line) => console.log(line),
  });
  dispatcher.start();

  const gateway = new AstmGateway({
    host,
    port: opts.devicePort ?? 0,
    sink: dispatcher,
    mappings,
    onDeviceState: (deviceId, state) => {
      try {
        const result = devices.upsertFromConnection({
          id: deviceId,
          protocol: 'ASTM',
          transport: 'tcp',
          state,
        });
        if (result instanceof Promise) {
          result.catch((err) => console.error(`[gateway] device state update failed: ${(err as Error).message}`));
        }
      } catch (err) {
        console.error(`[gateway] device state update failed: ${(err as Error).message}`);
      }
    },
    onSessionError: (err) => console.error(`[gateway] session error: ${err.message}`),
  });

  const api = new ApiServer({
    host,
    port: opts.httpPort ?? 0,
    store,
    devices,
    routes,
    mappings,
    replayHandler: (message) => gateway.replay(message),
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