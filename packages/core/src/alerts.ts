/**
 * Alerting (plan workstream I; PRD §33). Rules are evaluated against events
 * flowing through the hub and fan out to channels (console = the alert store,
 * webhook = HTTP POST). Five rule kinds:
 *
 *   device-offline    — a device's connection state turned offline (fires);
 *                       back to connected (resolves)
 *   destination-down  — consecutive failed deliveries to one destination
 *                       reached the threshold (fires); any success resolves
 *   dlq               — dead-letter-queue backlog at/above threshold (checked
 *                       on each DLQ transition)
 *   held-backlog      — exception-queue backlog at/above threshold (checked
 *                       on hold/release transitions)
 *   profile-drift     — a bound device delivered a message under a profile
 *                       whose stored version no longer matches its golden-
 *                       recorded certification baseline (fires per device on
 *                       the first drifted delivery; a subsequent non-drifted
 *                       delivery resolves)
 *
 * A rule+subject fires at most once until it is resolved (or its cooldown
 * elapses while still open), so operators are not spammed on every event.
 */
import type { AlertKind, AlertRecord, AlertRule, AlertStore } from './alert-store.js';

export interface AlertServiceOptions {
  log?: (line: string) => void;
  now?: () => Date;
  /** HTTP POST for webhook-channel alerts; injectable for tests. */
  webhook?: (url: string, body: unknown) => Promise<void>;
}

export class AlertService {
  private readonly consecutive = new Map<string, number>();
  private readonly lastFired = new Map<string, number>();

  constructor(
    private readonly store: AlertStore,
    private readonly opts: AlertServiceOptions = {},
  ) {}

  /** Device connection state transition (gateway onDeviceState). */
  async deviceState(deviceId: string, state: string): Promise<void> {
    if (state === 'connected' || state === 'online') {
      await this.clear('device-offline', deviceId, `${deviceId} reconnected`);
      return;
    }
    if (state === 'offline' || state === 'disconnected') {
      await this.fire('device-offline', deviceId, `${deviceId} is ${state}`, 1);
    }
  }

  /** One failed delivery attempt against a destination (dispatcher). */
  async deliveryFailed(destinationId: string, error: string): Promise<void> {
    const key = `destination-down:${destinationId}`;
    const count = (this.consecutive.get(key) ?? 0) + 1;
    this.consecutive.set(key, count);
    await this.fire('destination-down', destinationId, `delivery to ${destinationId} failed (${count}×): ${error}`, count);
  }

  /** A delivery to a destination succeeded — clears its down state. */
  async deliverySucceeded(destinationId: string): Promise<void> {
    this.consecutive.delete(`destination-down:${destinationId}`);
    await this.clear('destination-down', destinationId, `${destinationId} accepting deliveries again`);
  }

  /**
   * Backlog check (dlq / held-backlog). Call after every transition that
   * changes the count. Fires when at/above threshold; resolves below it.
   */
  async checkBacklog(kind: Extract<AlertKind, 'dlq' | 'held-backlog'>, count: number, subject?: string): Promise<void> {
    const rules = await this.store.listRules();
    for (const rule of rules) {
      if (rule.kind !== kind || !rule.enabled) continue;
      if (rule.subject && rule.subject !== subject && subject !== undefined) continue;
      if (rule.subject && !subject) continue; // rule scoped to a subject, check is global
      const open = await this.store.openAlert(rule.id, rule.subject ?? subject ?? '');
      if (count >= rule.threshold) {
        if (open) continue; // already firing
        const key = `${rule.id}:${rule.subject ?? ''}`;
        const last = this.lastFired.get(key) ?? 0;
        if (this.now() - last < (rule.cooldownMs ?? 0)) continue;
        this.lastFired.set(key, this.now());
        await this.doFire(rule, subject ?? '', `${kind} backlog is ${count} (threshold ${rule.threshold})`, count);
      } else if (open) {
        await this.store.resolveOpen(rule.id, rule.subject ?? '');
        this.opts.log?.(`[alerts] resolved ${rule.id} — ${kind} backlog ${count} < ${rule.threshold}`);
        await this.notifyWebhooks(rule, undefined, `${kind} backlog cleared`);
      }
    }
  }

