/** Message envelope and pipeline contracts shared across packages. */
import type { LabPayload } from './model.js';

export type Protocol = 'ASTM' | 'HL7' | 'FHIR' | 'REST';
export type Direction = 'device-to-host' | 'host-to-device';

/**
 * Message lifecycle (plan §5.3; PRD §25, §28, §52).
 *
 *   RECEIVED → PARSED → VALIDATED → MAPPED → QUEUED → DELIVERING → ROUTED
 *                                              ↘ any failure → FAILED (+ DLQ)
 *   Dedup hit           → DUPLICATE
 *   Operator discard    → DISCARDED (from DLQ)
 *
 * Terminal statuses: ROUTED (success), FAILED (never silently dropped — goes
 * to the dead-letter queue), DUPLICATE, DISCARDED.
 */
export type MessageStatus =
  | 'RECEIVED'
  | 'PARSED'
  | 'VALIDATED'
  | 'MAPPED'
  | 'QUEUED'
  | 'DELIVERING'
  | 'ROUTED'
  | 'FAILED'
  | 'DUPLICATE'
  | 'DISCARDED';

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
  /** Set when the message enters the dead-letter queue (plan §5.3 DLQ workflow). */
  dlqAt?: string;
  /** Set when the message was detected as a duplicate (PRD §29). */
  duplicateOf?: string;
}

/** One delivery attempt against a destination (plan §5.1 Messages group). */
export interface MessageAttempt {
  messageId: string;
  destinationId: string;
  attempt: number;
  status: 'OK' | 'FAILED';
  error?: string;
  at: string; // ISO timestamp
}

/**
 * Where the gateway delivers processed messages (implemented by the API store).
 * Implementations may persist asynchronously (e.g. PostgreSQL); synchronous
 * in-memory sinks may simply return void.
 */
export interface MessageSink {
  record(message: CanonicalMessage): void | Promise<void>;
}

/** Vendor test-code mapping table: device code -> canonical code (PRD §17–18). */
export type MappingTable = Record<string, string>;