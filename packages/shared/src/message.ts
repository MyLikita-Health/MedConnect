/** Message envelope and pipeline contracts shared across packages. */
import type { ImagingStudy } from './imaging.js';
import type { LabPayload } from './model.js';

/**
 * Hub-originated imaging event (workstream M3.3 storage routing). Imaging
 * events are NOT lab exchanges: they carry study metadata (storage URLs only —
 * pixels never enter the hub, plan §6.2), so they ride in the envelope's
 * dedicated `imaging` field rather than the parse→map `payload`. `payload`
 * stays the lab translation artifact, and `imaging` the performed-study event.
 */
export interface ImagingPayload {
  kind: 'imaging';
  /** The performed study's canonical metadata (storageUrl points at Orthanc). */
  study: ImagingStudy;
  /** Accession number (the RIS/registry order id) the study performed. */
  accession: string;
  /** When the hub's poll observed the study (ISO). */
  performedAt: string;
}

export type Protocol = 'ASTM' | 'HL7' | 'FHIR' | 'REST';
export type Direction = 'device-to-host' | 'host-to-device';

/**
 * Message lifecycle (plan §5.3; PRD §25, §28, §52).
 *
 *   RECEIVED → PARSED → VALIDATED → MAPPED → QUEUED → DELIVERING → ROUTED
 *                                              ↘ any failure → FAILED (+ DLQ)
 *   Dedup hit              → DUPLICATE
 *   Operator discard       → DISCARDED (from DLQ)
 *   Match/validation hold  → HELD (exception queue for review, PRD §27–28)
 *
 * Terminal statuses: ROUTED (success), FAILED (never silently dropped — goes
 * to the dead-letter queue), DUPLICATE, DISCARDED. HELD is a review queue: an
 * operator releases a held message back into delivery (PRD §27 no silent
 * auto-assign; §28 exception queue).
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
  | 'DISCARDED'
  | 'HELD';

/**
 * Patient/order matching outcome (PRD §27; plan workstream E6). Matching never
 * silently auto-assigns: only a unique strategy hit is MATCHED; anything else
 * is held for operator review.
 */
export type MatchStatus = 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' | 'REJECTED';

/** Matching metadata attached to a message once the matching engine has run. */
export interface MessageMatch {
  status: MatchStatus;
  /** The registry order this message matched, when MATCHED. */
  matchedOrderId?: string;
  matchedPatientId?: string;
  /** Strategy that produced the match, e.g. "patientId+orderId". */
  strategy?: string;
  /** Why the message was rejected, when REJECTED. */
  reason?: string;
  at: string; // ISO timestamp
}

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
  /**
   * Imaging study event (workstream M3.3): set when this message records a
   * performed study routed by the hub (metadata + storage URLs only).
   */
  imaging?: ImagingPayload;
  status: MessageStatus;
  errors: string[];
  timeline: TimelineEntry[];
  /** Set when the message enters the dead-letter queue (plan §5.3 DLQ workflow). */
  dlqAt?: string;
  /** Set when the message was detected as a duplicate (PRD §29). */
  duplicateOf?: string;
  /** Patient/order matching outcome (PRD §27); set by the matching engine. */
  match?: MessageMatch;
  /**
   * A4 profile stamp: the DeviceProfile config that parsed this message (id +
   * version) and, when the hub knows the profile's certification baseline
   * (its goldens record version `certifiedVersion`), whether the current
   * stored profile has drifted from that baseline (edited after
   * certification). Stamping makes every message auditable back to the exact
   * config that produced it — version enforcement surfaces a drifted profile
   * instead of silently parsing results with unverified offsets.
   */
  profile?: ProfileStamp;
  /**
   * Cloud tenancy stamps (H1 write-through, plan §5.2): the org + facility
   * the message belongs to. Set on a cloud-mode hub (or an edge shipping to
   * the cloud); absent on a single-tenant edge. The D11 outbox write-through
   * copies these into the sync entry so the cloud can route it.
   */
  orgId?: string;
  facilityId?: string;
}

/** Profile provenance of a parsed message (see CanonicalMessage.profile). */
export interface ProfileStamp {
  /** Profile id (device registry binding), e.g. 'acme-chem-200'. */
  id: string;
  /** Stored profile version at parse time. */
  version: number;
  /** Version the profile's goldens were recorded under (certification baseline). */
  certifiedVersion?: number;
  /** true when version ≠ certifiedVersion: the config drifted from its certification. */
  drift?: boolean;
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