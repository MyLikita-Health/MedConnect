/**
 * ASTM E1381 framing: STX <records> ETX|ETB <checksum>.
 *
 * The checksum is the 8-bit (mod 256) sum of all bytes from STX through the
 * ETX/ETB terminator, inclusive, rendered as two uppercase hex digits.
 * Some devices exclude STX from the sum; that variant is a configuration
 * point (see `checksumIncludesStx`) for real-world adapters.
 */
import { CONTROL } from './controls.js';

export interface FrameOptions {
  checksumIncludesStx?: boolean;
}

export interface DecodedFrame {
  /** Record lines contained in the frame (CR-separated, CR/LF stripped). */
  records: string[];
  /** True when the frame was terminated by ETB (more frames follow). */
  more: boolean;
  /** Number of bytes consumed from the start of the buffer. */
  consumed: number;
  checksumOk: boolean;
  expectedChecksum: string;
  actualChecksum: string;
  /** True when the buffer does not yet contain a complete frame. */
  incomplete: boolean;
}

const INCOMPLETE: DecodedFrame = {
  records: [],
  more: false,
  consumed: 0,
  checksumOk: false,
  expectedChecksum: '',
  actualChecksum: '',
  incomplete: true,
};

/** Mod-256 sum of every byte in `body`. */
export function computeChecksum(body: Buffer): number {
  let sum = 0;
  for (const byte of body) sum = (sum + byte) & 0xff;
  return sum;
}

/**
 * Encode records into one ASTM frame. Each record is terminated by CR as
 * required by E1381; the frame ends with ETX (last) or ETB (more to come)
 * followed by the two-hex-digit checksum.
 */
export function encodeFrame(records: string[], opts: { last?: boolean } = {}): Buffer {
  const last = opts.last ?? true;
  const text = records.map((r) => r + '\r').join('');
  const frame = Buffer.concat([
    Buffer.from([CONTROL.STX]),
    Buffer.from(text, 'ascii'),
    Buffer.from([last ? CONTROL.ETX : CONTROL.ETB]),
  ]);
  const checksum = computeChecksum(frame);
  const hex = checksum.toString(16).toUpperCase().padStart(2, '0');
  return Buffer.concat([frame, Buffer.from(hex, 'ascii')]);
}

/** Decode the first complete frame at (or after) `offset` in `buffer`. */
export function decodeFrame(buffer: Buffer, offset = 0): DecodedFrame {
  // Locate STX (tolerate padding bytes such as LF/CR/NUL before the frame).
  let start = offset;
  while (start < buffer.length && buffer[start] !== CONTROL.STX) start++;
  if (start >= buffer.length) return INCOMPLETE;

  // Locate the terminator.
  let end = start + 1;
  while (end < buffer.length && buffer[end] !== CONTROL.ETX && buffer[end] !== CONTROL.ETB) end++;
  if (end >= buffer.length) return INCOMPLETE;

  const terminator = buffer[end];
  const frameEnd = end + 1; // exclusive, just past ETX/ETB
  if (buffer.length < frameEnd + 2) return INCOMPLETE; // checksum not yet arrived

  const checksumChars = buffer.subarray(frameEnd, frameEnd + 2).toString('ascii');
  const expected = parseInt(checksumChars, 16);
  const computed = computeChecksum(buffer.subarray(start, frameEnd));
  const actual = computed.toString(16).toUpperCase().padStart(2, '0');

  const body = buffer.subarray(start + 1, end).toString('ascii');
  const records = body
    .split('\r')
    .map((s) => s.replace(/^[\n\r]+|[\n\r]+$/g, ''))
    .filter((s) => s.length > 0);

  return {
    records,
    more: terminator === CONTROL.ETB,
    consumed: frameEnd + 2 - offset,
    checksumOk: !Number.isNaN(expected) && expected === computed,
    expectedChecksum: checksumChars,
    actualChecksum: actual,
    incomplete: false,
  };
}