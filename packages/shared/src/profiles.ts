/**
 * Config-first device profiles (PRD §39–40, plan §6.3, workstream A2).
 *
 * A profile describes how ONE analyzer model speaks to the hub, so certified
 * device support is *configuration*, not code. Positions are **1-based**
 * field numbers exactly as documented by vendors (seq = position 1), i.e.
 * the field after the record sequence number.
 *
 * The reference layout this scaffold assumed is just one profile
 * (`astm-reference-v1`); vendors that deviate get their own profile, and a
 * profile only ships after its golden-message conformance run passes
 * (workstream K).
 */
import type { MappingTable } from './message.js';
import type { Protocol } from './message.js';

export type DeviceTransport = 'tcp' | 'serial' | 'api';
export type ProfileStatus = 'draft' | 'certified';
export type SessionInitiator = 'device' | 'host';

/** 1-based field positions inside an ASTM P record (seq is position 1). */
export interface PatientRecordLayout {
  /** Patient identifier (1-based field position). */
  id: number;
  /** Display name field, conventionally "Last^First^Suffix" components. */
  name?: number;
  dateOfBirth?: number;
  sex?: number;
}

/** 1-based field positions inside an ASTM O record. */
export interface OrderRecordLayout {
  /** Specimen / sample barcode position. */
  sampleId?: number;
  /** Order / accession identifier position. */
  accession: number;
  /** Test request position, conventionally "^code^name". */
  test: number;
}

/** 1-based field positions inside an ASTM R record. */
export interface ResultRecordLayout {
  /** Test identifier position, conventionally "^code^name". */
  test: number;
  value: number;
  unit?: number;
  referenceRange?: number;
  flag?: number;
  status?: number;
}

/** Vendor record-layout overrides for a profile (real devices deviate!). */
export interface DeviceRecordLayout {
  patient?: PatientRecordLayout;
  order?: OrderRecordLayout;
  result?: ResultRecordLayout;
}

// ---------------------------------------------------------------------------
// HL7 v2 segment-level layouts (workstream B4). ASTM positions are record-
// level (1-based P/O/R field numbers); HL7 vendors deviate at the SEGMENT
// level (which PID/OBR/OBX field carries what, sometimes which component of
// a composite). The defaults below reproduce the generic translator's fixed
// positions exactly; a profile with an `hl7` layout overrides them.
// ---------------------------------------------------------------------------

/** 1-based segment field (+ optional 1-based component) reference. */
export interface Hl7FieldRef {
  field: number;
  component?: number;
}

/** PID segment overrides (defaults: id PID-3^1, name PID-5, DOB PID-7, sex PID-8). */
export interface Hl7PatientLayout {
  /** PID-3 (CX): identifier component. */
  id: Hl7FieldRef;
  /** PID-5 (XPN): family^given^middle convention. */
  name?: Hl7FieldRef;
  /** PID-7 (TS). */
  dateOfBirth?: Hl7FieldRef;
  /** PID-8 (IS). */
  sex?: Hl7FieldRef;
}

/** Order-anchor overrides (defaults: OBR-3 filler, OBR-2 placer, OBR-4 test). */
export interface Hl7OrderLayout {
  /** Segment the order anchors on ('OBR' default; ORC for ORC-anchored feeds). */
  segment?: 'OBR' | 'ORC';
  /** Filler / accession id (default OBR-3 or ORC-3). */
  fillerId?: Hl7FieldRef;
  /** Placer id fallback (default OBR-2 or ORC-2). */
  placerId?: Hl7FieldRef;
  /** Requested-test field on OBR (default OBR-4, CE identifier). */
  test?: Hl7FieldRef;
}

/** OBX segment overrides (defaults: code OBX-3^1, name OBX-3^2, value OBX-5, unit OBX-6^1, …). */
export interface Hl7ResultLayout {
  /** CE identifier component (default OBX-3^1). */
  testCode: Hl7FieldRef;
  /** CE text component (default OBX-3^2 — the name conventionally rides with the code). */
  testName?: Hl7FieldRef;
  value: Hl7FieldRef;
  unit?: Hl7FieldRef;
  referenceRange?: Hl7FieldRef;
  flag?: Hl7FieldRef;
  status?: Hl7FieldRef;
  measuredAt?: Hl7FieldRef;
}

/**
 * Vendor HL7 v2 layout overrides (workstream B4 — segment-level, the ASTM
 * record layout cannot describe HL7 segment variants). `delimiters` is the
 * escape hatch for senders whose MSH-2 lies about the actual separators.
 */
export interface Hl7RecordLayout {
  /** MSH-2 separator overrides (applied to the wire before parsing). */
  delimiters?: {
    component?: string;
    repetition?: string;
    escape?: string;
    subcomponent?: string;
  };
  patient?: Partial<Hl7PatientLayout>;
  order?: Partial<Hl7OrderLayout>;
  result?: Partial<Hl7ResultLayout>;
}

