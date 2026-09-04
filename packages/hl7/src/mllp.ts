/**
 * MLLP framing (workstream B1). Each HL7 message travels over TCP as:
 *
 *     VT (0x0b) <payload bytes> FS (0x1c) CR (0x0d)
 *
 * The payload is the raw HL7 text (segments separated by CR); only the FS+CR
 * pair terminates a message, so embedded CRs between segments are safe. This
 * layer is deliberately transport-agnostic — the same `DuplexLike` contract
 * the ASTM layer uses (packages/astm/src/transport.ts) will drive it — and
 * the wire session (inbound server / outbound client, ACK-on-message) is the
 * next B1 slice on top of `MllpDecoder` + `buildAck`.
 */
import { MLLP } from './controls.js';

/** Wrap an HL7 payload in MLLP framing: VT payload FS CR. */
export function wrapMessage(payload: string): Buffer {
  return Buffer.concat([
    Buffer.from([MLLP.START]),
    Buffer.from(payload, 'utf8'),
    Buffer.from([MLLP.END, MLLP.CR]),
  ]);
}

/**
 * Unwrap a complete MLLP frame. Returns the payload when the buffer is
 * exactly one VT … FS CR frame; undefined for anything else (plain payloads,
 * truncated frames, trailing junk). For byte streams use `MllpDecoder`, which
 * tolerates padding and splits frames correctly.
 */
export function unwrapMessage(frame: Uint8Array): string | undefined {
  if (frame.length < 3) return undefined;
  if (frame[0] !== MLLP.START) return undefined;
  const end = frame.length - 2;
  if (frame[end] !== MLLP.END || frame[end + 1] !== MLLP.CR) return undefined;
  return Buffer.from(frame.subarray(1, end)).toString('utf8');
}

export interface MllpDecoderOptions {
  /** Invoked with the full payload of each complete MLLP message. */
  onMessage: (payload: string) => void | Promise<void>;
  onError?: (error: Error) => void;
}

/**
 * Streaming MLLP decoder: feed raw socket bytes in chunks; every complete
 * VT … FS CR frame yields one `onMessage(payload)`. Tolerant like the ASTM
 * session — stray bytes before the first VT are skipped, partial frames
 * (including a terminator split across chunks) wait for more bytes, and
 * multiple messages inside one chunk are all delivered.
 */
export class MllpDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly opts: MllpDecoderOptions) {}

  feed(chunk: Uint8Array): void {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    this.process();
  }

  private process(): void {
    while (this.buffer.length > 0) {
      const start = this.buffer.indexOf(MLLP.START);
      if (start === -1) {
        this.buffer = Buffer.alloc(0); // nothing framed yet — drop stray bytes
        return;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);

      const end = this.findTerminator();
      if (end === -1) return; // incomplete frame — wait for more bytes

      const payload = this.buffer.subarray(1, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 2);
      try {
        void this.opts.onMessage(payload);
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /** Index of FS immediately followed by CR (the frame terminator), else -1. */
  private findTerminator(): number {
    for (let i = 1; i < this.buffer.length - 1; i++) {
      if (this.buffer[i] === MLLP.END && this.buffer[i + 1] === MLLP.CR) return i;
    }
    return -1;
  }
}
