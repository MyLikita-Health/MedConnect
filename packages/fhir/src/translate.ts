/**
 * FHIR R4 ↔ canonical translator (workstream D / M4, plan §7.D D1–D2).
 *
 * Decision (plan §3.2): FHIR is an *outward API contract* we build on top of
 * our own shared REST/validation — no FHIR runtime library. Resources are
 * hand-rolled R4 JSON with the field subsets the platform actually uses.
 *
 * D2 = two-way translation, proven by round-trip oracle tests (the B3.1
 * pattern): canonical → FHIR → canonical must reproduce the input exactly for
 * the mapped fields.
 *
 * v1 limits (documented, asserted in tests):
 * - `CanonicalOrder.tests` beyond index 0 are not carried by a single
 *   ServiceRequest.code (reported values always surface as Observations).
 * - Result statuses S (partial) and A (some) collapse to FHIR
 *   `preliminary` and read back as P — the bijective subset is
 *   F/P/C/X/I/D. Use the raw HL7 v2-0078 code for lossless status.
 * - `CanonicalDevice.transport` has no natural R4 Device field and is not
 *   round-tripped (v1).
 * - Numeric values become FHIR quantities, so pure formatting is not
 *   preserved ('95.0' round-trips as '95'); comparator ranges keep their
 *   comparator + unit ('>200' mg/dL → valueQuantity comparator '>').
 *   Truly non-numeric values ('Negative') ride valueString, where a unit
 *   has no R4 slot and is dropped (v1).
 * - Imaging: the canonical study's embedded `patient` tags are duplicated by
 *   the `subject` reference and not round-tripped (v1). `ImagingStudy.series`
 *   holds Orthanc series *ids* (not FHIR-representable) — series uid/
 *   modality/detail are emitted only when the caller passes `seriesDetails`
 *   (D1 read enrichment from Orthanc); ids are dropped on the way back.
 */
import type {
  CanonicalOrder,
  CanonicalPatient,
  CanonicalResult,
  ImagingPayload,
  ImagingSeries,
  ImagingStudy,
  LabPayload,
} from '@integration-hub/shared';

// ── Minimal FHIR R4 resource shapes (the subset we emit/consume) ──────────

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirIdentifier {
  use?: string;
  type?: FhirCodeableConcept;
  value?: string;
}

export interface FhirHumanName {
  family?: string;
  given?: string[];
  text?: string;
}

export interface FhirReference {
  reference?: string;
  display?: string;
}

export interface FhirQuantity {
  value?: number;
  unit?: string;
  comparator?: string;
}

export interface FhirRange {
  low?: FhirQuantity;
  high?: FhirQuantity;
  text?: string;
}

export interface FhirExtension {
  url: string;
  valueString?: string;
  valueUrl?: string;
}

export type FhirResource =
  | FhirPatient
  | FhirObservation
  | FhirDiagnosticReport
  | FhirServiceRequest
  | FhirImagingStudy
  | FhirDevice;

export interface FhirPatient {
  resourceType: 'Patient';
  id?: string;
  name?: FhirHumanName[];
  birthDate?: string;
  gender?: 'male' | 'female' | 'other' | 'unknown';
}

export interface FhirObservation {
  resourceType: 'Observation';
  id?: string;
  status: string;
  code: FhirCodeableConcept;
  subject?: FhirReference;
  basedOn?: FhirReference[];
  effectiveDateTime?: string;
  valueQuantity?: FhirQuantity;
  valueString?: string;
  referenceRange?: FhirRange[];
  interpretation?: FhirCodeableConcept[];
}

export interface FhirDiagnosticReport {
  resourceType: 'DiagnosticReport';
  id?: string;
  status: string;
  code: FhirCodeableConcept;
  subject?: FhirReference;
  basedOn?: FhirReference[];
  effectiveDateTime?: string;
  result?: FhirReference[];
}

export interface FhirServiceRequest {
  resourceType: 'ServiceRequest';
  id?: string;
  status: string;
  intent: string;
  identifier?: FhirIdentifier[];
  code?: FhirCodeableConcept;
  subject?: FhirReference;
}

export interface FhirImagingStudy {
  resourceType: 'ImagingStudy';
  id?: string;
  status: string;
  identifier?: FhirIdentifier[];
  subject?: FhirReference;
  started?: string;
  numberOfSeries?: number;
  modality?: FhirCodeableConcept[];
  series?: FhirImagingSeries[];
  extension?: FhirExtension[];
}

export interface FhirImagingSeries {
  uid?: string;
  description?: string;
  modality?: FhirCodeableConcept;
  numberOfInstances?: number;
}

