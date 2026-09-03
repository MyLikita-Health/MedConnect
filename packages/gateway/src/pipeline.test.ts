import { test } from 'node:test';
import assert from 'node:assert/strict';
import { astmToCanonical, buildMessage } from './pipeline.js';
import { DEFAULT_MAPPINGS } from './mappings.js';
import type { AstmRecord } from '@integration-hub/astm';

const GOOD: AstmRecord[] = [
  { type: 'H', fields: ['\\^&', '', '', '', 'SIM-BS430^SIM-001', '', '', '', '', '', '', 'P', '1', '20260903143000'] },
  { type: 'P', fields: ['1', '', 'PID-9001', 'Doe^John', '', '19900101', 'M'] },
  { type: 'O', fields: ['1', 'S-48291', 'ACC-991001', '^GLU^Glucose'] },
  { type: 'R', fields: ['1', '^GLU^Glucose', '95', 'mg/dL', '70-110', 'N', '', 'F'] },
  { type: 'R', fields: ['2', '^CREA^Creatinine', '1.1', 'mg/dL', '0.6-1.3', 'N', '', 'F'] },
  { type: 'L', fields: ['1', 'N'] },
];

test('astmToCanonical extracts patient, order and results', () => {
  const { payload, issues } = astmToCanonical(GOOD, DEFAULT_MAPPINGS);
  assert.deepEqual(issues, []);
  assert.equal(payload?.patient.id, 'PID-9001');
  assert.equal(payload?.patient.name, 'Doe, John');
  assert.equal(payload?.patient.dateOfBirth, '19900101');
  assert.equal(payload?.patient.gender, 'M');
  assert.equal(payload?.order.id, 'ACC-991001');
  assert.equal(payload?.order.sampleId, 'S-48291');
  assert.equal(payload?.order.tests[0]?.code, 'GLU');
  assert.equal(payload?.results.length, 2);
});

test('mapping converts analyzer codes to canonical codes, preserving originals', () => {
  const { payload } = astmToCanonical(GOOD, DEFAULT_MAPPINGS);
  const glu = payload!.results[0]!;
  const crea = payload!.results[1]!;
  assert.equal(glu.testCode, 'GLUCOSE');
  assert.equal(glu.originalTestCode, 'GLU');
  assert.equal(crea.testCode, 'CREATININE');
  assert.equal(crea.originalTestCode, 'CREA');
});

test('unmapped codes pass through unchanged', () => {
  const records: AstmRecord[] = [
    { type: 'H', fields: ['\\^&', '', '', '', 'SIM-X^1', '', '', '', '', '', '', 'P', '1', '20260903143000'] },
    { type: 'P', fields: ['1', '', 'P1', 'One^Test', '', '19800101', 'M'] },
    { type: 'O', fields: ['1', 'S1', 'ACC1', '^MYSTERY^Test'] },
    { type: 'R', fields: ['1', '^MYSTERY^Test', '1.0', 'U/L', '0-2', 'N', '', 'F'] },
    { type: 'L', fields: ['1', 'N'] },
  ];
  const { payload, issues } = astmToCanonical(records, DEFAULT_MAPPINGS);
  assert.deepEqual(issues, []);
  assert.equal(payload?.results[0]?.testCode, 'MYSTERY');
  assert.equal(payload?.results[0]?.originalTestCode, undefined);
});

test('missing patient identifier is a validation failure', () => {
  const records = GOOD.map((r) =>
    r.type === 'P' ? { ...r, fields: ['1', '', '', 'Doe^John', '', '19900101', 'M'] } : r,
  );
  const { payload, issues } = astmToCanonical(records, DEFAULT_MAPPINGS);
  assert.equal(payload, null);
  assert.ok(issues.some((i) => i.includes('patient')));
});

test('no result records is a validation failure', () => {
  const records = GOOD.filter((r) => r.type !== 'R');
  const { payload, issues } = astmToCanonical(records, DEFAULT_MAPPINGS);
  assert.equal(payload, null);
  assert.ok(issues.some((i) => i.includes('result')));
});

test('buildMessage envelopes with timeline and FAILED status on bad input', () => {
  const good = buildMessage(GOOD, GOOD.map((r) => `${r.type}|${r.fields.join('|')}`).join('\r\n'), {
    deviceId: 'SIM-BS430',
    mappings: DEFAULT_MAPPINGS,
  });
  assert.equal(good.status, 'MAPPED');
  assert.equal(good.protocol, 'ASTM');
  assert.ok(good.timeline.some((t) => t.stage === 'MAPPED'));

  const bad = buildMessage([{ type: 'P', fields: ['1', '', '', 'No^Id'] }], 'P|1|||No^Id', {
    deviceId: 'SIM-BS430',
    mappings: DEFAULT_MAPPINGS,
  });
  assert.equal(bad.status, 'FAILED');
  assert.ok(bad.errors.length > 0);
});