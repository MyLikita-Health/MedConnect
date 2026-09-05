/**
 * FHIR R4 REST surface tests (M4/D1, plan §7.D): the /api/v1/fhir routes
 * project stored lab messages → Patient/ServiceRequest/DiagnosticReport/
 * Observation, imaging messages → ImagingStudy, and the device registry →
 * Device. Functional tests run with auth off; one auth-scoped test asserts
 * the routes sit behind api:read like every other read surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from './server.js';
import { DeviceRegistry } from './devices.js';
import { MessageStore } from './store.js';
import { InMemoryAuditStore, InMemoryKeyStore, type ApiKeyRole, type KeyStore } from './security.js';
import type { CanonicalMessage, ImagingPayload, LabPayload } from '@integration-hub/shared';

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

const IMAGING: ImagingPayload = {
  kind: 'imaging',
  accession: 'ACC-IM-1',
  performedAt: '2026-09-04T13:00:00Z',
  study: {
    orthancId: 'study-123',
    patientOrthancId: 'patient-9',
    accessionNumber: 'ACC-IM-1',
    studyDate: '20260904',
    studyDescription: 'CT CHEST',
    series: ['series-1'],
    storageUrl: 'http://orthanc:8042/studies/study-123',
  },
};

function message(id: string, overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    id,
    protocol: 'ASTM',
    direction: 'device-to-host',
    deviceId: 'SIM-1',
    receivedAt: new Date().toISOString(),
    raw: 'H|\\^&||||SIM^1|||||||P|1|20260903143000',
    status: 'ROUTED',
    errors: [],
    timeline: [{ stage: 'RECEIVED', at: new Date().toISOString() }],
    ...overrides,
  };
}

async function startApi(t: any) {
  const store = new MessageStore();
  const devices = new DeviceRegistry();
  const api = new ApiServer({ port: 0, host: '127.0.0.1', store, devices });
  const { port } = await api.start();
  t.after(() => api.stop());
  return { base: `http://127.0.0.1:${port}`, store, devices };
}

async function startAuthApi(t: any) {
  const keys: KeyStore = new InMemoryKeyStore();
  await keys.create({ id: 'key-viewer', name: 'viewer', role: 'viewer' as ApiKeyRole, secret: 'ihk_fhir_viewer' });
  const store = new MessageStore();
  const devices = new DeviceRegistry();
  const api = new ApiServer({ port: 0, host: '127.0.0.1', store, devices, keys, audit: new InMemoryAuditStore() });
  const { port } = await api.start();
  t.after(() => api.stop());
  return { base: `http://127.0.0.1:${port}`, store };
}

test('fhir metadata advertises the served resource types', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/fhir/metadata`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/fhir\+json/);
  const cs = (await res.json()) as {
    resourceType: string;
    fhirVersion: string;
    rest: { resource: { type: string }[] }[];
  };
  assert.equal(cs.resourceType, 'CapabilityStatement');
  assert.equal(cs.fhirVersion, '4.0.1');
  const types = cs.rest[0]?.resource.map((r) => r.type);
  for (const type of ['Patient', 'ServiceRequest', 'DiagnosticReport', 'Observation', 'ImagingStudy', 'Device']) {
    assert.ok(types?.includes(type), `metadata lists ${type}`);
  }
});

test('lab messages project to Patient/ServiceRequest/DiagnosticReport/Observation', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message('m1', { payload: LAB }));

  const patientSearch = (await (await fetch(`${base}/api/v1/fhir/Patient`)).json()) as {
    resourceType: string;
    total: number;
    entry: { resource: { id: string; name: { family: string }[]; gender: string } }[];
  };
  assert.equal(patientSearch.resourceType, 'Bundle');
  assert.equal(patientSearch.total, 1);
  assert.equal(patientSearch.entry[0]?.resource.id, 'PID-1001');
  assert.equal(patientSearch.entry[0]?.resource.name[0]?.family, 'Adeyemi');
  assert.equal(patientSearch.entry[0]?.resource.gender, 'male');

  // Observation: the result as a quantity with the v2-0078 interpretation.
  const obs = (await (await fetch(`${base}/api/v1/fhir/Observation`)).json()) as {
    total: number;
    entry: { resource: { id: string; code: { coding: { code: string }[] }; valueQuantity: { value: number; unit: string }; interpretation: { coding: { code: string }[] }[] } }[];
  };
  assert.equal(obs.total, 1);
  assert.equal(obs.entry[0]?.resource.id, 'ACC-88-obs-1');
  assert.equal(obs.entry[0]?.resource.code.coding[0]?.code, 'GLU');
  assert.deepEqual(obs.entry[0]?.resource.valueQuantity, { value: 95, unit: 'mg/dL' });
  assert.equal(obs.entry[0]?.resource.interpretation[0]?.coding[0]?.code, 'N');

  // Read by id across the four types.
  const patient = (await (await fetch(`${base}/api/v1/fhir/Patient/PID-1001`)).json()) as { id: string };
  assert.equal(patient.id, 'PID-1001');

  const serviceRequest = (await (await fetch(`${base}/api/v1/fhir/ServiceRequest/ACC-88`)).json()) as {
    id: string;
    identifier: { type: { coding: { code: string }[] }; value: string }[];
  };
  assert.equal(serviceRequest.id, 'ACC-88');
  assert.deepEqual(serviceRequest.identifier.map((i) => [i.type.coding[0]?.code, i.value]), [
    ['accession', 'ACC-88'],
    ['sample', 'S-4242'],
  ]);

  const report = (await (await fetch(`${base}/api/v1/fhir/DiagnosticReport/report-ACC-88`)).json()) as {
    status: string;
    result: { reference: string }[];
  };
  assert.equal(report.status, 'final');
  assert.deepEqual(report.result, [{ reference: 'Observation/ACC-88-obs-1' }]);
});

test('imaging messages project to ImagingStudy and the device registry to Device', async (t) => {
  const { base, store, devices } = await startApi(t);
  store.record(message('m-img', { protocol: 'FHIR', imaging: IMAGING }));
  devices.register({
    id: 'CT-1',
    name: 'CT Scanner A',
    manufacturer: 'ImagingCo',
    model: 'CT-X9',
    protocol: 'DICOM',
    transport: 'tcp',
  });
  // Real devices reach the registry through the gateway with a live state.
  devices.upsertFromConnection({ id: 'CT-1', name: 'CT Scanner A', protocol: 'DICOM', transport: 'tcp', state: 'connected' });

  const study = (await (await fetch(`${base}/api/v1/fhir/ImagingStudy/study-123`)).json()) as {
    resourceType: string;
    status: string;
    numberOfSeries: number;
    extension: { url: string; valueUrl?: string }[];
  };
  assert.equal(study.resourceType, 'ImagingStudy');
  assert.equal(study.status, 'available');
  assert.equal(study.numberOfSeries, 1);
  assert.ok(study.extension.some((e) => e.url === 'urn:integration-hub:storageUrl' && e.valueUrl === 'http://orthanc:8042/studies/study-123'));

  const device = (await (await fetch(`${base}/api/v1/fhir/Device/CT-1`)).json()) as {
    resourceType: string;
    status: string;
    type: { text: string };
    deviceName: { name: string }[];
  };
  assert.equal(device.resourceType, 'Device');
  assert.equal(device.status, 'active');
  assert.deepEqual(device.type, { text: 'DICOM' });
  assert.equal(device.deviceName[0]?.name, 'CT Scanner A');
});

test('search supports the _id filter', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message('m1', { payload: LAB }));

  const hit = (await (await fetch(`${base}/api/v1/fhir/Patient?_id=PID-1001`)).json()) as { total: number };
  assert.equal(hit.total, 1);
  const miss = (await (await fetch(`${base}/api/v1/fhir/Patient?_id=nope`)).json()) as { total: number };
  assert.equal(miss.total, 0);
});

test('unknown types and ids answer with FHIR OperationOutcome 404s', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message('m1', { payload: LAB }));

  const badType = (await (await fetch(`${base}/api/v1/fhir/Encounter`)).json()) as {
    resourceType: string;
    issue: { code: string }[];
  };
  assert.equal(badType.resourceType, 'OperationOutcome');
  assert.equal(badType.issue[0]?.code, 'not-found');

  const missing = await fetch(`${base}/api/v1/fhir/Patient/nope`);
  assert.equal(missing.status, 404);
  const outcome = (await missing.json()) as { resourceType: string; issue: { severity: string }[] };
  assert.equal(outcome.resourceType, 'OperationOutcome');
  assert.equal(outcome.issue[0]?.severity, 'error');
});

test('when a corrected result re-sends an accession, the NEWEST message wins', async (t) => {
  const { base, store } = await startApi(t);
  store.record(
    message('m1', {
      payload: {
        ...LAB,
        results: [{ ...LAB.results[0]!, value: '95', measuredAt: '2026-09-04T12:00:00Z' }],
      },
    }),
  );
  store.record(
    message('m2', {
      payload: {
        ...LAB,
        results: [{ ...LAB.results[0]!, value: '110', measuredAt: '2026-09-04T12:30:00Z' }],
      },
    }),
  );

  const obs = (await (await fetch(`${base}/api/v1/fhir/Observation/ACC-88-obs-1`)).json()) as {
    valueQuantity: { value: number };
    effectiveDateTime: string;
  };
  assert.equal(obs.valueQuantity.value, 110);
  assert.equal(obs.effectiveDateTime, '2026-09-04T12:30:00Z');
});

test('fhir routes sit behind key auth (api:read) like the rest of the surface', async (t) => {
  const { base } = await startAuthApi(t);

  // No key → 401 (same gate as /api/v1/messages).
  assert.equal((await fetch(`${base}/api/v1/fhir/metadata`)).status, 401);

  // A viewer (api:read) can read the FHIR surface.
  const viewer = await fetch(`${base}/api/v1/fhir/metadata`, {
    headers: { Authorization: 'Bearer ihk_fhir_viewer' },
  });
  assert.equal(viewer.status, 200);
  assert.equal(((await viewer.json()) as { resourceType: string }).resourceType, 'CapabilityStatement');
});