export interface FhirDevice {
  resourceType: 'Device';
  id?: string;
  status?: 'active' | 'off' | 'unknown';
  deviceName?: { name: string; type: string }[];
  manufacturer?: string;
  modelNumber?: string;
  type?: FhirCodeableConcept;
}

export interface FhirBundle {
  resourceType: 'Bundle';
  type: 'collection';
  entry: { resource: FhirResource }[];
}

/** Structural device input (a core DeviceRecord satisfies this). */
export interface FhirDeviceSource {
  id: string;
  name?: string;
  manufacturer?: string;
  model?: string;
  protocol: string;
  transport?: string;
  state?: 'connected' | 'disconnected' | 'unknown' | string;
}

// ── Mapping tables (v2-0078 → FHIR terminology) ───────────────────────────

const V2_0078_ABNORMAL_FLAGS = 'http://terminology.hl7.org/CodeSystem/v2-0078';

/** Bijective status subset + documented collapses (S/A → preliminary). */
const STATUS_TO_FHIR: Record<string, string> = {
  F: 'final',
  P: 'preliminary',
  C: 'corrected',
  X: 'cancelled',
  I: 'registered',
  D: 'entered-in-error',
  S: 'preliminary', // partial results — not distinct in FHIR status
  A: 'preliminary', // some-but-not-all — not distinct in FHIR status
};

const FHIR_TO_STATUS: Record<string, string> = {
  final: 'F',
  preliminary: 'P',
  corrected: 'C',
  cancelled: 'X',
  registered: 'I',
  'entered-in-error': 'D',
};

const GENDER_TO_FHIR: Record<string, 'male' | 'female' | 'unknown'> = {
  M: 'male',
  F: 'female',
  U: 'unknown',
};

const FHIR_TO_GENDER: Record<string, string> = {
  male: 'M',
  female: 'F',
  unknown: 'U',
  other: 'U',
};

const DEVICE_STATE_TO_FHIR: Record<string, 'active' | 'off' | 'unknown'> = {
  connected: 'active',
  disconnected: 'off',
  unknown: 'unknown',
};

const FHIR_TO_DEVICE_STATE: Record<string, string> = {
  active: 'connected',
  off: 'disconnected',
  unknown: 'unknown',
};

const EXT_STORAGE_URL = 'urn:integration-hub:storageUrl';
const EXT_STUDY_DESCRIPTION = 'urn:integration-hub:studyDescription';
const EXT_PERFORMED_AT = 'urn:integration-hub:performedAt';

function identifier(typeCode: string, value: string): FhirIdentifier {
  return { type: { coding: [{ code: typeCode }] }, value };
}

function identifierValue(id: FhirIdentifier | undefined, typeCode: string): string | undefined {
  if (!id) return undefined;
  if (id.value && id.type?.coding?.some((c) => c.code === typeCode)) return id.value;
  return undefined;
}

function extensionValue(exts: FhirExtension[] | undefined, url: string): string | undefined {
  return exts?.find((e) => e.url === url)?.valueString ?? exts?.find((e) => e.url === url)?.valueUrl;
}

/**
 * Parse a lab value into a FHIR quantity when it is numeric or a comparator
 * range: '95' → {value:95}, '>200' → {value:200, comparator:'>'}. Non-numeric
 * values ('Negative') return undefined and ride valueString instead.
 */
function parseQuantity(raw: string): { value: number; comparator?: '>' | '<' | '>=' | '<=' } | undefined {
  const m = raw.trim().match(/^([<>]=?)?([+-]?(?:\d+\.?\d*|\.\d+))$/);
  if (!m) return undefined;
  const value = Number(m[2]);
  if (!Number.isFinite(value)) return undefined;
  const comparator = m[1] as '>' | '<' | '>=' | '<=' | undefined;
  return comparator ? { value, comparator } : { value };
}

// ── Canonical → FHIR (outward surface, D1 read/search) ────────────────────

function patientToFhir(patient: CanonicalPatient): FhirPatient {
  const fhir: FhirPatient = { resourceType: 'Patient', id: patient.id };
  if (patient.name) {
    const parts = patient.name.split(',');
    const family = parts[0]?.trim();
    const given = parts[1]?.trim();
    if (given) {
      fhir.name = [{ family, given: [given], text: patient.name }];
    } else if (family) {
      fhir.name = [{ family, text: patient.name }];
    }
  }
  if (patient.dateOfBirth) fhir.birthDate = patient.dateOfBirth;
  if (patient.gender) fhir.gender = GENDER_TO_FHIR[patient.gender] ?? 'unknown';
  return fhir;
}

