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