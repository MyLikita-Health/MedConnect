/**
 * Inbound HL7 v2 gateway (workstream B2b) — the HL7 mirror of `AstmGateway`:
 * listens for HL7 peers (LIS/HIS sending ORU^R01), runs one `MllpSession`
 * per connection, and for every message:
 *
 *   parse (platform raw split, for viewer records) → device identity from the
 *   MSH sender → `hl7ToCanonical` → canonical envelope → `sink.record`
 *   (the Dispatcher owns dedup/matching/HELD/route/DLQ) → application ACK.
 *
 * ACK semantics (errors never vanish — same spirit as the ASTM pipeline):
 *   - translate ok + persisted      → AA (accepted; downstream holds/failures
 *     are visible in the hub, the sender must not resend)
 *   - pipeline issues               → AR + the reasons (content rejected; the
 *     message is still recorded FAILED for the viewer/DLQ, never dropped)
 *   - sink/persistence failure      → AE + the error (transient — may retry)
 *
 * Connection state mirrors the ASTM gateway: `onDeviceState(deviceId,
 * 'connected')` fires per message, `'disconnected'` when the connection that
 * carried it closes. TLS termination, mappings and device identity follow the
 * same seams, so the server wiring later composes this next to `AstmGateway`.
 */
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import type { CanonicalMessage, Hl7RecordLayout, LabPayload, MappingTable, MessageSink, ParsedRecord } from '@integration-hub/shared';
import { hl7ToCanonical } from './translate.js';
import { hl7ToOrder, type OrderRegistration } from './order.js';
import { MllpSession, type AckDecision } from './mllp-session.js';
import { MSH_SLOTS, parseMessage } from './message.js';
import type { MllpTlsCredentials } from './mllp-server.js';

/** The LIS seam (workstream B2c): a minimal registry of expected orders. */
export interface OrderFeed {
  /** Register (or update) an expected order. Resolves when persisted. */
  register(order: OrderRegistration): void | Promise<void>;
}

export interface Hl7GatewayOptions {
  host?: string;
  /** TCP port for HL7 peers; 0 picks an ephemeral port (tests). */
  port: number;
  /** Where processed messages are delivered (the Dispatcher in production). */
  sink: MessageSink;
  /** Analyzer/LIS test-code → canonical mappings (PRD §17–18). */
  mappings?: MappingTable;
  /**
   * B4: resolve the sender's HL7 segment-level layout overrides (a certified
   * profile's `hl7` config) from the MSH device identity. When present, the
   * profile's positions replace the generic translator defaults for that
   * device's messages (and its `delimiters` are stamped on the raw wire
   * before parsing). A device without a bound HL7 profile parses generically.
   */
  resolveLayout?: (deviceId: string) => Hl7RecordLayout | undefined | Promise<Hl7RecordLayout | undefined>;
  /**
   * The LIS seam (B2c): when wired, incoming ORM^O01 order messages are
   * translated into the expected-order registry instead of the results
   * pipeline (orders have no results to deliver — the Dispatcher stays
   * untouched). Without it, ORM falls through to the results translator and
   * is rejected loudly.
   */
  orders?: OrderFeed;
  /** PEM key + cert: when present the listener is TLS-terminated. */
  tls?: MllpTlsCredentials;
  /** Connection-state callbacks keyed by the MSH sender identity. */
  onDeviceState?: (deviceId: string, state: 'connected' | 'disconnected') => void;
  onSessionError?: (error: Error) => void;
}

export class Hl7Gateway {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly deviceBySocket = new Map<net.Socket, string>();

  constructor(private readonly opts: Hl7GatewayOptions) {}

