/**
 * ADT^A01 patient-admission translator tests (workstream B2c extension — the
 * patient-side LIS seam). Covers trigger → status mapping (A01/A04/A08
 * admitted, A03 discharged), demographics extraction (PID-5 name, PID-7 DOB,
 * PID-8 gender, PV1-19 visit), loud rejection of non-ADT/unsupported
 * triggers, and B4 layout overrides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hl7ToAdmission } from './admission.js';

const MSH = 'MSH|^~\\&|ACME_HIS|FAC1|HUB|FAC2|20260904120000||ADT^A01|ADT-1|P|2.3.1';
const PID = 'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M';
const PV1 = 'PV1|1|I|WARD-A^BED-3||||||||||||||||VIS-77'; // VIS-77 at PV1-19

test('ADT^A01 translates to an admitted admission (demographics + PV1-19 visit)', () => {
  const wire = [MSH, PID, PV1].join('\r');
  const { admission, issues } = hl7ToAdmission(wire);
  assert.ok(admission, issues.join('; '));
  assert.equal(admission.patientId, 'PID-1001');
  assert.equal(admission.name, 'Adeyemi, Tunde');
  assert.equal(admission.dateOfBirth, '19850312');
  assert.equal(admission.gender, 'M');
  assert.equal(admission.visitId, 'VIS-77');
  assert.equal(admission.status, 'admitted');
});

test('A04 register and A08 update stay admitted; A03 discharge flips the status', () => {
  const a04 = hl7ToAdmission([MSH.replace('ADT^A01', 'ADT^A04'), PID].join('\r'));
  assert.equal(a04.admission?.status, 'admitted');
  const a08 = hl7ToAdmission([MSH.replace('ADT^A01', 'ADT^A08'), PID].join('\r'));
  assert.equal(a08.admission?.status, 'admitted');
  const a03 = hl7ToAdmission([MSH.replace('ADT^A01', 'ADT^A03'), PID].join('\r'));
  assert.equal(a03.admission?.status, 'discharged');
});

test('an admission without PV1 still registers (visit is best-effort)', () => {
  const { admission, issues } = hl7ToAdmission([MSH, PID].join('\r'));
  assert.ok(admission, issues.join('; '));
  assert.equal(admission.visitId, undefined);
  assert.equal(admission.status, 'admitted');
});

test('non-ADT messages and unsupported triggers are rejected loudly', () => {
  const oru = hl7ToAdmission([MSH.replace('ADT^A01', 'ORU^R01'), PID].join('\r'));
  assert.equal(oru.admission, null);
  assert.ok(oru.issues.some((i) => i.includes('unsupported message type ORU^R01')));

  const a02 = hl7ToAdmission([MSH.replace('ADT^A01', 'ADT^A02'), PID].join('\r'));
  assert.equal(a02.admission, null);
  assert.ok(a02.issues.some((i) => i.includes('unsupported ADT trigger A02')));
});

test('missing patient identifier is flagged (never a silent admission)', () => {
  const wire = [MSH, 'PID|1||', PV1].join('\r');
  const { admission, issues } = hl7ToAdmission(wire);
  assert.equal(admission, null);
  assert.ok(issues.includes('Missing patient identifier'));
});

test('B4: a name override reads PID-6 when the vendor carries it there', () => {
  // PID-5 empty; the vendor puts the name in PID-6 (mother's-maiden slot).
  const wire = [MSH, 'PID|1||PID-1001^^^FAC1^PI|||Adeyemi^Tunde|19850312|M', PV1].join('\r');

  const generic = hl7ToAdmission(wire);
  assert.equal(generic.admission?.name, undefined); // generic reads PID-5: empty

  const { admission, issues } = hl7ToAdmission(wire, { layout: { patient: { name: { field: 6 } } } });
  assert.ok(admission, issues.join('; '));
  assert.equal(admission.name, 'Adeyemi, Tunde');
  assert.equal(admission.dateOfBirth, '19850312');
});

test('B4: a patient-id override reads PID-4 when the vendor omits PID-3', () => {
  const wire = [MSH, 'PID|1|||ALT-55^^^FAC1^PI||Adeyemi^Tunde||19850312|M', PV1].join('\r');

  const generic = hl7ToAdmission(wire);
  assert.equal(generic.admission, null);
  assert.ok(generic.issues.includes('Missing patient identifier'));

  const { admission, issues } = hl7ToAdmission(wire, { layout: { patient: { id: { field: 4, component: 1 } } } });
  assert.ok(admission, issues.join('; '));
  assert.equal(admission.patientId, 'ALT-55');
});