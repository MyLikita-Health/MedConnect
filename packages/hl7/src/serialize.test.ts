/**
 * Canonical → HL7 serializer tests (workstream B3.1).
 *
 * The headline oracle: a real ORU^R01 is translated in (B2a), re-serialized
 * out, and translated again — the second canonical payload must match the
 * first, proving the outbound writer and the inbound reader agree on the
 * contract (the inbound translator doubles as the outbound conformance
 * oracle). Plus structural tests for ORM^O01 and the MSH options surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LabPayload } from '@integration-hub/shared';
import { hl7ToCanonical } from './translate.js';
import { canonicalToOru, canonicalToOrm } from './serialize.js';
import { parseMessage, segmentField } from './message.js';

const ORU = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG0001|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'OBR|1|ORD-77|ACC-88|GLU^Glucose',
  'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
].join('\r');

test('round-trip oracle: ORU in → serialize out → translate again matches', () => {
  const once = hl7ToCanonical(ORU);
  assert.ok(once.payload);

  const wire = canonicalToOru(once.payload, { controlId: 'RT-1', dateTime: '20260904120000' });
  const twice = hl7ToCanonical(wire);
  assert.ok(twice.payload, `re-serialized message failed to translate: ${twice.issues.join('; ')}`);

  const a = once.payload;
  const b = twice.payload;
  // Patient contract (atomic + derived display convention).
  assert.equal(b.patient.id, a.patient.id);
  assert.equal(b.patient.name, a.patient.name);
  assert.equal(b.patient.dateOfBirth, a.patient.dateOfBirth);
  assert.equal(b.patient.gender, a.patient.gender);
  // Order contract.
  assert.equal(b.order.id, a.order.id);
  assert.deepEqual(b.order.tests, a.order.tests);
  // Result contract — every OBX field the translator reads.
  assert.equal(b.results.length, a.results.length);
  for (let i = 0; i < a.results.length; i++) {
    assert.equal(b.results[i]!.testCode, a.results[i]!.testCode);
    assert.equal(b.results[i]!.testName, a.results[i]!.testName);
    assert.equal(b.results[i]!.value, a.results[i]!.value);
    assert.equal(b.results[i]!.unit, a.results[i]!.unit);
    assert.equal(b.results[i]!.referenceRange, a.results[i]!.referenceRange);
    assert.equal(b.results[i]!.flag, a.results[i]!.flag);
    assert.equal(b.results[i]!.status, a.results[i]!.status);
    assert.equal(b.results[i]!.measuredAt, a.results[i]!.measuredAt);
  }
});

test('multi-result ORU round-trips with order + escaping intact', () => {
  const payload: LabPayload = {
    patient: { id: 'PID-77', name: 'Bello, Ngozi', dateOfBirth: '19900202', gender: 'F' },
    order: { id: 'ACC-555', tests: [{ code: 'GLUCOSE', name: 'Glucose' }] },
    results: [
      { testCode: 'GLUCOSE', testName: 'Glucose', value: '95', unit: 'mg/dL', referenceRange: '70-110', flag: 'N', status: 'F' },
      // Free text with every delimiter — must survive the wire escaped.
      { testCode: 'NOTE', testName: 'Comment', value: 'A|B^C~D&E\\F', unit: '', flag: 'A', status: 'F' },
      { testCode: 'SODIUM', testName: 'Sodium', value: '140.5', unit: 'mmol/L', referenceRange: '135-145', flag: 'H', status: 'F', measuredAt: '202609041205' },
    ],
  };

  const wire = canonicalToOru(payload, { controlId: 'RT-2' });
  const out = hl7ToCanonical(wire);
  assert.ok(out.payload, out.issues.join('; '));
  // OBX-2 inferred: numeric → NM, text → ST.
  const raw = parseMessage(wire);
  const obx = raw.segments.filter((s) => s.id === 'OBX');
  assert.equal(segmentField(obx[0]!, 1), 'NM');
  assert.equal(segmentField(obx[1]!, 1), 'ST');

  assert.equal(out.payload.patient.id, 'PID-77');
  assert.equal(out.payload.patient.name, 'Bello, Ngozi');
  assert.equal(out.payload.order.id, 'ACC-555');
  assert.equal(out.payload.results[1]!.value, 'A|B^C~D&E\\F');
  assert.equal(out.payload.results[2]!.measuredAt, '202609041205');
  assert.deepEqual(out.payload.results.map((r) => r.testCode), ['GLUCOSE', 'NOTE', 'SODIUM']);
});

test('ORM^O01: order download structure + multi-test OBR rows', () => {
  const payload: LabPayload = {
    patient: { id: 'PID-1001', name: 'Adeyemi, Tunde' },
    order: {
      id: 'ACC-424242',
      tests: [
        { code: 'GLUCOSE', name: 'Glucose' },
        { code: 'CREATININE', name: 'Creatinine' },
      ],
    },
    results: [],
  };
  const wire = canonicalToOrm(payload, { controlId: 'ORM-1', sendingApp: 'HUB', sendingFacility: 'FAC1', version: '2.5.1' });

  const raw = parseMessage(wire);
  assert.equal(raw.segments[0]!.id, 'MSH');
  assert.equal(segmentField(raw.segments[0]!, 7), 'ORM^O01');
  assert.equal(segmentField(raw.segments[0]!, 8), 'ORM-1');
  assert.equal(segmentField(raw.segments[0]!, 10), '2.5.1');
  assert.equal(segmentField(raw.segments[0]!, 1), 'HUB');

  const orc = raw.segments.find((s) => s.id === 'ORC');
  assert.equal(segmentField(orc!, 0), 'NW');
  assert.equal(segmentField(orc!, 2), 'ACC-424242');

  const obrs = raw.segments.filter((s) => s.id === 'OBR');
  assert.equal(obrs.length, 2);
  assert.equal(segmentField(obrs[0]!, 2), 'ACC-424242');
  assert.equal(segmentField(obrs[0]!, 3), 'GLUCOSE^Glucose');
  assert.equal(segmentField(obrs[1]!, 3), 'CREATININE^Creatinine');

  // The ORM parses cleanly through the dictionary too (it is a real message).
  const parsed = hl7ToCanonical(wire);
  assert.ok(!parsed.payload); // ORM is not a results message — v1 translator rejects it loudly.
  assert.ok(parsed.issues.some((i) => i.includes('unsupported message type ORM')));
});

test('MSH options surface: version / control id / sending facility land in the right slots', () => {
  const payload: LabPayload = { patient: { id: 'P1' }, order: { id: 'O1', tests: [] }, results: [{ testCode: 'X', value: '1' }] };
  const wire = canonicalToOru(payload, {
    sendingApp: 'EDGE-HUB',
    sendingFacility: 'FAC-9',
    receivingApp: 'ACME_LIS',
    receivingFacility: 'LIS-DC',
    version: '2.3.1',
    controlId: 'CTL-42',
    dateTime: '20260904120000',
  });
  const raw = parseMessage(wire);
  const msh = raw.segments[0]!;
  assert.equal(segmentField(msh, 1), 'EDGE-HUB');
  assert.equal(segmentField(msh, 2), 'FAC-9');
  assert.equal(segmentField(msh, 3), 'ACME_LIS');
  assert.equal(segmentField(msh, 4), 'LIS-DC');
  assert.equal(segmentField(msh, 8), 'CTL-42');
  assert.equal(segmentField(msh, 10), '2.3.1');
  assert.equal(segmentField(msh, 5), '20260904120000');

  // Without overrides a control id is generated per message (never empty).
  const auto = parseMessage(canonicalToOru({ ...payload, results: [{ testCode: 'X', value: '1' }] }));
  assert.ok((segmentField(auto.segments[0]!, 8) ?? '').startsWith('HUB-'));
});