/**
 * The internal canonical data model (PRD §16).
 *
 * The Integration Core must never depend on a specific device vendor or
 * protocol. Every protocol adapter translates to/from these shapes, so the
 * core stays vendor-neutral and new protocols are just new translators.
 */

export type Gender = 'M' | 'F' | 'U';

/** HL7/ASTM result status codes (subset). */
export type ResultStatus = 'F' | 'P' | 'C' | 'X' | 'I' | 'D' | 'S' | 'A';

export interface CanonicalPatient {
  /** Patient identifier as provided by the device/LIS (e.g. hospital ID). */
  id: string;
  /** Display name, e.g. "Doe, John". */
  name?: string;
  /** Date of birth, ideally ISO (YYYY-MM-DD); may be raw device format. */
  dateOfBirth?: string;
  gender?: string;
}

export interface CanonicalTestRequest {
  /** Test code in the canonical space (post-mapping). */
  code: string;
  name?: string;
  priority?: string;
}

export interface CanonicalOrder {
  /** Order / accession identifier. */
  id: string;
  /** Specimen/sample barcode when present. */
  sampleId?: string;
  tests: CanonicalTestRequest[];
}

export interface CanonicalResult {
  /** Canonical (post-mapping) test code. */
  testCode: string;
  /** Test code as received from the device, when it differs from the canonical one. */
  originalTestCode?: string;
  testName?: string;
  value: string;
  unit?: string;
  referenceRange?: string;
  /** Abnormal flag: N normal, H high, L low, A abnormal, ... */
  flag?: string;
  status?: string;
  measuredAt?: string;
}

/** Payload of a laboratory message (order/result exchange). */
export interface LabPayload {
  patient: CanonicalPatient;
  order: CanonicalOrder;
  results: CanonicalResult[];
}