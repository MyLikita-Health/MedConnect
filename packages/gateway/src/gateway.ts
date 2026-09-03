/**
 * ASTM edge gateway (PRD §13, §20): listens on TCP, runs one ASTM session per
 * device connection, pushes every complete message through the pipeline into
 * a sink (the API store), and reports device connection state.
 */
import net from 'node:net';
import { AstmSession, serializeRecord, splitComponent, type AstmRecord } from '@integration-hub/astm';
import type { CanonicalMessage, MappingTable, MessageSink } from '@integration-hub/shared';
import { buildMessage } from './pipeline.js';

export interface GatewayOptions {
  host?: string;
  /** TCP port for device connections; 0 picks an ephemeral port (tests). */
  port: number;
  /** Where processed messages are delivered. */
  sink: MessageSink;
  mappings?: MappingTable;
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
    const server = net.createServer((socket) => this.handleConnection(socket));
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

    const raw = records.map(serializeRecord).join('\r\n');
    const message = buildMessage(records, raw, { deviceId, mappings: this.opts.mappings });
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