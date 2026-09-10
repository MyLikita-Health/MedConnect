/** @packageDocumentation
 * W1 — SQLite impls of the remaining core/API store seams (D12): routing,
 * dedup, order/admission registries (matching), alerts, profiles, webhooks.
 * Same contracts as the in-memory + PG impls; better-sqlite3 keeps these
 * synchronous where the contracts allow.
 */
import type {
  Destination,
  DestinationKind,
  DedupStore,
  RouteRule,
  RouteStore,
  Hl7DestinationConfig,
  RetryPolicy,
  ExpectedOrder,
  OrderQuery,
  OrderRegistry,
  AdmissionRecord,
  AdmissionRegistry,
  AlertFilter,
  AlertKind,
  AlertRecord,
  AlertRule,
  AlertStore,
  ProfileStore,
  WebhookSubscriptionStore,
  WebhookSubscription,
} from '@integration-hub/core';
import { DEFAULT_RETRY, parseDeviceProfile, parseWebhookSubscription } from '@integration-hub/core';
import type { DeviceProfile } from '@integration-hub/shared';
import type { SqliteDb } from './schema.js';

// ---------------------------------------------------------------------------
// Routing (RouteStore)
// ---------------------------------------------------------------------------

interface DestinationRow {
  id: string;
  kind: string;
  name: string;
  url: string | null;
  hl7_config: string | null;
  enabled: number;
  retry_policy: string | null;
}

export class SqliteRouteStore implements RouteStore {
  constructor(private readonly db: SqliteDb) {}

  async listDestinations(): Promise<Destination[]> {
    const rows = this.db
      .prepare(`SELECT id, kind, name, url, hl7_config, enabled, retry_policy FROM destinations`)
      .all() as unknown as DestinationRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as DestinationKind,
      name: row.name,
      url: row.url ?? undefined,
      hl7: row.hl7_config === null ? undefined : (JSON.parse(row.hl7_config) as Hl7DestinationConfig),
      enabled: row.enabled === 1,
      retry: row.retry_policy ? (JSON.parse(row.retry_policy) as RetryPolicy) : DEFAULT_RETRY,
    }));
  }

  async upsertDestination(destination: Destination): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO destinations (id, kind, name, url, hl7_config, enabled, retry_policy)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           kind = excluded.kind, name = excluded.name, url = excluded.url,
           hl7_config = excluded.hl7_config, enabled = excluded.enabled, retry_policy = excluded.retry_policy`,
      )
      .run(
        destination.id,
        destination.kind,
        destination.name,
        destination.url ?? null,
        destination.hl7 ? JSON.stringify(destination.hl7) : null,
        destination.enabled ? 1 : 0,
        JSON.stringify(destination.retry),
      );
  }

  async deleteDestination(id: string): Promise<void> {
    this.db.prepare('DELETE FROM destinations WHERE id = ?').run(id);
  }

  async listRules(): Promise<RouteRule[]> {
    const rows = this.db
      .prepare(`SELECT id, destination_id, device_id, status, priority, enabled FROM route_rules ORDER BY priority ASC`)
      .all() as unknown as { id: string; destination_id: string; device_id: string | null; status: string | null; priority: number; enabled: number }[];
    return rows.map((row) => ({
      id: row.id,
      destinationId: row.destination_id,
      deviceId: row.device_id ?? undefined,
      status: row.status ?? undefined,
      priority: row.priority,
      enabled: row.enabled === 1,
    }));
  }

  async upsertRule(rule: RouteRule): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO route_rules (id, destination_id, device_id, status, priority, enabled)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           destination_id = excluded.destination_id, device_id = excluded.device_id,
           status = excluded.status, priority = excluded.priority, enabled = excluded.enabled`,
      )
      .run(rule.id, rule.destinationId, rule.deviceId ?? null, rule.status ?? null, rule.priority, rule.enabled ? 1 : 0);
  }

  async deleteRule(id: string): Promise<void> {
    this.db.prepare('DELETE FROM route_rules WHERE id = ?').run(id);
  }
}

