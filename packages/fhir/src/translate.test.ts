/**
 * FHIR R4 translator round-trip oracle tests (workstream D2, plan §7.D):
 * canonical → FHIR → canonical must reproduce the input for the mapped
 * fields, plus explicit assertions on the FHIR side of the mapping (the
 * outward contract) and the documented v1 collapses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ImagingPayload, LabPayload } from '@integration-hub/shared';
import {
  canonicalToFhir,
  fhirBundle,
  fhirImagingToCanonical,
  fhirToCanonical,
  fhirToDevice,
  deviceToFhir,
  imagingToFhir,
  type FhirImagingStudy,
  type FhirObservation,
} from './translate.js';

const LAB: LabPayload = {
  patient: { id: 'PID-1001', name: 'Adeyemi, Tunde', dateOfBirth: '19850312', gender: 'M' },
  order: { id: 'ACC-88', sampleId: 'S-4242', tests: [{ code: 'GLU', name: 'Glucose' }] },
  results: [
    {
      testCode: 'GLU',
      testName: 'Glucose',
      value: '95',
      unit: 'mg/dL',
      referenceRange: '70-110',
      flag: 'N',
      status: 'F',
      measuredAt: '2026-09-04T12:00:00Z',
    },
  ],
};

test('canonical → FHIR maps the outward contract correctly', () => {
  const resources = canonicalToFhir(LAB);
  const [patient, serviceRequest, report, observation] = resources as [
    (typeof resources)[number],
    (typeof resources)[number],
    (typeof resources)[number],
    FhirObservation,
  ];

  assert.equal(patient.resourceType, 'Patient');
  assert.deepEqual(patient.name, [{ family: 'Adeyemi', given: ['Tunde'], text: 'Adeyemi, Tunde' }]);
  assert.equal(patient.birthDate, '19850312');
  assert.equal(patient.gender, 'male');

  assert.equal(serviceRequest.resourceType, 'ServiceRequest');
  assert.equal(serviceRequest.status, 'active');
  assert.equal(serviceRequest.intent, 'order');
  assert.equal(serviceRequest.id, 'ACC-88');
  assert.deepEqual(serviceRequest.identifier, [
    { type: { coding: [{ code: 'accession' }] }, value: 'ACC-88' },
    { type: { coding: [{ code: 'sample' }] }, value: 'S-4242' },
  ]);
  assert.deepEqual(serviceRequest.code, { coding: [{ code: 'GLU' }], text: 'Glucose' });
  assert.deepEqual(serviceRequest.subject, { reference: 'Patient/PID-1001' });

  assert.equal(report.resourceType, 'DiagnosticReport');
  assert.equal(report.status, 'final');
  assert.deepEqual(report.subject, { reference: 'Patient/PID-1001' });
  assert.deepEqual(report.basedOn, [{ reference: 'ServiceRequest/ACC-88' }]);
  assert.deepEqual(report.result, [{ reference: 'Observation/ACC-88-obs-1' }]);

  assert.equal(observation.resourceType, 'Observation');
  assert.equal(observation.status, 'final');
  assert.deepEqual(observation.code, { coding: [{ code: 'GLU' }], text: 'Glucose' });
  assert.deepEqual(observation.valueQuantity, { value: 95, unit: 'mg/dL' });
  assert.deepEqual(observation.referenceRange, [
    { low: { value: 70, unit: 'mg/dL' }, high: { value: 110, unit: 'mg/dL' } },
  ]);
  assert.deepEqual(observation.interpretation, [
    { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0078', code: 'N' }] },
  ]);
  assert.equal(observation.effectiveDateTime, '2026-09-04T12:00:00Z');
  assert.deepEqual(observation.subject, { reference: 'Patient/PID-1001' });
  assert.deepEqual(observation.basedOn, [{ reference: 'ServiceRequest/ACC-88' }]);
});

test('round-trip oracle: canonical → FHIR → canonical reproduces the lab payload', () => {
  const back = fhirToCanonical(canonicalToFhir(LAB));
  assert.deepEqual(back, LAB);
});

test('bundle wraps the resources with the collection shape', () => {
  const bundle = fhirBundle(canonicalToFhir(LAB));
  assert.equal(bundle.resourceType, 'Bundle');
  assert.equal(bundle.type, 'collection');
  assert.equal(bundle.entry.length, 4);
  assert.deepEqual(bundle.entry.map((e) => e.resource.resourceType), [
    'Patient',
    'ServiceRequest',
    'DiagnosticReport',
    'Observation',
  ]);
});

test('non-numeric values ride valueString; comparator + decimal values become quantities', () => {
  const payload: LabPayload = {
    patient: { id: 'P1' },
    order: { id: 'O1', tests: [] },
    results: [
      { testCode: 'HGB', value: 'Negative', status: 'F' },
      { testCode: 'GLU', value: '>200', unit: 'mg/dL', status: 'F' },
      { testCode: 'CREA', value: '95.0', unit: 'mg/dL', status: 'F' },
    ],
  };
  const resources = canonicalToFhir(payload);
  const observations = resources.filter((r): r is FhirObservation => r.resourceType === 'Observation');
  // 'Negative' has no quantity — valueString (no unit slot, v1).
  assert.equal(observations[0]?.valueString, 'Negative');
  assert.equal(observations[0]?.valueQuantity, undefined);
  // Comparator ranges keep comparator + unit in the quantity (textbook FHIR).
  assert.deepEqual(observations[1]?.valueQuantity, { value: 200, comparator: '>', unit: 'mg/dL' });
  // Purely numeric values are quantities; formatting normalizes (95.0 → 95) but the unit survives.
  assert.deepEqual(observations[2]?.valueQuantity, { value: 95, unit: 'mg/dL' });
  assert.deepEqual(observations[2]?.valueString, undefined);

  const back = fhirToCanonical(resources);
  assert.deepEqual(back.results, [
    { testCode: 'HGB', value: 'Negative', status: 'F' },
    { testCode: 'GLU', value: '>200', unit: 'mg/dL', status: 'F' },
    { testCode: 'CREA', value: '95', unit: 'mg/dL', status: 'F' },
  ]);
});

test('v2-0078 status subset round-trips; S/A collapse to preliminary (documented)', () => {
  const bijective = ['F', 'P', 'C', 'X', 'I', 'D'];
  for (const status of bijective) {
    const payload: LabPayload = {
      patient: { id: 'P1' },
      order: { id: 'O1', tests: [] },
      results: [{ testCode: 'GLU', value: '1', status }],
    };
    const back = fhirToCanonical(canonicalToFhir(payload));
    assert.equal(back.results[0]?.status, status, `status ${status} round-trips`);
  }
  for (const collapsed of ['S', 'A']) {
    const payload: LabPayload = {
      patient: { id: 'P1' },
      order: { id: 'O1', tests: [] },
      results: [{ testCode: 'GLU', value: '1', status: collapsed }],
    };
    const fhir = canonicalToFhir(payload);
    const observation = fhir.find((r): r is FhirObservation => r.resourceType === 'Observation')!;
    assert.equal(observation.status, 'preliminary');
    const back = fhirToCanonical(fhir);
    assert.equal(back.results[0]?.status, 'P');
  }
});

test('multi-test orders: every result round-trips as an Observation; ServiceRequest carries the primary test (v1)', () => {
  const payload: LabPayload = {
    patient: { id: 'P1', name: 'Doe, Jane', gender: 'F' },
    order: { id: 'ACC-9', tests: [{ code: 'GLU' }, { code: 'CREA' }] },
    results: [
      { testCode: 'GLUCOSE', originalTestCode: 'GLU', value: '95', unit: 'mg/dL', flag: 'H', status: 'F' },
      { testCode: 'CREATININE', originalTestCode: 'CREA', value: '1.2', unit: 'mg/dL', flag: 'L', status: 'F' },
    ],
  };
  const resources = canonicalToFhir(payload);
  const serviceRequest = resources.find((r) => r.resourceType === 'ServiceRequest')!;
  assert.deepEqual(serviceRequest.code, { coding: [{ code: 'GLU' }] });
  assert.equal(resources.filter((r) => r.resourceType === 'Observation').length, 2);

  const back = fhirToCanonical(resources);
  assert.equal(back.patient.name, 'Doe, Jane');
  assert.equal(back.patient.gender, 'F');
  assert.deepEqual(back.order.tests, [{ code: 'GLU' }]); // primary test only (documented v1)
  assert.deepEqual(back.results, payload.results); // results keep full fidelity
});

test('imaging event → FHIR ImagingStudy → canonical (oracle on the routed metadata)', () => {
  const imaging: ImagingPayload = {
    kind: 'imaging',
    accession: 'ACC-IM-1',
    performedAt: '2026-09-04T13:00:00Z',
    study: {
      orthancId: 'study-123',
      patientOrthancId: 'patient-9',
      accessionNumber: 'ACC-IM-1',
      studyInstanceUid: '1.2.840.113619.2.55.3.1.1.123',
      studyDate: '20260904',
      studyDescription: 'CT CHEST',
      studyId: 'ST-7',
      series: ['series-1'], // canonical: Orthanc series ids
      storageUrl: 'http://orthanc:8042/studies/study-123',
    },
  };
  const seriesDetails = [
    {
      orthancId: 'series-1',
      studyOrthancId: 'study-123',
      modality: 'CT',
      seriesInstanceUid: '1.2.840.113619.2.55.3.1.2.1',
      description: 'CHEST AXIAL',
      instances: ['inst-1', 'inst-2'],
      storageUrl: 'http://orthanc:8042/series/series-1',
    },
  ];

  const fhir = imagingToFhir(imaging, seriesDetails) as FhirImagingStudy;
  assert.equal(fhir.resourceType, 'ImagingStudy');
  assert.equal(fhir.status, 'available');
  assert.equal(fhir.id, 'study-123');
  assert.deepEqual(fhir.subject, { reference: 'Patient/patient-9' });
  assert.deepEqual(fhir.identifier, [
    { type: { coding: [{ code: 'accession' }] }, value: 'ACC-IM-1' },
    { type: { coding: [{ code: 'study-uid' }] }, value: '1.2.840.113619.2.55.3.1.1.123' },
    { type: { coding: [{ code: 'study-id' }] }, value: 'ST-7' },
  ]);
  assert.equal(fhir.started, '20260904');
  assert.deepEqual(fhir.modality, [{ coding: [{ code: 'CT' }] }]);
  assert.equal(fhir.numberOfSeries, 1);
  assert.equal(fhir.series?.[0]?.uid, '1.2.840.113619.2.55.3.1.2.1');
  assert.equal(fhir.series?.[0]?.description, 'CHEST AXIAL');
  assert.equal(fhir.series?.[0]?.numberOfInstances, 2);
  assert.ok(fhir.extension?.some((e) => e.url === 'urn:integration-hub:storageUrl' && e.valueUrl === 'http://orthanc:8042/studies/study-123'));

  const back = fhirImagingToCanonical(fhir);
  assert.equal(back.orthancId, 'study-123');
  assert.equal(back.patientOrthancId, 'patient-9');
  assert.equal(back.accessionNumber, 'ACC-IM-1');
  assert.equal(back.studyInstanceUid, '1.2.840.113619.2.55.3.1.1.123');
  assert.equal(back.studyDate, '20260904');
  assert.equal(back.studyDescription, 'CT CHEST');
  assert.equal(back.studyId, 'ST-7');
  assert.equal(back.storageUrl, 'http://orthanc:8042/studies/study-123');
  // series ids are Orthanc-internal pointers with no FHIR representation (v1)
  assert.deepEqual(back.series, []);

  // without seriesDetails the resource still carries study-level data
  const bare = imagingToFhir({ ...imaging, study: { ...imaging.study, series: ['series-1'] } });
  assert.equal(bare.numberOfSeries, 1);
  assert.equal(bare.series, undefined);
  assert.equal(bare.modality, undefined);
});

test('device row → FHIR Device → canonical device source (transport not round-tripped, v1)', () => {
  const device = {
    id: 'CT-1',
    name: 'CT Scanner A',
    manufacturer: 'ImagingCo',
    model: 'CT-X9',
    protocol: 'DICOM',
    transport: 'tcp',
    state: 'connected' as const,
  };
  const fhir = deviceToFhir(device);
  assert.equal(fhir.resourceType, 'Device');
  assert.equal(fhir.status, 'active');
  assert.deepEqual(fhir.deviceName, [{ name: 'CT Scanner A', type: 'user-friendly-name' }]);
  assert.equal(fhir.manufacturer, 'ImagingCo');
  assert.equal(fhir.modelNumber, 'CT-X9');
  assert.deepEqual(fhir.type, { text: 'DICOM' });

  const back = fhirToDevice(fhir);
  assert.deepEqual(back, {
    id: 'CT-1',
    name: 'CT Scanner A',
    manufacturer: 'ImagingCo',
    model: 'CT-X9',
    protocol: 'DICOM',
    state: 'connected',
  });

  // disconnected → off → disconnected
  const off = fhirToDevice(deviceToFhir({ ...device, state: 'disconnected' }));
  assert.equal(off.state, 'disconnected');
});