/**
 * Edge gateway process: wires the ASTM gateway, the message store, the device
 * registry and the REST API together (PRD §8 Architecture layers).
 */
import { ApiServer, DeviceRegistry, MessageStore } from '@integration-hub/api';
import { AstmGateway, DEFAULT_MAPPINGS } from '@integration-hub/gateway';

export interface HubOptions {
  devicePort?: number;
  httpPort?: number;
  host?: string;
  mappings?: Record<string, string>;
}

export interface Hub {
  gateway: AstmGateway;
  api: ApiServer;
  store: MessageStore;
  devices: DeviceRegistry;
  ports: { device: number; http: number };
}

export async function startHub(opts: HubOptions = {}): Promise<Hub> {
  const host = opts.host ?? '127.0.0.1';
  const mappings = opts.mappings ?? DEFAULT_MAPPINGS;

  const store = new MessageStore();
  const devices = new DeviceRegistry();

  const gateway = new AstmGateway({
    host,
    port: opts.devicePort ?? 0,
    sink: store,
    mappings,
    onDeviceState: (deviceId, state) => {
      devices.upsertFromConnection({ id: deviceId, protocol: 'ASTM', transport: 'tcp', state });
    },
    onSessionError: (err) => console.error(`[gateway] session error: ${err.message}`),
  });

  const api = new ApiServer({
    host,
    port: opts.httpPort ?? 0,
    store,
    devices,
    mappings,
    replayHandler: (message) => gateway.replay(message),
  });

  const { port: devicePort } = await gateway.start();
  const { port: httpPort } = await api.start();

  return { gateway, api, store, devices, ports: { device: devicePort, http: httpPort } };
}