  /**
   * Profile-version drift (gateway onDrift): a bound device delivered under a
   * profile whose stored version differs from the version its goldens were
   * recorded under. Fires `profile-drift` for that device on the first drifted
   * delivery; any later delivery that is no longer drifted (clean stamp, or
   * the device was unbound/detached) resolves the open alert. Per-device
   * subject, so operators are paged once per drifted analyzer, not per message.
   */
  async profileDrift(event: {
    deviceId: string;
    drift: boolean;
    profileId?: string;
    version?: number;
    certifiedVersion?: number;
  }): Promise<void> {
    const { deviceId, drift } = event;
    if (drift) {
      const detail =
        event.profileId !== undefined && event.version !== undefined
          ? `profile ${event.profileId} v${event.version} drifted from its certified v${event.certifiedVersion} (goldens) — verify config before trusting results`
          : `delivering under a drifted profile`;
      await this.fire('profile-drift', deviceId, `${deviceId} ${detail}`, 1);
    } else {
      await this.clear('profile-drift', deviceId, `${deviceId} no longer delivering under a drifted profile`);
    }
  }

  /** Fire a rule+subject if its threshold is met and it is not already open. */
  private async fire(kind: AlertKind, subject: string, message: string, count: number): Promise<void> {
    const rules = await this.store.listRules();
    for (const rule of rules) {
      if (rule.kind !== kind || !rule.enabled) continue;
      if (rule.subject && rule.subject !== subject) continue;
      const open = await this.store.openAlert(rule.id, rule.subject ?? subject);
      if (open) continue;
      const key = `${rule.id}:${rule.subject ?? subject}`;
      const last = this.lastFired.get(key) ?? 0;
      if (this.now() - last < (rule.cooldownMs ?? 0)) continue;
      if (count < rule.threshold) continue;
      this.lastFired.set(key, this.now());
      await this.doFire(rule, subject, message, count);
    }
  }

  /** Resolve any open alert for a rule+subject (device reconnected, destination up, ...). */
  private async clear(kind: AlertKind, subject: string, message: string): Promise<void> {
    const rules = await this.store.listRules();
    for (const rule of rules) {
      if (rule.kind !== kind || !rule.enabled) continue;
      if (rule.subject && rule.subject !== subject) continue;
      const resolved = await this.store.resolveOpen(rule.id, rule.subject ?? subject);
      if (!resolved) continue;
      this.opts.log?.(`[alerts] resolved ${rule.id} — ${message}`);
      await this.notifyWebhooks(rule, undefined, message);
    }
  }

  private async doFire(rule: AlertRule, subject: string, message: string, count: number): Promise<void> {
    const record: AlertRecord = {
      id: randomId(),
      ruleId: rule.id,
      kind: rule.kind,
      subject: rule.subject ?? (subject || undefined),
      message,
      status: 'FIRING',
      firedAt: new Date(this.now()).toISOString(),
      count,
    };
    await this.store.fire(record);
    this.opts.log?.(`[alerts] ${rule.id} FIRING — ${message}`);
    await this.notifyWebhooks(rule, record, undefined);
  }

  private async notifyWebhooks(rule: AlertRule, fired: AlertRecord | undefined, resolvedMessage: string | undefined): Promise<void> {
    if (!rule.channels.includes('webhook') || !rule.webhookUrl) return;
    try {
      await (this.opts.webhook ?? defaultWebhook)(rule.webhookUrl, {
        rule: rule.id,
        kind: rule.kind,
        status: fired ? 'FIRING' : 'RESOLVED',
        ...(fired ? { alert: fired } : { message: resolvedMessage }),
      });
    } catch (err) {
      this.opts.log?.(`[alerts] webhook ${rule.webhookUrl} failed: ${(err as Error).message}`);
    }
  }

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }
}

async function defaultWebhook(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function randomId(): string {
  return `alrt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}