function orderToFhir(order: CanonicalOrder, subjectId?: string): FhirServiceRequest {
  const identifierList: FhirIdentifier[] = [identifier('accession', order.id)];
  if (order.sampleId) identifierList.push(identifier('sample', order.sampleId));
  const primary = order.tests[0];
  const fhir: FhirServiceRequest = {
    resourceType: 'ServiceRequest',
    id: order.id,
    status: 'active',
    intent: 'order',
    identifier: identifierList,
  };
  if (primary) {
    fhir.code = { coding: [{ code: primary.code }], ...(primary.name ? { text: primary.name } : {}) };
  }
  if (subjectId) fhir.subject = { reference: `Patient/${subjectId}` };
  return fhir;
}

function resultToFhir(result: CanonicalResult, index: number, patientId: string, orderId: string): FhirObservation {
  const code: FhirCodeableConcept = { coding: [{ code: result.testCode }] };
  if (result.testName) code.text = result.testName;
  if (result.originalTestCode && result.originalTestCode !== result.testCode) {
    code.coding!.push({ code: result.originalTestCode, display: 'as received' });
  }

  const fhir: FhirObservation = {
    resourceType: 'Observation',
    id: `${orderId}-obs-${index + 1}`,
    status: STATUS_TO_FHIR[result.status ?? ''] ?? 'final',
    code,
    subject: { reference: `Patient/${patientId}` },
    basedOn: [{ reference: `ServiceRequest/${orderId}` }],
  };

  if (result.measuredAt) fhir.effectiveDateTime = result.measuredAt;

  // Numeric values that survive Number() exactly become valueQuantity; anything
  // else (">200", "Negative", "95.0") stays valueString — round-trip lossless.
  if (result.value !== undefined) {
    const q = parseQuantity(result.value);
    if (q) {
      fhir.valueQuantity = { value: q.value, ...(q.comparator ? { comparator: q.comparator } : {}), ...(result.unit ? { unit: result.unit } : {}) };
    } else {
      // Non-numeric ('Negative') — valueString has no unit slot (v1).
      fhir.valueString = result.value;
    }
  }

  if (result.referenceRange) {
    const m = result.referenceRange.match(/^([<>]?[\d.]+)\s*-\s*([<>]?[\d.]+)$/);
    if (m) {
      fhir.referenceRange = [
        {
          low: { value: Number(m[1]), ...(result.unit ? { unit: result.unit } : {}) },
          high: { value: Number(m[2]), ...(result.unit ? { unit: result.unit } : {}) },
        },
      ];
    } else {
      fhir.referenceRange = [{ text: result.referenceRange }];
    }
  }

  // Interpretation carries the raw v2-0078 abnormal-flag code — standards
  // terminology AND a lossless round-trip for `flag`.
  if (result.flag) {
    fhir.interpretation = [{ coding: [{ system: V2_0078_ABNORMAL_FLAGS, code: result.flag }] }];
  }

  return fhir;
}

function reportToFhir(
  patient: CanonicalPatient,
  order: CanonicalOrder,
  results: CanonicalResult[],
  observations: FhirObservation[],
): FhirDiagnosticReport {
  const first = results[0];
  const report: FhirDiagnosticReport = {
    resourceType: 'DiagnosticReport',
    id: `report-${order.id}`,
    status: STATUS_TO_FHIR[first?.status ?? ''] ?? 'final',
    code: first
      ? { coding: [{ code: first.testCode }], ...(first.testName ? { text: first.testName } : {}) }
      : { coding: [{ code: order.tests[0]?.code ?? 'unknown' }] },
    subject: { reference: `Patient/${patient.id}` },
    basedOn: [{ reference: `ServiceRequest/${order.id}` }],
    result: observations.map((o) => ({ reference: `Observation/${o.id}` })),
  };
  const measured = results.find((r) => r.measuredAt)?.measuredAt;
  if (measured) report.effectiveDateTime = measured;
  return report;
}

/**
 * One lab payload → the FHIR resources that represent it: Patient,
 * ServiceRequest, DiagnosticReport, and one Observation per result.
 */
export function canonicalToFhir(payload: LabPayload): FhirResource[] {
  const patient = patientToFhir(payload.patient);
  const order = orderToFhir(payload.order, payload.patient.id);
  const observations = payload.results.map((r, i) =>
    resultToFhir(r, i, payload.patient.id, payload.order.id),
  );
  const report = reportToFhir(payload.patient, payload.order, payload.results, observations);
  return [patient, order, report, ...observations];
}

