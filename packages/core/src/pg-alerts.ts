/**
 * PostgreSQL-backed alert store (plan workstream I). Same contract as
 * `InMemoryAlertStore`: rules in `alert_rules`, derived alerts in `alerts`.
 */
import type { Pool } from 'pg';
import type { AlertFilter, AlertKind, AlertRecord, AlertRule, AlertStore } from './alert-store.js';

interface RuleRow {
  id: string;
  kind: string;
  name: string;
  subject: string | null;
  threshold: number;
  cooldown_ms: number | null;
  channels: unknown;
  webhook_url: string | null;
  enabled: boolean;
}

interface AlertRow {
  id: string;
  rule_id: string;
  kind: string;
  subject: string | null;
  message: string;
  status: string;
  fired_at: Date | string;
  resolved_at: Date | string | null;
  count: number;
}

export class PostgresAlertStore implements AlertStore {
  constructor(private readonly pool: Pool) {}

  async listRules(): Promise<AlertRule[]> {
    const { rows } = await this.pool.query<RuleRow>(`SELECT * FROM alert_rules ORDER BY kind, id`);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as AlertKind,
      name: r.name,
      subject: r.subject ?? undefined,
      threshold: r.threshold,
      cooldownMs: r.cooldown_ms ?? undefined,
      channels: (r.channels as ('console' | 'webhook')[]) ?? ['console'],
      webhookUrl: r.webhook_url ?? undefined,
      enabled: r.enabled,
    }));
  }

  async upsertRule(rule: AlertRule): Promise<void> {
    await this.pool.query(
      `INSERT INTO alert_rules (id, kind, name, subject, threshold, cooldown_ms, channels, webhook_url, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         name = EXCLUDED.name,
         subject = EXCLUDED.subject,
         threshold = EXCLUDED.threshold,
         cooldown_ms = EXCLUDED.cooldown_ms,
         channels = EXCLUDED.channels,
         webhook_url = EXCLUDED.webhook_url,
         enabled = EXCLUDED.enabled`,
      [
        rule.id,
        rule.kind,
        rule.name,
        rule.subject ?? null,
        rule.threshold,
        rule.cooldownMs ?? null,
        JSON.stringify(rule.channels),
        rule.webhookUrl ?? null,
        rule.enabled,
      ],
    );
  }

  async deleteRule(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM alert_rules WHERE id = $1`, [id]);
  }

  async listAlerts(filter: AlertFilter = {}): Promise<AlertRecord[]> {
    const params: unknown[] = [];
    let where = '';
    if (filter.firing) {
      params.push('FIRING');
      where = `WHERE status = $${params.length}`;
    }
    params.push(Math.min(filter.limit ?? 100, 500));
    const { rows } = await this.pool.query<AlertRow>(
      `SELECT * FROM alerts ${where} ORDER BY fired_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(rowToAlert);
  }

  async openAlert(ruleId: string, subject: string): Promise<AlertRecord | undefined> {
    const { rows } = await this.pool.query<AlertRow>(
      `SELECT * FROM alerts WHERE rule_id = $1 AND subject IS NOT DISTINCT FROM $2 AND status = 'FIRING'
       ORDER BY fired_at DESC LIMIT 1`,
      [ruleId, subject === '' ? null : subject],
    );
    return rows[0] ? rowToAlert(rows[0]) : undefined;
  }

  async fire(record: AlertRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO alerts (id, rule_id, kind, subject, message, status, fired_at, count)
       VALUES ($1,$2,$3,$4,$5,'FIRING',$6,$7)`,
      [
        record.id,
        record.ruleId,
        record.kind,
        record.subject ?? null,
        record.message,
        new Date(record.firedAt),
        record.count,
      ],
    );
  }

  async resolveOpen(ruleId: string, subject: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE alerts SET status = 'RESOLVED', resolved_at = now()
       WHERE rule_id = $1 AND subject IS NOT DISTINCT FROM $2 AND status = 'FIRING'`,
      [ruleId, subject === '' ? null : subject],
    );
    return (rowCount ?? 0) > 0;
  }
}

function rowToAlert(row: AlertRow): AlertRecord {
  return {
    id: row.id,
    ruleId: row.rule_id,
    kind: row.kind as AlertKind,
    subject: row.subject ?? undefined,
    message: row.message,
    status: row.status as AlertRecord['status'],
    firedAt: new Date(row.fired_at).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : undefined,
    count: row.count,
  };
}