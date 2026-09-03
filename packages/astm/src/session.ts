/**
 * Host/responder side of an ASTM E1381 session (the middleware).
 *
 * Protocol: the device initiates with ENQ, the host answers ACK, then the
 * device streams STX..ETX/ETB frames with checksums. The host ACKs each valid
 * frame and NAKs corrupted ones. A final ETX frame yields a complete message;
 * EOT terminates the session and the connection is closed.
 *
 * The session is tolerant: it accepts bare ACK/NAK (no frame-number echo) and
 * skips stray padding bytes. Frame-number echoing is a documented configuration
 * point for devices that require it.
 */
import { CONTROL } from './controls.js';
import { decodeFrame } from './frame.js';
import { parseRecord, type AstmRecord } from './records.js';
import type { DuplexLike } from './transport.js';

export interface AstmSessionOptions {
  /** Invoked with all records of one complete ASTM message. */
  onMessage: (records: AstmRecord[]) => void;
  onError?: (error: Error) => void;
  /** Invoked when the session ends (EOT received and ACKed). */
  onEnd?: () => void;
}

export class AstmSession {
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly socket: DuplexLike,
    private readonly opts: AstmSessionOptions,
  ) {}

  start(): void {
    this.socket.on('data', (chunk: Buffer) => this.feed(chunk));
    this.socket.on('close', () => this.close());
    this.socket.on('error', (err: Error) => this.opts.onError?.(err));
  }

  feed(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.process();
  }

  private process(): void {
    while (!this.closed && this.buffer.length > 0) {
      const first = this.buffer[0];

      if (first === CONTROL.ENQ) {
        this.consume(1);
        this.write(Buffer.from([CONTROL.ACK]));
        continue;
      }

      if (first === CONTROL.STX) {
        const frame = decodeFrame(this.buffer);
        if (frame.incomplete) return; // wait for more bytes

        this.consume(frame.consumed);
        if (!frame.checksumOk) {
          this.write(Buffer.from([CONTROL.NAK]));
          this.opts.onError?.(
            new Error(`ASTM checksum mismatch: expected ${frame.expectedChecksum}, computed ${frame.actualChecksum}`),
          );
          continue;
        }

        this.write(Buffer.from([CONTROL.ACK]));
        if (!frame.more) {
          const records = frame.records.map(parseRecord);
          this.opts.onMessage(records);
        }
        continue;
      }

      if (first === CONTROL.EOT) {
        this.consume(1);
        this.write(Buffer.from([CONTROL.ACK]));
        this.close();
        return;
      }

      // Tolerate stray padding (LF/CR/NUL) between frames.
      this.consume(1);
    }
  }

  private consume(n: number): void {
    this.buffer = this.buffer.subarray(n);
  }

  private write(data: Buffer): void {
    try {
      this.socket.write(data);
    } catch {
      /* socket already closed */
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.opts.onEnd?.();
    try {
      this.socket.end();
    } catch {
      /* already closed */
    }
  }
}