/**
 * ASTM edge gateway (PRD §13, §20): listens on TCP, runs one ASTM session per
 * device connection, pushes every complete message through the pipeline into
 * a sink (the API store), and reports device connection state.
 */
import net from 'node:net';
import tls from 'node:tls';
import { AstmSession, serializeRecord, splitComponent, type AstmRecord } from '@integration-hub/astm';
import type { CanonicalMessage, DeviceRecordLayout, MappingTable, MessageSink } from '@integration-hub/shared';
import { buildMessage } from './pipeline.js';

/** TLS server credentials (PEM). When set the listener is TLS-terminated. */
export interface TlsCredentials {
  key: string;
  cert: string;
}

/**
 * What a device's binding contributes to canonicalization (A4 seam): the
 * DeviceProfile's record layout plus its test-code mappings. `layout` may be
 * partial — missing groups fall back to the reference layout in the pipeline.
 * `profile` carries the binding's identity so every message is stamped with
 * the exact config (id + version) that parsed it; `certifiedVersion` is the
 * profile's golden-recorded version (certification baseline) — when the
 * stored version differs, messages are flagged as drifting.
 */
export interface ProfileBinding {
  layout?: DeviceRecordLayout;
  mappings?: MappingTable;
  profile?: { id: string; version: number };
  certifiedVersion?: number;
}

/**
 * A4 AdapterRegistry seam: resolves the certified DeviceProfile bound to a
 * device (by config — device registry entry → profile id). The server wires
 * this over its device registry + profile store; the gateway stays agnostic.
 */
export type ProfileResolver = (deviceId: string) => ProfileBinding | undefined | Promise<ProfileBinding | undefined>;

export interface GatewayOptions {
  host?: string;
  /** TCP port for device connections; 0 picks an ephemeral port (tests). */
  port: number;
  /** Where processed messages are delivered. */
  sink: MessageSink;
  mappings?: MappingTable;
  /**
   * PEM key + cert: when present the ASTM listener is TLS-terminated
   * (edge packaging §4.3 "encrypted local storage… secure channel", PRD §42).
   * Devices connect with TLS and verify the hub against the facility CA.
   */
  tls?: TlsCredentials;
  /**
   * A4 binding: resolves the DeviceProfile configured for a device so its
   * stream is canonicalized with the profile's layout + code mappings.
   */
  resolveProfile?: ProfileResolver;
  /** Connection-state callbacks keyed by device id (from the H record). */
  onDeviceState?: (deviceId: string, state: 'connected' | 'disconnected') => void;
  onSessionError?: (error: Error) => void;
}

export class AstmGateway {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly deviceBySocket = new Map<net.Socket, string>();

  constructor(private readonly opts: GatewayOptions) {}

  async start(): Promise<{ port: number }> {
    const server = this.opts.tls
      ? tls.createServer({ key: this.opts.tls.key, cert: this.opts.tls.cert }, (socket) => this.handleConnection(socket))
      : net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => resolve());
    });
    const port = (server.address() as net.AddressInfo).port;
    return { port };
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Re-run the pipeline over a stored message (PRD §23 replay). */
  async replay(message: CanonicalMessage): Promise<CanonicalMessage> {
    const replayed = buildMessage(message.records ?? [], message.raw, {
      deviceId: message.deviceId,
      mappings: this.opts.mappings,
      protocol: message.protocol,
      direction: message.direction,
    });
    // Replay re-parses with the global config (no device binding at this
    // point) — keep the original message's profile provenance so a replayed
    // copy stays attributable to the config that first parsed it.
    replayed.profile = message.profile;
    replayed.timeline.unshift({
      stage: 'REPLAYED',
      at: new Date().toISOString(),
      note: `source message ${message.id}`,
    });
    // Delivery (ROUTED / FAILED + DLQ) is owned by the sink (the dispatcher).
    await this.persist(replayed);
    return replayed;
  }

  private handleConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => {
      this.sockets.delete(socket);
      const deviceId = this.deviceBySocket.get(socket);
      this.deviceBySocket.delete(socket);
      if (deviceId) this.opts.onDeviceState?.(deviceId, 'disconnected');
    });

    const session = new AstmSession(socket, {
      onMessage: (records) => this.handleMessage(socket, records),
      onError: (err) => this.opts.onSessionError?.(err),
      onEnd: () => {
        /* connection is closed by the session */
      },
    });
    session.start();
  }

  private async handleMessage(socket: net.Socket, records: AstmRecord[]): Promise<void> {
    const deviceId = deriveDeviceId(records) ?? 'unknown-device';
    this.deviceBySocket.set(socket, deviceId);
    this.opts.onDeviceState?.(deviceId, 'connected');

    // A4 seam: a registered device bound to a certified profile canonicalizes
    // with that profile's layout and code mappings (which override the global
    // mapping table per-device); everything else uses the reference defaults.
    let layout: DeviceRecordLayout | undefined;
    let mappings = this.opts.mappings;
    let binding: ProfileBinding | undefined;
    if (this.opts.resolveProfile) {
      binding = await this.opts.resolveProfile(deviceId);
      if (binding) {
        layout = binding.layout;
        mappings = { ...(this.opts.mappings ?? {}), ...(binding.mappings ?? {}) };
      }
    }

    const raw = records.map(serializeRecord).join('\r\n');
    const message = buildMessage(records, raw, { deviceId, mappings, layout });
    // A4 version stamp: record the exact profile config that parsed this
    // message, and flag drift when its version no longer matches the version
    // its goldens were recorded under (profile edited post-certification). The
    // flag is an annotation — the message is still delivered; the console and
    // operators see the provenance and the drift.
    if (binding?.profile) {
      const { id, version } = binding.profile;
      const drift = binding.certifiedVersion !== undefined && version !== binding.certifiedVersion;
      message.profile = { id, version, ...(binding.certifiedVersion !== undefined ? { certifiedVersion: binding.certifiedVersion, drift } : {}) };
      if (drift) {
        message.timeline.push({
          stage: 'FLAGGED',
          at: new Date().toISOString(),
          note: `profile ${id} v${version} drifted from its certified v${binding.certifiedVersion} (goldens) — verify config before trusting results`,
        });
      }
    }
    // The pipeline produces MAPPED (or FAILED); the sink owns delivery and the
    // ROUTED/DLQ terminal transitions (plan §5.3).
    await this.persist(message);
  }

  /**
   * Deliver to the sink, awaiting async (durable) sinks so persistence
   * failures surface as session errors instead of silently dropping a message.
   */
  private async persist(message: CanonicalMessage): Promise<void> {
    try {
      const result = this.opts.sink.record(message);
      if (result instanceof Promise) await result;
    } catch (err) {
      this.opts.onSessionError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/** Device id from the H record sender name ("name^id"). */
function deriveDeviceId(records: AstmRecord[]): string | undefined {
  const header = records.find((r) => r.type === 'H');
  if (!header) return undefined;
  const sender = splitComponent(header.fields[4] ?? '');
  return sender[0] || sender[1] || undefined;
}