// ---------------------------------------------------------------------------
// Dedup (DedupStore) — expiry checked against an injected/real clock
// ---------------------------------------------------------------------------

export class SqliteDedupStore implements DedupStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly clock: () => number = Date.now,
  ) {}

  async find(key: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT message_id, expires_at FROM dedup_keys WHERE key = ?').get(key) as
      | { message_id: string; expires_at: number }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at <= this.clock()) {
      this.db.prepare('DELETE FROM dedup_keys WHERE key = ?').run(key);
      return undefined;
    }
    return row.message_id;
  }

  async add(key: string, messageId: string, ttlMs: number): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO dedup_keys (key, message_id, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET message_id = excluded.message_id, expires_at = excluded.expires_at`,
      )
      .run(key, messageId, this.clock() + Math.max(ttlMs, 1000));
  }
}

// ---------------------------------------------------------------------------
// Matching registries (OrderRegistry + AdmissionRegistry — the LIS seam)
// ---------------------------------------------------------------------------

interface OrderRow {
  id: string;
  patient_id: string;
  sample_id: string | null;
  tests: string;
  status: string;
  created_at: string;
}

export class SqliteOrderRegistry implements OrderRegistry {
  constructor(private readonly db: SqliteDb) {}

  async find(query: OrderQuery): Promise<ExpectedOrder[]> {
    const clauses: string[] = ['patient_id = ?'];
    const params: unknown[] = [query.patientId];
    if (query.orderId) {
      clauses.push('id = ?');
      params.push(query.orderId);
    }
    if (query.sampleId) {
      clauses.push('sample_id = ?');
      params.push(query.sampleId);
    }
    const rows = this.db
      .prepare(`SELECT id, patient_id, sample_id, tests, status, created_at FROM order_registry WHERE ${clauses.join(' AND ')}`)
      .all(...params) as unknown as OrderRow[];
    return rows.map(rowToOrder);
  }

  async register(order: ExpectedOrder): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO order_registry (id, patient_id, sample_id, tests, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           patient_id = excluded.patient_id, sample_id = excluded.sample_id,
           tests = excluded.tests, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(
        order.id,
        order.patientId,
        order.sampleId ?? null,
        JSON.stringify(order.tests),
        order.status,
        order.receivedAt,
        new Date().toISOString(),
      );
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM order_registry WHERE id = ?').run(id);
  }

  async list(): Promise<ExpectedOrder[]> {
    const rows = this.db
      .prepare(`SELECT id, patient_id, sample_id, tests, status, created_at FROM order_registry ORDER BY created_at DESC`)
      .all() as unknown as OrderRow[];
    return rows.map(rowToOrder);
  }
}

function rowToOrder(row: OrderRow): ExpectedOrder {
  return {
    id: row.id,
    patientId: row.patient_id,
    sampleId: row.sample_id ?? undefined,
    tests: JSON.parse(row.tests) as ExpectedOrder['tests'],
    status: row.status as ExpectedOrder['status'],
    receivedAt: row.created_at,
  };
}

export class SqliteAdmissionRegistry implements AdmissionRegistry {
  constructor(private readonly db: SqliteDb) {}

  async find(patientId: string): Promise<AdmissionRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT patient_id, name, date_of_birth, gender, visit_id, status, created_at
         FROM admission_registry WHERE patient_id = ?`,
      )
      .all(patientId) as unknown as AdmissionRow[];
    return rows.map(rowToAdmission);
  }

  async register(admission: AdmissionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO admission_registry (patient_id, name, date_of_birth, gender, visit_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (patient_id) DO UPDATE SET
           name = excluded.name, date_of_birth = excluded.date_of_birth, gender = excluded.gender,
           visit_id = excluded.visit_id, status = excluded.status`,
      )
      .run(
        admission.patientId,
        admission.name ?? null,
        admission.dateOfBirth ?? null,
        admission.gender ?? null,
        admission.visitId ?? null,
        admission.status,
        admission.receivedAt,
      );
  }

  async list(): Promise<AdmissionRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT patient_id, name, date_of_birth, gender, visit_id, status, created_at FROM admission_registry`,
      )
      .all() as unknown as AdmissionRow[];
    return rows.map(rowToAdmission);
  }
}

