/**
 * Device/initiator side of an ASTM E1381 session (used by the simulator and by
 * tests to act as an analyzer).
 *
 * Drives a full transmission: ENQ -> ACK, one frame per record with retry on
 * NAK, then EOT. `corruptRate` deliberately corrupts frame checksums to
 * exercise the NAK/retry path.
 */
import { CONTROL } from './controls.js';
import { encodeFrame } from './frame.js';
import { serializeRecord, type AstmRecord } from './records.js';
import type { DuplexLike } from './transport.js';

export interface AstmClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  /** 0..1 chance of sending a corrupted frame (triggers NAK + retry). */
  corruptRate?: number;
  debug?: (line: string) => void;
}

export interface AstmClientResult {
  framesSent: number;
  nakCount: number;
  retries: number;
}

export class AstmClient {
  private buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private closed = false;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly corruptRate: number;
  private readonly debug?: (line: string) => void;

  constructor(
    private readonly socket: DuplexLike,
    opts: AstmClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.corruptRate = opts.corruptRate ?? 0;
    this.debug = opts.debug;
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.on('close', () => {
      this.closed = true;
      this.wake();
    });
    socket.on('error', () => this.wake());
  }

  /** Transmit a full ASTM message (records -> frames -> EOT). */
  async run(records: AstmRecord[]): Promise<AstmClientResult> {
    const result: AstmClientResult = { framesSent: 0, nakCount: 0, retries: 0 };

    this.debug?.('ENQ');
    this.socket.write(Buffer.from([CONTROL.ENQ]));
    await this.expectControl(CONTROL.ACK);

    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      const last = i === records.length - 1;
      let frame = encodeFrame([serializeRecord(record)], { last });
      if (Math.random() < this.corruptRate) frame = corruptChecksum(frame);

      let attempt = 0;
      for (;;) {
        this.debug?.(`frame ${i + 1}/${records.length} (${last ? 'ETX' : 'ETB'}) attempt ${attempt + 1}`);
        this.socket.write(frame);
        result.framesSent++;

        const response = await this.expectControl([CONTROL.ACK, CONTROL.NAK]);
        if (response === CONTROL.NAK) {
          result.nakCount++;
          attempt++;
          if (attempt >= this.maxRetries) {
            throw new Error(`ASTM frame ${i + 1} rejected after ${this.maxRetries} retries (NAK)`);
          }
          result.retries++;
          continue;
        }
        break;
      }
    }

    this.debug?.('EOT');
    this.socket.write(Buffer.from([CONTROL.EOT]));
    return result;
  }

  /** Wait until `byte` is the next control byte in the stream. */
  private async expectControl(targets: number | number[]): Promise<number> {
    const accepted = Array.isArray(targets) ? targets : [targets];
    const deadline = Date.now() + this.timeoutMs;

    for (;;) {
      if (this.buffer.length > 0) {
        const byte = this.buffer[0]!;
        this.buffer = this.buffer.subarray(1);
        if (accepted.includes(byte)) return byte;
        continue; // skip junk (e.g. trailing ACK frame-number digit)
      }
      if (this.closed) throw new Error('ASTM connection closed while waiting for response');
      if (!(await this.waitForData(deadline))) {
        throw new Error(`ASTM timeout waiting for response (${accepted.map((a) => a.toString(16)).join('/')})`);
      }
    }
  }

  private async waitForData(deadline: number): Promise<boolean> {
    if (this.buffer.length > 0) return true;
    if (Date.now() > deadline) return false;
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
    return this.buffer.length > 0;
  }

  private wake(): void {
    const pending = this.waiters.splice(0);
    for (const w of pending) w();
  }
}

/** Flip one byte in the checksum region so the receiver rejects the frame. */
function corruptChecksum(frame: Buffer): Buffer {
  const copy = Buffer.from(frame);
  const last = copy.length - 1;
  copy[last] = copy[last] === 0x30 ? 0x31 : 0x30;
  return copy;
}