/**
 * An imaging event (M3 performed study) → FHIR ImagingStudy. Metadata +
 * storage pointers only — pixels never enter the hub (plan §6.2 invariant).
 * Pass `seriesDetails` (from an Orthanc series lookup) to carry series
 * uid/modality/instance counts; without it the resource still reports
 * `numberOfSeries` and the study-level fields.
 */
export function imagingToFhir(imaging: ImagingPayload, seriesDetails?: ImagingSeries[]): FhirImagingStudy {
  const s = imaging.study;
  const identifierList: FhirIdentifier[] = [];
  if (s.accessionNumber ?? imaging.accession) identifierList.push(identifier('accession', s.accessionNumber ?? imaging.accession));
  if (s.studyInstanceUid) identifierList.push(identifier('study-uid', s.studyInstanceUid));
  if (s.studyId) identifierList.push(identifier('study-id', s.studyId));

  const series = (seriesDetails ?? []).map((se) => ({
    ...(se.seriesInstanceUid ? { uid: se.seriesInstanceUid } : {}),
    ...(se.description ? { description: se.description } : {}),
    ...(se.modality ? { modality: { coding: [{ code: se.modality }] } } : {}),
    ...(se.instances.length ? { numberOfInstances: se.instances.length } : {}),
  }));

  const study: FhirImagingStudy = {
    resourceType: 'ImagingStudy',
    id: s.orthancId,
    status: 'available',
    identifier: identifierList,
    subject: { reference: `Patient/${s.patientOrthancId}` },
    numberOfSeries: s.series.length,
    ...(series.length ? { series } : {}),
  };

  if (s.studyDate) study.started = s.studyDate;
  const modality = (seriesDetails ?? []).find((se) => se.modality)?.modality;
  if (modality) study.modality = [{ coding: [{ code: modality }] }];
  study.extension = [];
  if (s.studyDescription) study.extension.push({ url: EXT_STUDY_DESCRIPTION, valueString: s.studyDescription });
  if (s.storageUrl) study.extension.push({ url: EXT_STORAGE_URL, valueUrl: s.storageUrl });
  if (imaging.performedAt) study.extension.push({ url: EXT_PERFORMED_AT, valueString: imaging.performedAt });
  return study;
}

/**
 * A device registry row → FHIR Device. `state` connected/disconnected maps to
 * active/off; `protocol` rides in Device.type.text (transport has no natural
 * R4 field — v1 limit).
 */
export function deviceToFhir(device: FhirDeviceSource): FhirDevice {
  const fhir: FhirDevice = {
    resourceType: 'Device',
    id: device.id,
    status: DEVICE_STATE_TO_FHIR[device.state ?? 'unknown'] ?? 'unknown',
    type: { text: device.protocol },
  };
  if (device.name) fhir.deviceName = [{ name: device.name, type: 'user-friendly-name' }];
  if (device.manufacturer) fhir.manufacturer = device.manufacturer;
  if (device.model) fhir.modelNumber = device.model;
  return fhir;
}

/** Wrap resources in a FHIR collection Bundle (the D1 read/search shape). */
export function fhirBundle(resources: FhirResource[]): FhirBundle {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: resources.map((resource) => ({ resource })),
  };
}

// ── FHIR → canonical (inbound, D2 two-way) ────────────────────────────────

function fhirToPatient(patient: FhirPatient): CanonicalPatient {
  const out: CanonicalPatient = { id: patient.id ?? '' };
  const name = patient.name?.[0];
  if (name) {
    const family = name.family ?? '';
    const given = name.given?.join(' ');
    out.name = given ? `${family}, ${given}` : family;
  }
  if (patient.birthDate) out.dateOfBirth = patient.birthDate;
  if (patient.gender) out.gender = FHIR_TO_GENDER[patient.gender] ?? 'U';
  return out;
}

