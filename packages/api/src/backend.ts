/**
 * Backend contracts for the API layer (M0: in-memory or PostgreSQL).
 *
 * Methods return either a value or a promise so the lightweight in-memory
 * stores stay synchronous while the durable Postgres stores are async — the
 * Fastify handlers `await` everything, which works for both.
 */
import type { CanonicalMessage, MappingTable, MessageAttempt, MessageMatch, MessageStatus } from '@integration-hub/shared';
import type { DeviceRecord, RegisterDeviceInput } from './devices.js';
import type { MessageFilter, StoreStats } from './store.js';
import type { OutboxWriter } from '@integration-hub/core';

export type StoreKind = 'memory' | 'postgres' | 'sqlite';
export type DeviceKind = 'memory' | 'postgres' | 'sqlite';

export interface MarkFields {
  dlqAt?: string;
  /** Clear the DLQ marker (an operator retried a dead-lettered message). */
  clearDlq?: boolean;
  duplicateOf?: string;
  /** Patient/order matching outcome (PRD §27, E6). */
  match?: MessageMatch;
}

export interface StoreBackend {
  readonly kind: StoreKind;
  record(message: CanonicalMessage): void | Promise<void>;
  list(filter?: MessageFilter): CanonicalMessage[] | Promise<CanonicalMessage[]>;
  get(id: string): CanonicalMessage | undefined | Promise<CanonicalMessage | undefined>;
  stats(): StoreStats | Promise<StoreStats>;
  /** Advance the message lifecycle (plan §5.3); appends a timeline entry. */
  mark(id: string, status: MessageStatus, note?: string, fields?: MarkFields): void | Promise<void>;
  /** Persist one delivery attempt (plan §5.1 MessageAttempt). */
  recordAttempt(attempt: MessageAttempt): void | Promise<void>;
  /** DB-driven test-code mapping table (PRD §17–18); in-memory store returns its own table. */
  getMappings?(): MappingTable | Promise<MappingTable>;
  /**
   * D11 write-through: when set, local writes also append sync entries (the
   * edge's durable outbox). Optional — in-memory stores don't sync.
   */
  outbox?: { append: OutboxWriter['append'] };
  /**
   * H1 cloud tenancy write-through: stamps written rows with org/facility.
   * Set on cloud-mode hubs and edges shipping for a cloud org.
   */
  tenancy?: { orgId: string; facilityId: string };
}

export interface UpsertFromConnectionInput {
  id: string;
  name?: string;
  protocol?: DeviceRecord['protocol'];
  transport?: DeviceRecord['transport'];
  state: DeviceRecord['state'];
}

export interface DeviceStats {
  total: number;
  connected: number;
  offline: number;
}

export interface DeviceBackend {
  readonly kind: DeviceKind;
  register(input: RegisterDeviceInput): DeviceRecord | Promise<DeviceRecord>;
  upsertFromConnection(input: UpsertFromConnectionInput): DeviceRecord | Promise<DeviceRecord>;
  get(id: string): DeviceRecord | undefined | Promise<DeviceRecord | undefined>;
  list(): DeviceRecord[] | Promise<DeviceRecord[]>;
  stats(): DeviceStats | Promise<DeviceStats>;
  /** Drop a device row — e.g. an auto-registered Orthanc modality that is no
   *  longer configured. Returns false when no such device exists. */
  remove(id: string): boolean | Promise<boolean>;
  /** D11 write-through (optional; see StoreBackend.outbox). */
  outbox?: { append: OutboxWriter['append'] };
  /** H1 cloud tenancy write-through (optional; see StoreBackend.tenancy). */
  tenancy?: { orgId: string; facilityId: string };
}