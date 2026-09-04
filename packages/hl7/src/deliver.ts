/**
 * HL7 outbound delivery (workstream B3.3) — the protocol-side counterpart to
 * the dispatcher's injectable `deliver` seam. Delivers a canonical message to
 * an `hl7` destination over MLLP:
 *
 *   canonical → HL7 wire text (ORU^R01 for results, ORM^O01 for order-only
 *   payloads — `canonicalToOru`/`canonicalToOrm`) → MllpClient → await the
 *   application ACK:
 *
 *     MSA-1 AA            → delivered, resolve (the dispatcher records OK)
 *     MSA-1 AE / AR       → throw with the MSA-3 reason → dispatcher retries,
 *                           then DLQ (never silently dropped — the ACK reason
 *                           surfaces in the attempt/feed)
 *     connection/timeout  → throw (transient; retried per policy)
 *
 * Connection management: pass an `MllpConnectionPool` to reuse held-open MLLP
 * connections (LIS peers expect persistence — the outbound connection
 * manager); without one, each delivery connects, sends, awaits the ACK, and
 * closes (stateless v1).
 */
import net from 'node:net';
import type { CanonicalMessage } from '@integration-hub/shared';
import { canonicalToOru, canonicalToOrm, type OutboundOptions } from './serialize.js';
import { MllpClient } from './mllp-client.js';
import { MllpConnectionPool } from './connection-pool.js';
import { parseMessage, segmentField } from './message.js';

/**
 * Outbound MLLP endpoint (structural match to the integration core's
 * `Hl7DestinationConfig` — the protocol package stays below core, so the
 * shape is duplicated here and core's type flows in structurally).
 */
export interface MllpEndpointConfig {
  host: string;
  port: number;
  sendingApp?: string;
  sendingFacility?: string;
  receivingApp?: string;
  receivingFacility?: string;
  version?: string;
}

export interface Hl7DeliverOptions {
  debug?: (line: string) => void;
  /**
   * Held-open outbound connection manager: when provided, deliveries reuse a
   * persistent MLLP connection per (host, port) instead of opening a fresh
   * one per delivery. The pool owns socket lifecycle + reconnect + idle
   * close; call `close()` at shutdown. When absent, each delivery connects,
   * sends, awaits the ACK and closes (stateless v1).
   */
  pool?: MllpConnectionPool;
}

/** Throw when the ACK is not AA; resolves otherwise. */
export async function deliverHl7(
  destination: MllpEndpointConfig,
  message: CanonicalMessage,
  opts: Hl7DeliverOptions = {},
): Promise<void> {
  const payload = message.payload;
  if (!payload) throw new Error('cannot deliver a message with no canonical payload over HL7');

  // Order-only payloads (no results) go out as an ORM order download; result
  // messages as an ORU. Symmetric with the inbound seam (ORM → registry,
  // ORU → results).
  const outbound: OutboundOptions = {
    sendingApp: destination.sendingApp,
    sendingFacility: destination.sendingFacility,
    receivingApp: destination.receivingApp,
    receivingFacility: destination.receivingFacility,
    version: destination.version,
    // Deterministic control id per message enables the receiver's dedup.
    controlId: `HUB-${message.id.slice(0, 8)}`,
  };
  const wire = payload.results.length > 0 ? canonicalToOru(payload, outbound) : canonicalToOrm(payload, outbound);

  if (opts.pool) {
    // Connection-manager path: reuse a held-open connection; the pool owns
    // the socket (reconnect + idle close). Only the ACK semantics are ours.
    const ack = await opts.pool.send(destination, wire);
    assertAccept(ack);
    return;
  }

  // Stateless v1 path: connect per delivery, await the ACK, close.
  const socket = await connect(destination.host, destination.port);
  try {
    const client = new MllpClient(socket, { debug: opts.debug });
    const ack = await client.send(wire);
    assertAccept(ack);
  } finally {
    socket.destroy();
    // Wait for the close so the connection is fully released (fast path).
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function assertAccept(ack: string): void {
  const msa = parseMessage(ack).segments.find((s) => s.id === 'MSA');
  const status = msa ? segmentField(msa, 0) : undefined;
  if (status !== 'AA') {
    const text = msa ? segmentField(msa, 2) ?? '' : 'no MSA segment in ACK';
    throw new Error(`HL7 destination rejected (${status ?? '?'}): ${text}`);
  }
}

function connect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', (err) => reject(err));
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`MLLP connect timed out to ${host}:${port}`));
    });
  });
}