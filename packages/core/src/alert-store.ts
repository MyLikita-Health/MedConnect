/**
 * Alert storage: rules (config) and derived alerts (fire/resolve history).
 * In-memory here; `PostgresAlertStore` (pg-alerts.ts) mirrors the contract.
 */
export type AlertKind =
  | 'device-offline'
  | 'destination-down'
  | 'dlq'
  | 'held-backlog'
  | 'profile-drift'
  | 'orthanc-down';

export interface AlertRule {
  id: string;
  kind: AlertKind;
  name: string;
  /** Constrain to one device/destination; empty = any subject. */
  subject?: string;
  /** Fires when the event count / backlog reaches this. */
  threshold: number;
  /** Min ms between firings of the same rule+subject while unresolved. */
  cooldownMs?: number;
  channels: ('console' | 'webhook')[];
  webhookUrl?: string;
  enabled: boolean;
}

export interface AlertRecord {
  id: string;
  ruleId: string;
  kind: AlertKind;
  subject?: string;
  message: string;
  status: 'FIRING' | 'RESOLVED';
  firedAt: string;
  resolvedAt?: string;
  count: number;
}

export interface AlertFilter {
  firing?: boolean;
  limit?: number;
}

export interface AlertStore {
  listRules(): AlertRule[] | Promise<AlertRule[]>;
  upsertRule(rule: AlertRule): void | Promise<void>;
  deleteRule(id: string): void | Promise<void>;
  listAlerts(filter?: AlertFilter): AlertRecord[] | Promise<AlertRecord[]>;
  /** The currently-FIRING alert for a rule+subject, if any. */
  openAlert(ruleId: string, subject: string): AlertRecord | undefined | Promise<AlertRecord | undefined>;
  fire(record: AlertRecord): void | Promise<void>;
  /** Resolve any open alert; returns true when one was resolved. */
  resolveOpen(ruleId: string, subject: string): boolean | Promise<boolean>;
}

export class InMemoryAlertStore implements AlertStore {
  private readonly rules = new Map<string, AlertRule>();
  private readonly alerts: AlertRecord[] = [];

  async listRules(): Promise<AlertRule[]> {
    return [...this.rules.values()];
  }

  async upsertRule(rule: AlertRule): Promise<void> {
    this.rules.set(rule.id, rule);
  }

  async deleteRule(id: string): Promise<void> {
    this.rules.delete(id);
  }

  async listAlerts(filter: AlertFilter = {}): Promise<AlertRecord[]> {
    let out = this.alerts;
    if (filter.firing) out = out.filter((a) => a.status === 'FIRING');
    const limit = filter.limit ?? 100;
    return [...out].reverse().slice(0, limit);
  }

  async openAlert(ruleId: string, subject: string): Promise<AlertRecord | undefined> {
    return this.alerts.find((a) => a.ruleId === ruleId && (a.subject ?? '') === subject && a.status === 'FIRING');
  }

  async fire(record: AlertRecord): Promise<void> {
    this.alerts.push(record);
  }

  async resolveOpen(ruleId: string, subject: string): Promise<boolean> {
    const alert = this.alerts.find((a) => a.ruleId === ruleId && (a.subject ?? '') === subject && a.status === 'FIRING');
    if (!alert) return false;
    alert.status = 'RESOLVED';
    alert.resolvedAt = new Date().toISOString();
    return true;
  }
}