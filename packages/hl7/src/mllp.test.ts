/**
 * MLLP framing: VT … FS CR wrapping plus the streaming decoder (chunked
 * delivery, multiple messages per chunk, stray-byte tolerance, terminator
 * split across chunks).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MLLP } from './controls.js';
import { MllpDecoder, unwrapMessage, wrapMessage } from './mllp.js';

const PAYLOAD = ['MSH|^~\\&|SENDER|FAC|RECV|FAC2|20260904120000||ORU^R01|C1|P|2.5.1', 'PID|1||P-1'].join('\r');

function collect(): { decoder: MllpDecoder; messages: string[] } {
  const messages: string[] = [];
  const decoder = new MllpDecoder({
    onMessage: (payload) => {
      messages.push(payload);
    },
  });
  return { decoder, messages };
}

test('wrapMessage frames the payload as VT payload FS CR', () => {
  const frame = wrapMessage(PAYLOAD);
  assert.equal(frame[0], MLLP.START);
  assert.equal(frame[frame.length - 2], MLLP.END);
  assert.equal(frame[frame.length - 1], MLLP.CR);
  assert.equal(frame.subarray(1, frame.length - 2).toString('utf8'), PAYLOAD);
});

test('unwrapMessage round-trips a wrapped payload including embedded CRs', () => {
  assert.equal(unwrapMessage(wrapMessage(PAYLOAD)), PAYLOAD);
  assert.equal(unwrapMessage(wrapMessage('')), '');
});

test('unwrapMessage rejects unframed and truncated buffers', () => {
  assert.equal(unwrapMessage(Buffer.from(PAYLOAD, 'utf8')), undefined);
  assert.equal(unwrapMessage(wrapMessage(PAYLOAD).subarray(0, -1)), undefined); // missing CR
  assert.equal(unwrapMessage(wrapMessage(PAYLOAD).subarray(1)), undefined); // missing VT
  assert.equal(unwrapMessage(Buffer.from([MLLP.START])), undefined);
});

test('decoder emits one message per complete frame', () => {
  const { decoder, messages } = collect();
  decoder.feed(wrapMessage(PAYLOAD));
  assert.deepEqual(messages, [PAYLOAD]);
});

test('decoder delivers two messages from a single chunk', () => {
  const { decoder, messages } = collect();
  decoder.feed(Buffer.concat([wrapMessage(PAYLOAD), wrapMessage('second|message')]));
  assert.deepEqual(messages, [PAYLOAD, 'second|message']);
});

test('decoder reassembles a frame delivered byte-by-byte', () => {
  const { decoder, messages } = collect();
  for (const byte of wrapMessage(PAYLOAD)) decoder.feed(Buffer.from([byte]));
  assert.deepEqual(messages, [PAYLOAD]);
});

test('decoder waits when the FS CR terminator is split across chunks', () => {
  const { decoder, messages } = collect();
  const frame = wrapMessage(PAYLOAD);
  decoder.feed(frame.subarray(0, -1)); // everything except the trailing CR
  assert.deepEqual(messages, []);
  decoder.feed(frame.subarray(-1));
  assert.deepEqual(messages, [PAYLOAD]);
});

test('decoder skips stray bytes before the first VT', () => {
  const { decoder, messages } = collect();
  decoder.feed(Buffer.concat([Buffer.from('junk\r\n', 'utf8'), wrapMessage(PAYLOAD)]));
  assert.deepEqual(messages, [PAYLOAD]);
});

test('decoder keeps embedded CRs (segment separators) inside the payload', () => {
  const { decoder, messages } = collect();
  decoder.feed(wrapMessage(PAYLOAD));
  assert.equal(messages[0]!.includes('\r'), true);
});
