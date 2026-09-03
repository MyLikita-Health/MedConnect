/**
 * Backend contracts for the API layer (M0: in-memory or PostgreSQL).
 *
 * Methods return either a value or a promise so the lightweight in-memory
 * stores stay synchronous while the durable Postgres stores are async — the
 * Fastify handlers `await` everything, which works for both.
 */
import type { CanonicalMessage, MappingTable } from '@integration-hub/shared';
import type { DeviceRecord, RegisterDeviceInput } from './devices.js';
import type { MessageFilter, StoreStats } from './store.js';

export type StoreKind = 'memory' | 'postgres';
export type DeviceKind = 'memory' | 'postgres';

export interface StoreBackend {
  readonly kind: StoreKind;
  record(message: CanonicalMessage): void | Promise<void>;
  list(filter?: MessageFilter): CanonicalMessage[] | Promise<CanonicalMessage[]>;
  get(id: string): CanonicalMessage | undefined | Promise<CanonicalMessage | undefined>;
  stats(): StoreStats | Promise<StoreStats>;
  /** DB-driven test-code mapping table (PRD §17–18); in-memory store returns its own table. */
  getMappings?(): MappingTable | Promise<MappingTable>;
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
}