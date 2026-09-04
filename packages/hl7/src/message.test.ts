/**
 * Minimal HL7 v2 message model: segment/field parsing honouring the message's
 * own MSH delimiters, serialization round-trip, and delimiter escaping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ENCODING,
  MSH_SLOTS,
  allSegments,
  escapeText,
  firstSegment,
  parseMessage,
  segmentField,
  serializeMessage,
  unescapeText,
} from './message.js';

const ORU = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG0001|P|2.5.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'OBR|1|ORD-77|ORD-77|GLU^Glucose|||||||||||||||||||||||F',
  'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N||F',
].join('\r');

test('parseMessage splits segments and fields', () => {
  const msg = parseMessage(ORU);
  assert.deepEqual(
    msg.segments.map((s) => s.id),
    ['MSH', 'PID', 'OBR', 'OBX'],
  );
  const msh = msg.segments[0]!;
  assert.equal(segmentField(msh, MSH_SLOTS.sendingApp), 'ACME_LIS');
  assert.equal(segmentField(msh, MSH_SLOTS.controlId), 'MSG0001');
  assert.equal(segmentField(msh, MSH_SLOTS.messageType), 'ORU^R01');
  const pid = msg.segments[1]!;
  // PID-2 is empty; PID-3 (patient id) is the third stored field.
  assert.equal(segmentField(pid, 2), 'PID-1001^^^FAC1^PI');
});

test('encoding characters are read from MSH-2 of the message itself', () => {
  const msg = parseMessage('MSH|^~\\&|SENDER|FAC|RECV\rPID|1||P1');
  assert.deepEqual(msg.encoding, DEFAULT_ENCODING);
  // MSH-2 lives at fields[0]; default encoding chars are ^ ~ \ &
  assert.equal(msg.segments[0]!.fields[0], '^~\\&');
});

test('parseMessage tolerates CRLF, bare LF and blank padding lines', () => {
  const crlf = ORU.replaceAll('\r', '\r\n');
  const lf = ORU.replaceAll('\r', '\n');
  for (const raw of [crlf, lf, `\r\n${crlf}\r\n`]) {
    const msg = parseMessage(raw);
    assert.equal(msg.segments.length, 4);
  }
});

test('serializeMessage round-trips a parsed message', () => {
  assert.equal(serializeMessage(parseMessage(ORU)), ORU);
});

test('segment accessors find the first and all segments of a type', () => {
  const msg = parseMessage([ORU, 'OBX|2|NM|GLU^Glucose||92|mg/dL|70-110|N||F'].join('\r'));
  assert.equal(firstSegment(msg, 'MSH')?.id, 'MSH');
  assert.equal(firstSegment(msg, 'FOO'), undefined);
  assert.equal(allSegments(msg, 'OBX').length, 2);
  assert.equal(allSegments(msg, 'PID').length, 1);
});

test('escapeText/unescapeText round-trip every delimiter character', () => {
  const nasty = 'room|A^B~C&D\\E';
  const escaped = escapeText(nasty, DEFAULT_ENCODING);
  assert.equal(escaped, 'room\\F\\A\\S\\B\\R\\C\\T\\D\\E\\E');
  assert.equal(unescapeText(escaped, DEFAULT_ENCODING), nasty);
  // Unescaping must not corrupt text with no escapes.
  assert.equal(unescapeText('plain text', DEFAULT_ENCODING), 'plain text');
});