interface AdmissionRow {
  patient_id: string;
  name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  visit_id: string | null;
  status: string;
  created_at: string;
}

function rowToAdmission(row: AdmissionRow): AdmissionRecord {
  return {
    patientId: row.patient_id,
    name: row.name ?? undefined,
    dateOfBirth: row.date_of_birth ?? undefined,
    gender: row.gender ?? undefined,
    visitId: row.visit_id ?? undefined,
    status: row.status as AdmissionRecord['status'],
    receivedAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Alerts (AlertStore)
// ---------------------------------------------------------------------------

export class SqliteAlertStore implements AlertStore {
  constructor(private readonly db: SqliteDb) {}

  async listRules(): Promise<AlertRule[]> {
    const rows = this.db
      .prepare(`SELECT * FROM alert_rules ORDER BY kind, id`)
      .all() as unknown as AlertRuleRow[];
    return rows.map(rowToRule);
  }

  async upsertRule(rule: AlertRule): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO alert_rules (id, kind, name, subject, threshold, cooldown_ms, channels, webhook_url, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           kind = excluded.kind, name = excluded.name, subject = excluded.subject,
           threshold = excluded.threshold, cooldown_ms = excluded.cooldown_ms,
           channels = excluded.channels, webhook_url = excluded.webhook_url, enabled = excluded.enabled`,
      )
      .run(
        rule.id,
        rule.kind,
        rule.name,
        rule.subject ?? null,
        rule.threshold,
        rule.cooldownMs ?? null,
        JSON.stringify(rule.channels),
        rule.webhookUrl ?? null,
        rule.enabled ? 1 : 0,
      );
  }

  async deleteRule(id: string): Promise<void> {
    this.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
  }

  async listAlerts(filter: AlertFilter = {}): Promise<AlertRecord[]> {
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = (
      filter.firing
        ? this.db
            .prepare(`SELECT * FROM alerts WHERE status = 'FIRING' ORDER BY fired_at DESC LIMIT ?`)
            .all(limit)
        : this.db.prepare(`SELECT * FROM alerts ORDER BY fired_at DESC LIMIT ?`).all(limit)
    ) as unknown as AlertRecordRow[];
    return rows.map(rowToAlert);
  }

  async openAlert(ruleId: string, subject: string): Promise<AlertRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM alerts WHERE rule_id = ? AND subject = ? AND status = 'FIRING' ORDER BY fired_at DESC LIMIT 1`)
      .get(ruleId, subject) as AlertRecordRow | undefined;
    return row ? rowToAlert(row) : undefined;
  }

  async fire(record: AlertRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO alerts (id, rule_id, kind, subject, message, status, fired_at, resolved_at, count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = excluded.status, resolved_at = excluded.resolved_at, count = excluded.count, message = excluded.message`,
      )
      .run(
        record.id,
        record.ruleId,
        record.kind,
        record.subject ?? null,
        record.message,
        record.status,
        record.firedAt,
        record.resolvedAt ?? null,
        record.count,
      );
  }

  async resolveOpen(ruleId: string, subject: string): Promise<boolean> {
    const info = this.db
      .prepare(
        `UPDATE alerts SET status = 'RESOLVED', resolved_at = ?
         WHERE rule_id = ? AND subject = ? AND status = 'FIRING'`,
      )
      .run(new Date().toISOString(), ruleId, subject);
    return info.changes > 0;
  }
}

interface AlertRuleRow {
  id: string;
  kind: string;
  name: string;
  subject: string | null;
  threshold: number;
  cooldown_ms: number | null;
  channels: string;
  webhook_url: string | null;
  enabled: number;
}

interface AlertRecordRow {
  id: string;
  rule_id: string;
  kind: string;
  subject: string | null;
  message: string;
  status: string;
  fired_at: string;
  resolved_at: string | null;
  count: number;
}

function rowToRule(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    kind: row.kind as AlertKind,
    name: row.name,
    subject: row.subject ?? undefined,
    threshold: row.threshold,
    cooldownMs: row.cooldown_ms ?? undefined,
    channels: JSON.parse(row.channels) as AlertRule['channels'],
    webhookUrl: row.webhook_url ?? undefined,
    enabled: row.enabled === 1,
  };
}

function rowToAlert(row: AlertRecordRow): AlertRecord {
  return {
    id: row.id,
    ruleId: row.rule_id,
    kind: row.kind as AlertKind,
    subject: row.subject ?? undefined,
    message: row.message,
    status: row.status as AlertRecord['status'],
    firedAt: row.fired_at,
    resolvedAt: row.resolved_at ?? undefined,
    count: row.count,
  };
}

// ---------------------------------------------------------------------------
// Device profiles (ProfileStore) — read-back validation per stored profile
// ---------------------------------------------------------------------------

interface ProfileRow {
  id: string;
  profile: string;
}

export class SqliteProfileStore implements ProfileStore {
  constructor(private readonly db: SqliteDb) {}

  async list(): Promise<DeviceProfile[]> {
    const rows = this.db.prepare(`SELECT id, profile FROM profiles`).all() as unknown as ProfileRow[];
    return rows.map((row) => parseDeviceProfile(JSON.parse(row.profile)));
  }

  async get(id: string): Promise<DeviceProfile | undefined> {
    const row = this.db.prepare(`SELECT id, profile FROM profiles WHERE id = ?`).get(id) as ProfileRow | undefined;
    return row ? parseDeviceProfile(JSON.parse(row.profile)) : undefined;
  }

  async upsert(profile: DeviceProfile): Promise<void> {
    const validated = parseDeviceProfile(profile);
    this.db
      .prepare(
        `INSERT INTO profiles (id, profile, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`,
      )
      .run(validated.id, JSON.stringify(validated), new Date().toISOString(), new Date().toISOString());
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }
}

// ---------------------------------------------------------------------------
// Webhook subscriptions (WebhookSubscriptionStore) — read-back validated
// ---------------------------------------------------------------------------

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string;
  enabled: number;
  retry: string | null;
  created_at: string;
}

export class SqliteWebhookStore implements WebhookSubscriptionStore {
  constructor(private readonly db: SqliteDb) {}

  async list(): Promise<WebhookSubscription[]> {
    const rows = this.db
      .prepare(`SELECT id, name, url, secret, events, enabled, retry, created_at FROM webhook_subscriptions`)
      .all() as unknown as WebhookRow[];
    return rows.map((row) =>
      parseWebhookSubscription({
        id: row.id,
        name: row.name,
        url: row.url,
        secret: row.secret,
        events: JSON.parse(row.events),
        enabled: row.enabled === 1,
        retry: row.retry ? JSON.parse(row.retry) : undefined,
        createdAt: row.created_at,
      }),
    );
  }

  async upsert(subscription: WebhookSubscription): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO webhook_subscriptions (id, name, url, secret, events, enabled, retry, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, url = excluded.url, secret = excluded.secret, events = excluded.events,
           enabled = excluded.enabled, retry = excluded.retry`,
      )
      .run(
        subscription.id,
        subscription.name,
        subscription.url,
        subscription.secret,
        JSON.stringify(subscription.events),
        subscription.enabled ? 1 : 0,
        subscription.retry ? JSON.stringify(subscription.retry) : null,
        subscription.createdAt,
      );
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(id);
  }
}
