import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL } from './controls.js';
import { computeChecksum, decodeFrame, encodeFrame } from './frame.js';

test('checksum is the mod-256 sum of STX..ETX inclusive', () => {
  // STX 'A' ETX -> 0x02 + 0x41 + 0x03 = 0x46 = '46'
  const frame = Buffer.from([CONTROL.STX, 0x41, CONTROL.ETX]);
  assert.equal(computeChecksum(frame), 0x46);
});

test('encodeFrame produces STX, records with CR, terminator and 2-hex checksum', () => {
  const frame = encodeFrame(['H|\\^&|'], { last: true });
  assert.equal(frame[0], CONTROL.STX);
  assert.equal(frame[frame.length - 3], CONTROL.ETX);
  // checksum of [STX, 'H','|','\\','^','&','|',CR, ETX]
  const expected = computeChecksum(frame.subarray(0, frame.length - 2));
  const hex = frame.subarray(frame.length - 2).toString('ascii');
  assert.equal(hex, expected.toString(16).toUpperCase().padStart(2, '0'));
});

test('decodeFrame round-trips a single-record final frame', () => {
  const records = ['H|\\^&||||SIM^1||||||P|1|20260903143000', 'L|1|N'];
  const frame = encodeFrame(records, { last: true });
  const decoded = decodeFrame(frame);
  assert.equal(decoded.incomplete, false);
  assert.equal(decoded.checksumOk, true);
  assert.equal(decoded.more, false);
  assert.deepEqual(decoded.records, records);
  assert.equal(decoded.consumed, frame.length);
});

test('decodeFrame detects ETB (more frames follow)', () => {
  const frame = encodeFrame(['H|\\^&|'], { last: false });
  const decoded = decodeFrame(frame);
  assert.equal(decoded.more, true);
  assert.equal(decoded.checksumOk, true);
});

test('decodeFrame rejects a corrupted checksum', () => {
  const frame = encodeFrame(['P|1||PID|Doe^John']);
  const corrupted = Buffer.from(frame);
  const last = corrupted.length - 1;
  corrupted[last] = corrupted[last] === 0x30 ? 0x31 : 0x30;
  const decoded = decodeFrame(corrupted);
  assert.equal(decoded.checksumOk, false);
  assert.notEqual(decoded.expectedChecksum, decoded.actualChecksum);
});

test('decodeFrame tolerates leading padding and CRLF line endings', () => {
  const body = Buffer.from('H|A\r\nP|1|B\r\n', 'ascii');
  const frame = Buffer.concat([
    Buffer.from([0x00, CONTROL.LF, CONTROL.STX]),
    body,
    Buffer.from([CONTROL.ETX]),
  ]);
  const checksum = computeChecksum(frame.subarray(2)); // STX onward
  const full = Buffer.concat([frame, Buffer.from(checksum.toString(16).toUpperCase().padStart(2, '0'), 'ascii')]);
  const decoded = decodeFrame(full);
  assert.equal(decoded.checksumOk, true);
  assert.deepEqual(decoded.records, ['H|A', 'P|1|B']);
});

test('decodeFrame reports incomplete when the checksum has not arrived', () => {
  const frame = encodeFrame(['R|1|^GLU|95|mg/dL'], { last: true });
  const truncated = frame.subarray(0, frame.length - 1);
  assert.equal(decodeFrame(truncated).incomplete, true);
});