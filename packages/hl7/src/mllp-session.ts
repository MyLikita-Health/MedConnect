/**
 * Per-connection MLLP session (workstream B1a — the inbound wire side).
 *
 * One session owns one connection: bytes are fed through `MllpDecoder`,
 * every complete message is handed to `onMessage`, and — unless `ack: false`
 * — each message is answered with an application MSH^ACK:
 *
 *   - handler resolves (or returns no decision)  → AA  (accept)
 *   - handler throws                             → AE  with the error text
 *   - handler returns {status, text}             → that status + text
 *
 * Messages on one connection are handled strictly in order and ACKs follow
 * in the same order (the decoder hands messages over asynchronously, so the
 * session chains them). A payload that carries no MSH cannot be acknowledged
 * (there is nothing to echo in MSA-2): the error is surfaced via `onError`
 * and the connection stays usable.
 */
import { buildAck, type AckStatus } from './ack.js';
import { MllpDecoder, wrapMessage } from './mllp.js';
import type { DuplexLike } from './transport.js';

export interface AckDecision {
  /** MSA-1; defaults to AA when the handler does not specify. */
  status?: AckStatus;
  /** MSA-3 reason text (escaped for the wire by the ACK builder). */
  text?: string;
}

export interface MllpSessionOptions {
  /** Handle one complete inbound message; may decide the ACK status/text. */
  onMessage: (payload: string) => AckDecision | void | Promise<AckDecision | void>;
  /** Acknowledge every inbound message (AA / AE). Default true. */
  ack?: boolean;
  onError?: (error: Error) => void;
  onEnd?: () => void;
}

export class MllpSession {
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly ack: boolean;
  private readonly decoder: MllpDecoder;

  constructor(
    private readonly socket: DuplexLike,
    private readonly opts: MllpSessionOptions,
  ) {
    this.ack = opts.ack ?? true;
    this.decoder = new MllpDecoder({
      onMessage: (payload) => {
        // Serialize handling per connection so ACK order follows message order.
        this.chain = this.chain.then(() => this.handle(payload));
        return this.chain;
      },
      onError: (err) => this.opts.onError?.(err),
    });
  }

  start(): void {
    this.socket.on('data', (chunk: Buffer) => this.decoder.feed(chunk));
    this.socket.on('close', () => this.close());
    this.socket.on('error', (err) => this.opts.onError?.(err));
  }

  /** Write one MLLP-wrapped payload back on this connection. */
  send(payload: string): void {
    if (this.closed) return;
    try {
      this.socket.write(wrapMessage(payload));
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Gracefully end the connection (onEnd fires from the socket close). */
  end(): void {
    if (this.closed) return;
    try {
      this.socket.end();
    } catch {
      /* already closed */
    }
  }

  private async handle(payload: string): Promise<void> {
    let decision: AckDecision = {};
    try {
      const result: AckDecision | undefined = (await this.opts.onMessage(payload)) as AckDecision | undefined;
      if (result !== undefined) decision = result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.opts.onError?.(error);
      if (this.ack) this.replyAck(payload, { status: 'AE', text: error.message });
      return;
    }
    if (this.ack) this.replyAck(payload, decision);
  }

  private replyAck(original: string, decision: AckDecision): void {
    try {
      this.send(buildAck(original, { status: decision.status ?? 'AA', text: decision.text }));
    } catch (err) {
      // No MSH in the payload — nothing sane to acknowledge. Surface it (once)
      // and keep the connection alive.
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.opts.onEnd?.();
  }
}
