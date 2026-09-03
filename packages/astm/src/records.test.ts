import { test } from 'node:test';
import assert from 'node:assert/strict';
import { field, parseRecord, serializeRecord, splitComponent, type AstmRecord } from './records.js';

test('parseRecord splits fields and keeps the record type', () => {
  // E1394 header layout: fields[0]=delimiters, [4]=sender "name^id", [11]=P, [12]=version, [13]=timestamp
  const rec = parseRecord('H|\\^&||||SIM^1|||||||P|1|20260903143000');
  assert.equal(rec.type, 'H');
  assert.equal(rec.fields[0], '\\^&');
  assert.equal(rec.fields[4], 'SIM^1');
  assert.equal(rec.fields[11], 'P');
  assert.equal(rec.fields[12], '1');
  assert.equal(rec.fields[13], '20260903143000');
  assert.equal(rec.fields.length, 14);
});

test('serializeRecord emits the canonical E1394 header wire format', () => {
  const rec: AstmRecord = {
    type: 'H',
    fields: ['\\^&', '', '', '', 'SIM^1', '', '', '', '', '', '', 'P', '1', '20260903143000'],
  };
  assert.equal(serializeRecord(rec), 'H|\\^&||||SIM^1|||||||P|1|20260903143000');
  assert.deepEqual(parseRecord(serializeRecord(rec)), rec);
});

test('parseRecord treats unknown single-token records as U', () => {
  const rec = parseRecord('Z|1|2');
  assert.equal(rec.type, 'U');
  assert.deepEqual(rec.fields, ['1', '2']);
});

test('serializeRecord round-trips', () => {
  const line = 'O|1|S-123|ACC-456|^GLU^Glucose';
  const rec = parseRecord(line);
  assert.equal(serializeRecord(rec), line);
});

test('field() is a safe indexer', () => {
  const rec = parseRecord('L|1|N');
  assert.equal(field(rec, 0), '1');
  assert.equal(field(rec, 1), 'N');
  assert.equal(field(rec, 9), undefined);
});

test('splitComponent handles ^ components', () => {
  assert.deepEqual(splitComponent('^GLU^Glucose'), ['', 'GLU', 'Glucose']);
  assert.deepEqual(splitComponent(''), ['']);
});