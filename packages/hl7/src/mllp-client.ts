/**
 * Outbound MLLP client (workstream B1a — the sender side). Writes MLLP-wrapped
 * HL7 messages on a connection and waits for the application response (an
 * MSH^ACK in hub-to-LIS flows). Responses are queued per connection, so
 * concurrent `send()` calls are answered in arrival order. Reused by the HL7
 * ORU simulator today and by the outbound destination (B3) later.
 */
import { MllpDecoder, wrapMessage } from './mllp.js';
import type { DuplexLike } from './transport.js';

export interface MllpClientOptions {
  /** How long `send()` waits for a response before throwing. */
  timeoutMs?: number;
  debug?: (line: string) => void;
}

export class MllpClient {
  private readonly responses: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private readonly timeoutMs: number;
  private readonly debug?: (line: string) => void;

  constructor(
    private readonly socket: DuplexLike,
    opts: MllpClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.debug = opts.debug;
    const decoder = new MllpDecoder({
      onMessage: (payload) => {
        this.responses.push(payload);
        this.wake();
      },
      onError: (err) => this.debug?.(`[mllp-client] ${err.message}`),
    });
    socket.on('data', (chunk: Buffer) => decoder.feed(chunk));
    socket.on('close', () => {
      this.closed = true;
      this.wake();
    });
    socket.on('error', () => this.wake());
  }

  /** Send one HL7 payload (MLLP-wrapped) and await the next response. */
  async send(payload: string): Promise<string> {
    this.debug?.('-> MLLP send');
    this.socket.write(wrapMessage(payload));
    const response = await this.waitForResponse();
    if (response === undefined) throw new Error('MLLP connection closed before a response arrived');
    this.debug?.('<- response received');
    return response;
  }

  /** Wait for the next queued response (or the connection to close/time out). */
  private async waitForResponse(): Promise<string | undefined> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (this.responses.length > 0) return this.responses.shift();
      if (this.closed) return undefined;
      if (Date.now() > deadline) throw new Error(`MLLP timeout waiting for a response (${this.timeoutMs} ms)`);
      await new Promise<void>((resolve) => {
        const wake = () => {
          const idx = this.waiters.indexOf(wake);
          if (idx >= 0) this.waiters.splice(idx, 1);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, Math.max(1, deadline - Date.now()));
        this.waiters.push(wake);
      });
    }
  }

  private wake(): void {
    const pending = this.waiters.splice(0);
    for (const w of pending) w();
  }
}
