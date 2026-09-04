/**
 * ORU^R01 → canonical translator (workstream B2a): segment extraction,
 * mapping, failure semantics mirroring the ASTM pipeline, and v1 limits
 * (single order group, ORU-only triggers, no sample id).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HL7Message } from 'hl7v2';
import { hl7ToCanonical } from './translate.js';
import { parseMessage } from './message.js';

const ORU_231 = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG0001|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'OBR|1|ORD-77|ACC-88|GLU^Glucose^LN|||||||||||||||||||||||F',
  'OBX|1|NM|GLU^Glucose^LN||95|mg/dL|70-110|N|||F',
].join('\r');

test('translates a basic ORU^R01 to the canonical payload', () => {
  const { payload, issues } = hl7ToCanonical(ORU_231);
  assert.deepEqual(issues, []);
  assert.deepEqual(payload, {
    patient: { id: 'PID-1001', name: 'Adeyemi, Tunde', dateOfBirth: '19850312', gender: 'M' },
    order: { id: 'ACC-88', tests: [{ code: 'GLU', name: 'Glucose' }] },
    results: [
      {
        testCode: 'GLU',
        testName: 'Glucose',
        value: '95',
        unit: 'mg/dL',
        referenceRange: '70-110',
        flag: 'N',
        status: 'F',
        measuredAt: undefined,
      },
    ],
  });
});

test('falls back to the placer order number when no filler is present', () => {
  const raw = ORU_231.replace('OBR|1|ORD-77|ACC-88|', 'OBR|1|ORD-77||');
  const { payload, issues } = hl7ToCanonical(raw);
  assert.deepEqual(issues, []);
  assert.equal(payload!.order.id, 'ORD-77');
});

test('maps analyzer test codes to canonical codes like the ASTM pipeline', () => {
  const { payload, issues } = hl7ToCanonical(ORU_231, { mappings: { GLU: 'GLUCOSE', CREA: 'CREATININE' } });
  assert.deepEqual(issues, []);
  assert.equal(payload!.results[0]!.testCode, 'GLUCOSE');
  assert.equal(payload!.results[0]!.originalTestCode, 'GLU');
  // Order request tests are not result codes — left unmapped (parity with ASTM).
  assert.equal(payload!.order.tests[0]!.code, 'GLU');
});

test('keeps composite OBX-5 values whole and unescapes text', () => {
  const raw = [
    'MSH|^~\\&|SEND|FAC|RECV|FAC2|20260904120000||ORU^R01|C2|P|2.5.1',
    'PID|1||PID-2001^^^HOSP^MR||Okafor^Chioma||19921107|F',
    'OBR|1||ACC-9|CHEM^Panel',
    'OBX|1|SN|CA^Calcium||1.2^2^3|mmol/L||N|||F',
    'OBX|2|TX|NOTE^Comment||see\\F\\report\\S\\file||||F',
  ].join('\r');
  const { payload, issues } = hl7ToCanonical(raw);
  assert.deepEqual(issues, []);
  assert.equal(payload!.results[0]!.value, '1.2^2^3'); // composite kept whole
  assert.equal(payload!.results[1]!.value, 'see|report^file'); // unescaped
  assert.equal(payload!.results[1]!.testCode, 'NOTE');
});

test('defaults OBX-11 status to F and reads flag + measured-at when present', () => {
  // OBX fields built positionally (OBX-1..14) so offsets cannot drift.
  const obx = ['1', 'NM', 'GLU^Glucose', '', '88', 'mg/dL', '70-110', 'H', '', '', 'F', '', '', '20260904120500'].join('|');
  const raw = [
    'MSH|^~\\&|SEND|FAC|RECV|FAC2|20260904120000||ORU^R01|C3|P|2.5.1',
    'PID|1||P-3^^^HOSP^MR||Bello^Musa||19750505|M',
    'OBR|1||O-3|GLU^Glucose',
    `OBX|${obx}`,
  ].join('\r');
  const { payload, issues } = hl7ToCanonical(raw);
  assert.deepEqual(issues, []);
  assert.equal(payload!.results[0]!.flag, 'H');
  assert.equal(payload!.results[0]!.status, 'F');
  // TS is dictionary-normalized (drops seconds — documented substrate quirk).
  assert.equal(payload!.results[0]!.measuredAt, '202609041205');

  // No OBX-11 → default status F.
  const shortObx = ['1', 'NM', 'GLU^Glucose', '', '88', 'mg/dL', '70-110', 'N'].join('|');
  const raw2 = raw.replace(`OBX|${obx}`, `OBX|${shortObx}`);
  assert.equal(hl7ToCanonical(raw2).payload!.results[0]!.status, 'F');
});

test('accepts a pre-parsed hl7v2 message or our platform message', () => {
  const fromLib = hl7ToCanonical(HL7Message.parse(ORU_231));
  const fromPlatform = hl7ToCanonical(parseMessage(ORU_231));
  assert.deepEqual(fromLib, fromPlatform);
  assert.equal(fromLib.payload!.patient.id, 'PID-1001');
});

test('rejects non-ORU triggers with a visible issue', () => {
  const adt = ORU_231.replace('ORU^R01', 'ADT^A01');
  const { payload, issues } = hl7ToCanonical(adt);
  assert.equal(payload, null);
  assert.match(issues[0]!, /unsupported message type ADT\^A01/);
});

test('flags missing identifiers and empty results like the ASTM pipeline', () => {
  const noOrder = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|M4|P|2.3.1',
    'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  ].join('\r');
  const r1 = hl7ToCanonical(noOrder);
  assert.equal(r1.payload, null);
  assert.ok(r1.issues.some((i) => i.includes('Missing order identifier')));
  assert.ok(r1.issues.some((i) => i.includes('No result records')));

  const noValue = noOrder + '\rOBR|1||O-1|GLU^Glucose\rOBX|1|NM|GLU^Glucose|||||||F';
  const r2 = hl7ToCanonical(noValue);
  assert.equal(r2.payload, null);
  assert.match(r2.issues.join('; '), /Result for "GLU" has no value/);
});

test('flags multi-order-group ORU messages instead of conflating them', () => {
  const multi = [
    'MSH|^~\\&|SEND|FAC|RECV|FAC2|20260904120000||ORU^R01|M5|P|2.5.1',
    'PID|1||P-5^^^HOSP^MR||Doe^Jane||19800101|F',
    'OBR|1||ACC-1|GLU^Glucose',
    'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
    'OBR|2||ACC-2|CREA^Creatinine',
    'OBX|2|NM|CREA^Creatinine||1.1|mg/dL|0.6-1.3|N|||F',
  ].join('\r');
  const { payload, issues } = hl7ToCanonical(multi);
  assert.equal(payload, null);
  assert.match(issues.join('; '), /2 distinct order groups/);
});

// ---------------------------------------------------------------------------
// B4 — vendor segment-level layout overrides (a profile's `hl7` config).
// Each variant reads the SAME wire that the generic translator would
// mis-parse, and must canonicalize correctly once the layout is applied.
// ---------------------------------------------------------------------------

test('B4: a patient-name override reads PID-6 when the vendor does not use PID-5', () => {
  // Name lives at PID-6; PID-5 is empty. The generic translator would see no
  // name — the profile pins `patient.name` to field 6.
  const wire = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|V1|P|2.5.1',
    'PID|1||PID-1001^^^FAC1^PI|||Adeyemi^Tunde|19850312|M',
    'OBR|1|ORD-77|ACC-88|GLU^Glucose',
    'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
  ].join('\r');

  const generic = hl7ToCanonical(wire);
  assert.equal(generic.payload!.patient.name, undefined);

  const { payload, issues } = hl7ToCanonical(wire, { layout: { patient: { name: { field: 6 } } } });
  assert.deepEqual(issues, []);
  assert.equal(payload!.patient.name, 'Adeyemi, Tunde');
});

test('B4: a code-component override reads the identifier at OBX-3^2 (name first vendors)', () => {
  // This vendor emits the CE as `name^code` — the generic translator would
  // take `Glucose` as the code. The profile pins testCode to component 2 and
  // testName to component 1.
  const wire = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|V2|P|2.5.1',
    'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
    'OBR|1|ORD-77|ACC-88|GLU^Glucose',
    'OBX|1|NM|Glucose^GLU||95|mg/dL|70-110|N|||F',
  ].join('\r');

  const generic = hl7ToCanonical(wire);
  assert.equal(generic.payload!.results[0]!.testCode, 'Glucose'); // wrong under generic

  const { payload, issues } = hl7ToCanonical(wire, {
    layout: { result: { testCode: { field: 3, component: 2 }, testName: { field: 3, component: 1 } } },
  });
  assert.deepEqual(issues, []);
  assert.equal(payload!.results[0]!.testCode, 'GLU');
  assert.equal(payload!.results[0]!.testName, 'Glucose');
});

test('B4: an ORC-anchored layout resolves the order from ORC and tests from OBR', () => {
  const wire = [
    'MSH|^~\\&|SEND|FAC|RECV|FAC2|20260904120000||ORU^R01|V3|P|2.5.1',
    'PID|1||P-3^^^HOSP^MR||Bello^Musa||19750505|M',
    'ORC|RE|PL-9|ACC-ORC-9|GLU^Glucose',
    'OBR|1|PL-9|ACC-OBR-9|GLU^Glucose',
    'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
  ].join('\r');

  const generic = hl7ToCanonical(wire);
  assert.equal(generic.payload!.order.id, 'ACC-OBR-9'); // OBR anchored by default

  const { payload, issues } = hl7ToCanonical(wire, { layout: { order: { segment: 'ORC' } } });
  assert.deepEqual(issues, []);
  assert.equal(payload!.order.id, 'ACC-ORC-9');
  assert.deepEqual(payload!.order.tests, [{ code: 'GLU', name: 'Glucose' }]); // tests still from OBR
});

test('B4: a delimiters override repairs a sender whose MSH-2 declares the wrong separators', () => {
  // The wire really separates components with `*` (repetition `%`, escape `@`,
  // subcomponent `#`), but MSH-2 still declares the standard `^~\&` — parsing
  // it as-is would garble every composite. The profile knows the sender and
  // stamps the real delimiters on MSH-2 before parsing.
  // Fields stay `|`-separated; the deviation is at the COMPONENT level
  // (`*` for components, `%` repetitions, `@` escape, `#` subcomponents).
  const wire = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU*R01|V4|P|2.5.1',
    'PID|1||PID-1001***FAC1*PI||Adeyemi*Tunde||19850312|M',
    'OBR|1|ORD-77|ACC-88|GLU*Glucose',
    'OBX|1|NM|GLU*Glucose||95|mg/dL|70-110|N|||F',
  ].join('\r');

  const layout = { delimiters: { component: '*', repetition: '%', escape: '@', subcomponent: '#' } };
  const { payload, issues } = hl7ToCanonical(wire, { layout });
  assert.deepEqual(issues, []);
  assert.equal(payload!.patient.id, 'PID-1001');
  assert.equal(payload!.patient.name, 'Adeyemi, Tunde');
  assert.equal(payload!.order.id, 'ACC-88');
  assert.equal(payload!.results[0]!.value, '95');
  assert.equal(payload!.results[0]!.unit, 'mg/dL');
});
