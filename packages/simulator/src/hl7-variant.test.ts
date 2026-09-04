/**
 * Vendor-variant transcripts + the layout-based conformance oracle (B4): each
 * deterministic deviant transcript must FAIL or misread under the generic
 * translator, and produce the exact canonical payload once the matching B4
 * `hl7` layout override is applied. This is the same oracle goldens-in-CI
 * will run against real vendor transcripts (plan §13.15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hl7ToCanonical, hl7ToOrder } from '@integration-hub/hl7';
import { VARIANT_DEFS, buildVariantMessage, type VariantName } from './hl7-variant.js';

const ORU_VARIANTS: VariantName[] = ['pid6-name', 'obx-swap', 'delimiters', 'pid4-id'];

test('ORU variant transcripts: generic parse deviates; the B4 layout yields the exact payload', () => {
  for (const variant of ORU_VARIANTS) {
    const wire = buildVariantMessage('oru', variant);

    // Conformance gate 1 — the generic translator cannot read the deviation:
    // it must fail loudly or produce a wrong payload (never a silent misread
    // that looks right).
    const generic = hl7ToCanonical(wire);
    assert.ok(
      generic.payload === null ||
        generic.payload.patient.id !== 'PID-1001' ||
        generic.payload.patient.name !== 'Adeyemi, Tunde' ||
        generic.payload.results[0]?.testCode !== 'GLU' ||
        generic.payload.order.id !== 'ACC-424242',
      `${variant}: generic parse unexpectedly matched the canonical payload`,
    );

    // Conformance gate 2 — the profile layout decodes it exactly.
    const { payload, issues } = hl7ToCanonical(wire, { layout: VARIANT_DEFS[variant]!.layout });
    assert.ok(payload, `${variant} layout parse failed: ${issues.join('; ')}`);
    assert.equal(payload.patient.id, 'PID-1001', variant);
    assert.equal(payload.patient.name, 'Adeyemi, Tunde', variant);
    assert.equal(payload.patient.dateOfBirth, '19850312', variant);
    assert.equal(payload.order.id, 'ACC-424242', variant);
    assert.deepEqual(payload.results.map((r) => r.testCode), ['GLU', 'CREA'], variant);
    assert.equal(payload.results[0]!.value, '95', variant);
    assert.equal(payload.results[0]!.testName, 'Glucose', variant);
  }
});

test('ORM variant transcripts: generic parse deviates; the B4 layout yields the exact order', () => {
  const pid4 = buildVariantMessage('orm', 'pid4-id');
  assert.equal(hl7ToOrder(pid4).order, null); // PID-3 empty → cannot register
  const pid4Ok = hl7ToOrder(pid4, { layout: VARIANT_DEFS['pid4-id']!.layout });
  assert.ok(pid4Ok.order);
  assert.equal(pid4Ok.order.patientId, 'PID-1001');
  assert.deepEqual(pid4Ok.order.tests, ['GLU', 'CREA']);

  const orc4 = buildVariantMessage('orm', 'orc4-id');
  // Generic falls back to the ORC-2 placer; the layout reads ORC-4.
  assert.equal(hl7ToOrder(orc4).order?.id, 'PL-77');
  const orc4Ok = hl7ToOrder(orc4, { layout: VARIANT_DEFS['orc4-id']!.layout });
  assert.ok(orc4Ok.order);
  assert.equal(orc4Ok.order.id, 'LIS-ORD-9');
  assert.equal(orc4Ok.order.patientId, 'PID-1001');
  assert.deepEqual(orc4Ok.order.tests, ['GLU', 'CREA']);
});

test('every variant ships the layout override that decodes it (VARIANT_DEFS is complete)', () => {
  const names = Object.keys(VARIANT_DEFS) as VariantName[];
  assert.deepEqual([...names].sort(), ['delimiters', 'obx-swap', 'orc4-id', 'pid4-id', 'pid6-name'].sort());
  for (const name of names) {
    assert.ok(VARIANT_DEFS[name]!.description.length > 0, name);
    assert.ok(VARIANT_DEFS[name]!.layout, name);
  }
});