/**
 * HL7 application acknowledgment (MSH^ACK): role swap, control-id echo in
 * MSA-2, status codes with escaped reason text, and delimiter/version echo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAck, DEFAULT_ACK_TEXT } from './ack.js';
import { firstSegment, MSH_SLOTS, parseMessage, segmentField } from './message.js';

const ORU = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG0001|P|2.5.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N||F',
].join('\r');

test('buildAck returns a parseable MSH^ACK that echoes the control id and swaps roles', () => {
  const ack = parseMessage(buildAck(ORU));
  assert.deepEqual(
    ack.segments.map((s) => s.id),
    ['MSH', 'MSA'],
  );
  assert.deepEqual(ack.encoding, parseMessage(ORU).encoding);

  const msh = ack.segments[0]!;
  assert.equal(segmentField(msh, MSH_SLOTS.messageType), 'ACK');
  assert.equal(segmentField(msh, MSH_SLOTS.version), '2.5.1');
  assert.equal(segmentField(msh, MSH_SLOTS.processingId), 'P');
  // The ACK's sender is the original receiver (HUB); its receiver is the
  // original sender (ACME_LIS).
  assert.equal(segmentField(msh, MSH_SLOTS.sendingApp), 'HUB');
  assert.equal(segmentField(msh, MSH_SLOTS.receivingApp), 'ACME_LIS');
  // A fresh control id, never the original.
  assert.notEqual(segmentField(msh, MSH_SLOTS.controlId), 'MSG0001');

  const msa = ack.segments[1]!;
  assert.equal(segmentField(msa, 0), 'AA');
  assert.equal(segmentField(msa, 1), 'MSG0001'); // original MSH-10 echoed
  assert.equal(segmentField(msa, 2), DEFAULT_ACK_TEXT.AA);
});

test('AE carries escaped reason text in MSA-3', () => {
  const ack = parseMessage(buildAck(ORU, { status: 'AE', text: 'bad order|id' }));
  const msa = ack.segments[1]!;
  assert.equal(segmentField(msa, 0), 'AE');
  assert.equal(segmentField(msa, 1), 'MSG0001');
  assert.equal(segmentField(msa, 2), 'bad order\\F\\id');
});

test('overrides win for MSH-3 and MSH-10', () => {
  const ack = parseMessage(buildAck(ORU, { status: 'AR', sendingApp: 'MY_HUB', controlId: 'ACK-42' }));
  const msh = ack.segments[0]!;
  assert.equal(segmentField(msh, MSH_SLOTS.sendingApp), 'MY_HUB');
  assert.equal(segmentField(msh, MSH_SLOTS.controlId), 'ACK-42');
  assert.equal(segmentField(ack.segments[1]!, 0), 'AR');
});

test('buildAck accepts an already-parsed message', () => {
  const parsed = parseMessage(ORU);
  const ack = parseMessage(buildAck(parsed));
  assert.equal(segmentField(ack.segments[1]!, 1), 'MSG0001');
});

test('buildAck throws when the original has no MSH segment', () => {
  assert.throws(() => buildAck('PID|1||P-1'), /no MSH segment/);
});