  async start(): Promise<{ port: number }> {
    const server = this.opts.tls
      ? tls.createServer({ key: this.opts.tls.key, cert: this.opts.tls.cert }, (socket) => this.handleConnection(socket))
      : net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => resolve());
    });
    return { port: (server.address() as net.AddressInfo).port };
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

  private handleConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => {
      this.sockets.delete(socket);
      const deviceId = this.deviceBySocket.get(socket);
      this.deviceBySocket.delete(socket);
      if (deviceId) this.opts.onDeviceState?.(deviceId, 'disconnected');
    });

    const session = new MllpSession(socket, {
      onMessage: (payload) => this.handleMessage(socket, payload),
      onError: (err) => this.opts.onSessionError?.(err),
    });
    session.start();
  }

  private async handleMessage(socket: net.Socket, payload: string): Promise<AckDecision> {
    const records = parseMessage(payload).segments.map((s): ParsedRecord => ({ type: s.id, fields: s.fields }));
    const deviceId = deriveDeviceId(records) ?? 'unknown-hl7-device';
    this.deviceBySocket.set(socket, deviceId);
    this.opts.onDeviceState?.(deviceId, 'connected');

    // B4 — profile resolution: a certified profile's `hl7` layout overrides
    // the generic translator positions for this device's messages. Both
    // translators (ORU results + ORM orders) honor the same overrides.
    const layout = this.opts.resolveLayout ? await this.opts.resolveLayout(deviceId) : undefined;

    // B2c — the LIS seam: an ORM^O01 order message feeds the expected-order
    // registry directly (no results to deliver). Persisted before the ACK,
    // so the sender never resends a registered order; AR + reasons when it
    // cannot be translated.
    if (this.opts.orders && isOrm(payload)) {
      const { order, issues } = hl7ToOrder(payload, { mappings: this.opts.mappings, layout });
      if (!order) return { status: 'AR', text: issues.join('; ') };
      try {
        const result = this.opts.orders.register(order);
        if (result instanceof Promise) await result;
        return {}; // AA — order registered
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.opts.onSessionError?.(error);
        return { status: 'AE', text: `order registration failed: ${error.message}` };
      }
    }

    const { payload: canonical, issues } = hl7ToCanonical(payload, { mappings: this.opts.mappings, layout });
    const message = buildEnvelope(records, payload, canonical, issues, deviceId);

    try {
      const result = this.opts.sink.record(message);
      if (result instanceof Promise) await result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.opts.onSessionError?.(error);
      return { status: 'AE', text: error.message };
    }

    // Recorded even when rejected: FAILED + issues land in the viewer/DLQ —
    // never silently dropped. The ACK carries the reason so the sender knows.
    if (!canonical) return { status: 'AR', text: issues.join('; ') };
    return {};
  }
}

/** True for the ORM^O01 order trigger (MSH-9). */
function isOrm(payload: string): boolean {
  const msh = parseMessage(payload).segments.find((s) => s.id === 'MSH');
  const type = msh ? msh.fields[MSH_SLOTS.messageType] : undefined;
  return (type ?? '').startsWith('ORM^');
}

/** Device id from the MSH sender (sending application, else facility). */
function deriveDeviceId(records: ParsedRecord[]): string | undefined {
  const msh = records.find((r) => r.type === 'MSH');
  if (!msh) return undefined;
  // Platform records are 0-indexed after the segment id: MSH_SLOTS matches.
  return msh.fields[MSH_SLOTS.sendingApp] ?? msh.fields[MSH_SLOTS.sendingFacility] ?? undefined;
}

/** Envelope mirroring the ASTM pipeline: parse → validate → map timeline. */
function buildEnvelope(
  records: ParsedRecord[],
  raw: string,
  canonical: LabPayload | null,
  issues: string[],
  deviceId: string,
): CanonicalMessage {
  const now = new Date().toISOString();
  const timeline = [
    { stage: 'RECEIVED', at: now },
    { stage: 'PARSED', at: now, note: `${records.length} segment(s)` },
  ];
  if (canonical) {
    timeline.push({ stage: 'VALIDATED', at: now, note: 'all checks passed' });
    timeline.push({ stage: 'MAPPED', at: now, note: `${canonical.results.length} result(s) mapped` });
  } else {
    timeline.push({ stage: 'VALIDATED', at: now, note: `failed: ${issues.length} issue(s)` });
  }

  return {
    id: randomUUID(),
    protocol: 'HL7',
    direction: 'device-to-host',
    deviceId,
    receivedAt: now,
    raw,
    records,
    payload: canonical ?? undefined,
    status: canonical ? 'MAPPED' : 'FAILED',
    errors: issues,
    timeline,
  };
}