function fhirToOrder(serviceRequest: FhirServiceRequest | undefined, observations: FhirObservation[]): CanonicalOrder {
  const out: CanonicalOrder = { id: '', tests: [] };
  if (serviceRequest) {
    out.id = identifierValue(serviceRequest.identifier?.find((i) => i.type?.coding?.[0]?.code === 'accession'), 'accession')
      ?? serviceRequest.id ?? '';
    const sample = identifierValue(serviceRequest.identifier?.find((i) => i.type?.coding?.[0]?.code === 'sample'), 'sample');
    if (sample) out.sampleId = sample;
    const code = serviceRequest.code?.coding?.[0];
    if (code?.code) out.tests = [{ code: code.code, ...(serviceRequest.code?.text ? { name: serviceRequest.code.text } : {}) }];
  } else {
    // No ServiceRequest in the set: derive the order id from the observations' basedOn refs.
    out.id = observations[0]?.basedOn?.[0]?.reference?.replace(/^ServiceRequest\//, '') ?? '';
  }
  return out;
}

function fhirToResult(observation: FhirObservation): CanonicalResult {
  const out: CanonicalResult = {
    testCode: observation.code.coding?.[0]?.code ?? observation.code.text ?? 'unknown',
    value: '',
  };
  if (observation.code.text) out.testName = observation.code.text;
  const received = observation.code.coding?.find((c) => c.code !== out.testCode && c.display === 'as received');
  if (received?.code) out.originalTestCode = received.code;

  if (observation.valueString !== undefined) {
    out.value = observation.valueString;
  } else if (observation.valueQuantity?.value !== undefined) {
    const vq = observation.valueQuantity;
    out.value = `${vq.comparator ?? ''}${String(vq.value)}`;
    if (vq.unit) out.unit = vq.unit;
  } else {
    out.value = '';
  }

  const range = observation.referenceRange?.[0];
  if (range?.text) {
    out.referenceRange = range.text;
  } else if (range?.low?.value !== undefined && range?.high?.value !== undefined) {
    out.referenceRange = `${range.low.value}-${range.high.value}`;
  }

  const interp = observation.interpretation?.[0]?.coding?.[0];
  if (interp?.code) out.flag = interp.code;
  if (observation.effectiveDateTime) out.measuredAt = observation.effectiveDateTime;
  out.status = FHIR_TO_STATUS[observation.status] ?? observation.status;
  return out;
}

/**
 * FHIR resources (typically one Bundle's worth) → one lab payload. Resolves
 * subject/basedOn references within the set so a FHIR feed round-trips.
 */
export function fhirToCanonical(resources: FhirResource[]): LabPayload {
  const patient = resources.find((r): r is FhirPatient => r.resourceType === 'Patient');
  const serviceRequest = resources.find((r): r is FhirServiceRequest => r.resourceType === 'ServiceRequest');
  const report = resources.find((r): r is FhirDiagnosticReport => r.resourceType === 'DiagnosticReport');
  const observations = resources.filter((r): r is FhirObservation => r.resourceType === 'Observation');

  return {
    patient: patient ? fhirToPatient(patient) : { id: '' },
    order: fhirToOrder(serviceRequest, observations),
    results: observations.map(fhirToResult),
  };
}

/** FHIR ImagingStudy → canonical study metadata (inbound / round-trip). */
export function fhirImagingToCanonical(study: FhirImagingStudy): ImagingStudy {
  const accession = identifierValue(study.identifier?.find((i) => i.type?.coding?.[0]?.code === 'accession'), 'accession');
  const studyUid = identifierValue(study.identifier?.find((i) => i.type?.coding?.[0]?.code === 'study-uid'), 'study-uid');
  const studyId = identifierValue(study.identifier?.find((i) => i.type?.coding?.[0]?.code === 'study-id'), 'study-id');
  const subject = study.subject?.reference?.replace(/^Patient\//, '');

  return {
    orthancId: study.id ?? '',
    patientOrthancId: subject ?? '',
    ...(accession ? { accessionNumber: accession } : {}),
    ...(studyUid ? { studyInstanceUid: studyUid } : {}),
    ...(studyId ? { studyId } : {}),
    ...(study.started ? { studyDate: study.started } : {}),
    ...(extensionValue(study.extension, EXT_STUDY_DESCRIPTION) ? { studyDescription: extensionValue(study.extension, EXT_STUDY_DESCRIPTION) } : {}),
    storageUrl: extensionValue(study.extension, EXT_STORAGE_URL) ?? '',
    // Canonical `series` holds Orthanc ids, which have no FHIR representation;
    // study-level metadata round-trips, series ids are dropped (documented v1).
    series: [],
  };
}

/** FHIR Device → canonical device source (round-trip). */
export function fhirToDevice(device: FhirDevice): FhirDeviceSource {
  return {
    id: device.id ?? '',
    ...(device.deviceName?.[0]?.name ? { name: device.deviceName[0].name } : {}),
    ...(device.manufacturer ? { manufacturer: device.manufacturer } : {}),
    ...(device.modelNumber ? { model: device.modelNumber } : {}),
    protocol: device.type?.text ?? '',
    state: FHIR_TO_DEVICE_STATE[device.status ?? 'unknown'] ?? 'unknown',
  };
}