/** Transport-level options relevant to adapters (used by future A1/A4 work). */
export interface DeviceProfileConnection {
  host?: string;
  port?: number;
  /** RS-232 parameters for transport = 'serial'. */
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd';
}

export interface DeviceProfileSession {
  /** Who starts the ASTM session (ENQ). Defaults to 'device'. */
  initiator?: SessionInitiator;
  /** Some analyzers require the ACK to echo the frame number. */
  frameNumbering?: 'none' | 'echo';
  /** Some analyzers exclude STX from the mod-256 checksum. */
  checksumIncludesStx?: boolean;
}

/** Canonical capability names (PRD §20 bidirectional flows). */
export type DeviceCapability = 'results-up' | 'orders-down' | 'host-query';

/**
 * One certified device profile (plan §6.3 example fields). The `layout`
 * drives canonicalization; everything else configures the adapter.
 */
export interface DeviceProfile {
  /** Stable slug, e.g. 'acme-chem-200'. */
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  protocol: Protocol;
  transport: DeviceTransport;
  /** Config version — bump on change; keep certified goldens per version. */
  version: number;
  layout: DeviceRecordLayout;
  /**
   * HL7 v2 segment-level overrides (workstream B4). Present only on HL7
   * profiles: the generic translator's fixed PID/OBR/OBX positions, with
   * this profile's deviations. `layout` (ASTM) stays the generic baseline
   * for non-HL7 protocols.
   */
  hl7?: Hl7RecordLayout;
  /** Device test-code → canonical overrides for this model (PRD §17–18). */
  mappings?: MappingTable;
  capabilities?: DeviceCapability[];
  connection?: DeviceProfileConnection;
  session?: DeviceProfileSession;
  status: ProfileStatus;
  /** When the profile passed its conformance run. */
  certifiedAt?: string;
}

/**
 * The reference layout used by the scaffold/simulator (documented in the
 * pipeline): P | seq | (res) | patient id | Last^First | (res) | DOB | sex;
 * O | seq | sample id | accession | ^code^name; R | seq | ^code^name |
 * value | unit | ref | flag | (nature) | status.
 */
export const DEFAULT_REFERENCE_LAYOUT: Required<DeviceRecordLayout> = {
  patient: { id: 3, name: 4, dateOfBirth: 6, sex: 7 },
  order: { sampleId: 2, accession: 3, test: 4 },
  result: { test: 2, value: 3, unit: 4, referenceRange: 5, flag: 6, status: 8 },
};

export function defaultLayoutFor(profile: Pick<DeviceProfile, 'layout'>): DeviceRecordLayout {
  return {
    patient: profile.layout.patient ?? DEFAULT_REFERENCE_LAYOUT.patient,
    order: profile.layout.order ?? DEFAULT_REFERENCE_LAYOUT.order,
    result: profile.layout.result ?? DEFAULT_REFERENCE_LAYOUT.result,
  };
}

/**
 * A fully-resolved HL7 layout: every segment position pinned (the generic
 * defaults, with a profile's partial overrides applied). The translator reads
 * against this — no optional chaining at read sites, so a missing override
 * can't silently skip a field.
 */
export type ResolvedHl7Layout = {
  delimiters?: Hl7RecordLayout['delimiters'];
  patient: Required<Hl7PatientLayout>;
  order: Required<Hl7OrderLayout>;
  result: Required<Hl7ResultLayout>;
};

/** The generic HL7 translator's fixed positions, as the default layout. */
export const DEFAULT_HL7_LAYOUT: ResolvedHl7Layout = {
  patient: { id: { field: 3, component: 1 }, name: { field: 5 }, dateOfBirth: { field: 7 }, sex: { field: 8 } },
  order: { segment: 'OBR', fillerId: { field: 3, component: 1 }, placerId: { field: 2, component: 1 }, test: { field: 4, component: 1 } },
  result: {
    testCode: { field: 3, component: 1 },
    testName: { field: 3, component: 2 },
    value: { field: 5 },
    unit: { field: 6, component: 1 },
    referenceRange: { field: 7 },
    flag: { field: 8 },
    status: { field: 11 },
    measuredAt: { field: 14 },
  },
};

/**
 * Resolve a profile's HL7 overrides against the generic defaults (a partial
 * `hl7` layout declares only its deviations — same spirit as `defaultLayoutFor`).
 */
export function defaultHl7LayoutFor(profile: { hl7?: Hl7RecordLayout }): ResolvedHl7Layout {
  const h = profile.hl7 ?? {};
  return {
    ...(h.delimiters ? { delimiters: h.delimiters } : {}),
    patient: { ...DEFAULT_HL7_LAYOUT.patient, ...h.patient },
    order: { ...DEFAULT_HL7_LAYOUT.order, ...h.order },
    result: { ...DEFAULT_HL7_LAYOUT.result, ...h.result },
  };
}