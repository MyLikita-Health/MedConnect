/**
 * DB-driven routing (plan §5.1 Routing group, PRD §19). A route rule matches a
 * message by device and/or status; the highest-priority matching rules select
 * destinations. With no matching rules, the built-in `console` destination is
 * used (messages are already persisted in the store, so this is a no-op
 * delivery that completes the lifecycle).
 */
import type { Pool } from 'pg';
import type { CanonicalMessage } from '@integration-hub/shared';

export type DestinationKind = 'console' | 'http' | 'hl7';

export interface RetryPolicy {
  /** Total attempts per destination (1 = no retry). */
  maxAttempts: number;
  /** Base delay before the second attempt. */
  backoffMs: number;
  /** Exponential factor applied per retry. */
  backoffFactor: number;
  /** +/- 20% jitter to avoid thundering-herd retries. */
  jitter: boolean;
}

export interface Destination {
  id: string;
  kind: DestinationKind;
  name: string;
  /** HTTP URL for kind = 'http'. */
  url?: string;
  /**
   * MLLP endpoint for kind = 'hl7' (workstream B3): the delivery writes the
   * canonical message out as HL7 v2 and awaits the application ACK. Delivered
   * by an injected `deliver` in the Dispatcher (the integration core stays
   * protocol-blind); a destination of this kind with no deliverer throws on
   * delivery, exactly like any unhandled kind.
   */
  hl7?: Hl7DestinationConfig;
  enabled: boolean;
  retry: RetryPolicy;
}

/** Outbound MLLP endpoint for an `hl7` destination (plan §6.4, B3). */
export interface Hl7DestinationConfig {
  host: string;
  port: number;
  /** MSH-3 sending application (default 'HUB'). */
  sendingApp?: string;
  /** MSH-4 sending facility. */
  sendingFacility?: string;
  /** MSH-5 receiving application (the LIS). */
  receivingApp?: string;
  /** MSH-6 receiving facility. */
  receivingFacility?: string;
  /** MSH-12 version (default 2.5.1). */
  version?: string;
}

export interface RouteRule {
  id: string;
  destinationId: string;
  /** Matches any device when absent. */
  deviceId?: string;
  /** Matches any status when absent (e.g. 'MAPPED' to target only routable messages). */
  status?: string;
  /** Lower number = higher priority. */
  priority: number;
  enabled: boolean;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, backoffMs: 250, backoffFactor: 2, jitter: true };

export const CONSOLE_DESTINATION: Destination = {
  id: 'console',
  kind: 'console',
  name: 'Message viewer (built-in)',
  enabled: true,
  retry: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitter: false },
};

export interface RouteStore {
  listDestinations(): Promise<Destination[]>;
  upsertDestination(destination: Destination): Promise<void>;
  deleteDestination(id: string): Promise<void>;
  listRules(): Promise<RouteRule[]>;
  upsertRule(rule: RouteRule): Promise<void>;
  deleteRule(id: string): Promise<void>;
}

/** Resolve the destinations a message should be delivered to. */
export async function resolveDestinations(routes: RouteStore, message: CanonicalMessage): Promise<Destination[]> {
  const rules = (await routes.listRules())
    .filter((r) => r.enabled)
    .filter((r) => !r.deviceId || r.deviceId === message.deviceId)
    .filter((r) => !r.status || r.status === message.status)
    .sort((a, b) => a.priority - b.priority);

  const destinations = new Map<string, Destination>();
  for (const rule of rules) {
    const destination = (await routes.listDestinations()).find((d) => d.id === rule.destinationId);
    if (destination && destination.enabled && !destinations.has(destination.id)) {
      destinations.set(destination.id, destination);
    }
  }
  if (destinations.size === 0) return [CONSOLE_DESTINATION];
  return [...destinations.values()];
}

export class InMemoryRouteStore implements RouteStore {
  private readonly destinations = new Map<string, Destination>();
  private readonly rules: RouteRule[] = [];

  async listDestinations(): Promise<Destination[]> {
    return [...this.destinations.values()];
  }

  async upsertDestination(destination: Destination): Promise<void> {
    this.destinations.set(destination.id, destination);
  }

  async deleteDestination(id: string): Promise<void> {
    this.destinations.delete(id);
    for (let i = this.rules.length - 1; i >= 0; i--) {
      if (this.rules[i]!.destinationId === id) this.rules.splice(i, 1);
    }
  }

  async listRules(): Promise<RouteRule[]> {
    return [...this.rules];
  }

  async upsertRule(rule: RouteRule): Promise<void> {
    const index = this.rules.findIndex((r) => r.id === rule.id);
    if (index >= 0) this.rules[index] = rule;
    else this.rules.push(rule);
  }

  async deleteRule(id: string): Promise<void> {
    const index = this.rules.findIndex((r) => r.id === id);
    if (index >= 0) this.rules.splice(index, 1);
  }
}

export class PostgresRouteStore implements RouteStore {
  constructor(private readonly pool: Pool) {}

  async listDestinations(): Promise<Destination[]> {
    const { rows } = await this.pool.query<{
      id: string;
      kind: string;
      name: string;
      url: string | null;
      hl7_config: unknown;
      enabled: boolean;
      retry_policy: unknown;
    }>(`SELECT id, kind, name, url, hl7_config, enabled, retry_policy FROM destinations`);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as DestinationKind,
      name: row.name,
      url: row.url ?? undefined,
      hl7: row.hl7_config === null ? undefined : (row.hl7_config as Hl7DestinationConfig),
      enabled: row.enabled,
      retry: (row.retry_policy ?? DEFAULT_RETRY) as RetryPolicy,
    }));
  }

  async upsertDestination(destination: Destination): Promise<void> {
    await this.pool.query(
      `INSERT INTO destinations (id, kind, name, url, hl7_config, enabled, retry_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         name = EXCLUDED.name,
         url = EXCLUDED.url,
         hl7_config = EXCLUDED.hl7_config,
         enabled = EXCLUDED.enabled,
         retry_policy = EXCLUDED.retry_policy`,
      [
        destination.id,
        destination.kind,
        destination.name,
        destination.url ?? null,
        destination.hl7 ? JSON.stringify(destination.hl7) : null,
        destination.enabled,
        JSON.stringify(destination.retry),
      ],
    );
  }

  async deleteDestination(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM destinations WHERE id = $1`, [id]);
  }

  async listRules(): Promise<RouteRule[]> {
    const { rows } = await this.pool.query<{
      id: string;
      destination_id: string;
      device_id: string | null;
      status: string | null;
      priority: number;
      enabled: boolean;
    }>(`SELECT id, destination_id, device_id, status, priority, enabled FROM route_rules`);
    return rows.map((row) => ({
      id: row.id,
      destinationId: row.destination_id,
      deviceId: row.device_id ?? undefined,
      status: row.status ?? undefined,
      priority: row.priority,
      enabled: row.enabled,
    }));
  }

  async upsertRule(rule: RouteRule): Promise<void> {
    await this.pool.query(
      `INSERT INTO route_rules (id, destination_id, device_id, status, priority, enabled)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         destination_id = EXCLUDED.destination_id,
         device_id = EXCLUDED.device_id,
         status = EXCLUDED.status,
         priority = EXCLUDED.priority,
         enabled = EXCLUDED.enabled`,
      [rule.id, rule.destinationId, rule.deviceId ?? null, rule.status ?? null, rule.priority, rule.enabled],
    );
  }

  async deleteRule(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM route_rules WHERE id = $1`, [id]);
  }
}