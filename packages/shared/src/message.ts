/** Message envelope and pipeline contracts shared across packages. */
import type { LabPayload } from './model.js';

export type Protocol = 'ASTM' | 'HL7' | 'FHIR' | 'REST';
export type Direction = 'device-to-host' | 'host-to-device';

/**
 * Pipeline stages a message moves through (PRD §25, §28, §52).
 * Terminal statuses: ROUTED (success) or FAILED (never silently dropped).
 */
export type MessageStatus =
  | 'RECEIVED'
  | 'PARSED'
  | 'VALIDATED'
  | 'MAPPED'
  | 'ROUTED'
  | 'FAILED';

/** A protocol-agnostic parsed record (ASTM, HL7 segment, ...). */
export interface ParsedRecord {
  type: string;
  fields: string[];
}

export interface TimelineEntry {
  stage: string;
  at: string; // ISO timestamp
  note?: string;
}

/** Every message that flows through the hub (PRD §24 Message Viewer). */
export interface CanonicalMessage {
  id: string;
  protocol: Protocol;
  direction: Direction;
  deviceId?: string;
  receivedAt: string; // ISO timestamp
  /** Raw protocol text as received on the wire. */
  raw: string;
  /** Parsed protocol records (for the message viewer). */
  records?: ParsedRecord[];
  /** Canonical payload after parse -> validate -> map. */
  payload?: LabPayload;
  status: MessageStatus;
  errors: string[];
  timeline: TimelineEntry[];
}

/** Where the gateway delivers processed messages (implemented by the API store). */
export interface MessageSink {
  record(message: CanonicalMessage): void;
}

/** Vendor test-code mapping table: device code -> canonical code (PRD §17–18). */
export type MappingTable = Record<string, string>;