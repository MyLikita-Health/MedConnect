/**
 * ORM^O01 → OrderRegistry translator tests (workstream B2c — the LIS seam).
 * Covers order id resolution (ORC-3 filler / ORC-2 placer / OBR fallback),
 * ORC-1 action → status mapping, multi-test OBR rows, test-code mapping,
 * and loud rejection of non-ORM messages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hl7ToOrder } from './order.js';

const MSH = 'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORM^O01|ORD-1|P|2.3.1';
const PID = 'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M';

test('ORM^O01 translates to an active expected order (ORC-3 filler id)', () => {
  const wire = [
    MSH,
    PID,
    'ORC|NW|PL-77|ACC-424242|GLU^Glucose',
    'OBR|1|PL-77|ACC-424242|GLU^Glucose|||||20260904120000',
  ].join('\r');
  const { order, issues } = hl7ToOrder(wire);
  assert.ok(order, issues.join('; '));
  assert.equal(order.id, 'ACC-424242');
  assert.equal(order.patientId, 'PID-1001');
  assert.deepEqual(order.tests, ['GLU']);
  assert.equal(order.status, 'active');
});

test('ORC-2 placer is the fallback order id when ORC-3 is empty', () => {
  const wire = [MSH, PID, 'ORC|NW|PL-77||GLU^Glucose', 'OBR|1|PL-77||GLU^Glucose'].join('\r');
  const { order } = hl7ToOrder(wire);
  assert.ok(order);
  assert.equal(order.id, 'PL-77');
});

test('OBR fields resolve the order id when there is no ORC', () => {
  const wire = [MSH, PID, 'OBR|1|PL-77|ACC-424242|GLU^Glucose'].join('\r');
  const { order } = hl7ToOrder(wire);
  assert.ok(order);
  assert.equal(order.id, 'ACC-424242');
});

test('ORC-1 action maps to registry statuses (CA cancelled, CM completed)', () => {
  const cancel = hl7ToOrder([MSH, PID, 'ORC|CA|PL-77|ACC-9|GLU', 'OBR|1|PL-77|ACC-9|GLU'].join('\r'));
  assert.equal(cancel.order?.status, 'cancelled');
  const complete = hl7ToOrder([MSH, PID, 'ORC|CM|PL-77|ACC-9|GLU', 'OBR|1|PL-77|ACC-9|GLU'].join('\r'));
  assert.equal(complete.order?.status, 'completed');
});

test('multi-test ORMs carry every OBR-4 test, deduped', () => {
  const wire = [
    MSH,
    PID,
    'ORC|NW|PL-77|ACC-9|GLU^Glucose',
    'OBR|1|PL-77|ACC-9|GLU^Glucose',
    'OBR|2|PL-77|ACC-9|CREA^Creatinine',
    'OBR|3|PL-77|ACC-9|GLU^Glucose',
  ].join('\r');
  const { order } = hl7ToOrder(wire);
  assert.ok(order);
  assert.deepEqual(order.tests, ['GLU', 'CREA']);
});

test('requested tests are mapped through the mapping table to canonical codes', () => {
  const wire = [MSH, PID, 'ORC|NW|PL-77|ACC-9|GLU', 'OBR|1|PL-77|ACC-9|GLU'].join('\r');
  const { order } = hl7ToOrder(wire, { mappings: { GLU: 'GLUCOSE' } });
  assert.ok(order);
  assert.deepEqual(order.tests, ['GLUCOSE']);
});

test('non-ORM messages are rejected loudly; missing ids/orders are flagged', () => {
  const oru = hl7ToOrder([MSH.replace('ORM^O01', 'ORU^R01'), PID, 'OBR|1||ACC|GLU', 'OBX|1|NM|GLU||95'].join('\r'));
  assert.equal(oru.order, null);
  assert.ok(oru.issues.some((i) => i.includes('unsupported message type ORU^R01')));

  const noName = hl7ToOrder([MSH, 'PID|1||', 'ORC|NW|PL|ACC|GLU', 'OBR|1|PL|ACC|GLU'].join('\r'));
  assert.equal(noName.order, null);
  assert.ok(noName.issues.includes('Missing patient identifier'));

  const noOrc = hl7ToOrder([MSH, PID, 'OBX|1|NM|GLU||95'].join('\r'));
  assert.equal(noOrc.order, null);
  assert.ok(noOrc.issues.some((i) => i.includes('Missing order segments')));
});

// ---------------------------------------------------------------------------
// B4 — vendor segment-level layout overrides also drive the ORM feed (the
// LIS seam shares the profile's `hl7` config with the results translator).
// ---------------------------------------------------------------------------

test('B4: a patient-id override reads PID-4 when the vendor omits PID-3', () => {
  // This vendor carries the patient id in PID-4 (alternate id position);
  // PID-3 is empty. The generic translator would flag a missing identifier.
  const wire = [MSH, 'PID|1|||ALT-55^^^FAC1^PI||Adeyemi^Tunde||19850312|M', 'ORC|NW|PL-77|ACC-9|GLU', 'OBR|1|PL-77|ACC-9|GLU'].join('\r');

  const generic = hl7ToOrder(wire);
  assert.equal(generic.order, null);
  assert.ok(generic.issues.includes('Missing patient identifier'));

  const { order, issues } = hl7ToOrder(wire, { layout: { patient: { id: { field: 4, component: 1 } } } });
  assert.ok(order, issues.join('; '));
  assert.equal(order.patientId, 'ALT-55');
});

test('B4: an order-id override reads ORC-4 when that is where the vendor carries it', () => {
  const wire = [MSH, PID, 'ORC|NW|PL-77|ACC-424242|LIS-ORD-9|GLU', 'OBR|1|PL-77|ACC-424242|GLU'].join('\r');

  const generic = hl7ToOrder(wire);
  assert.equal(generic.order!.id, 'ACC-424242');

  const { order, issues } = hl7ToOrder(wire, { layout: { order: { fillerId: { field: 4, component: 1 } } } });
  assert.ok(order, issues.join('; '));
  assert.equal(order.id, 'LIS-ORD-9');
});