/**
 * D3 — webhook event bus (workstream D / M4, plan §7.D D3; PRD §37).
 *
 * Domain events (NOT routed messages) pushed to subscriber endpoints as
 * signed HTTP POSTs:
 *
 *   result.received / result.validated / result.failed   (lab messages)
 *   order.received                                       (LIS expected-order feed)
 *   device.connected / device.disconnected               (registry state flips)
 *   message.failed                                       (any message reaching FAILED/DLQ)
 *
 * Signature (PRD §37 + the D exit criterion "signature verification tested"):
 * every POST body is HMAC-SHA256'd with the subscription's per-endpoint
 * secret and carried in `X-IntegrationHub-Signature: sha256=<hex>`, alongside
 * `X-IntegrationHub-Event`, `X-IntegrationHub-Event-Id` (the idempotency key —
 * consumers dedupe on it, and replay re-sends the SAME id) and
 * `X-IntegrationHub-Timestamp`. `verifyWebhookSignature` is exported so a
 * receiver (or a test) can check a delivery.
 *
 * Delivery follows a per-subscription retry policy; every attempt is recorded
 * in the delivery log, and `replay` re-sends the failed deliveries for an
 * event (same signed body, same event id). This engine is wiring-free: the
 * server slice fires events at the real fire points (message recorded, device
 * state flip, order registered) and exposes the subscriptions REST surface.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RetryPolicy } from './routing.js';

export const SIGNATURE_HEADER = 'x-integration-hub-signature';
export const EVENT_HEADER = 'x-integration-hub-event';
export const EVENT_ID_HEADER = 'x-integration-hub-event-id';
export const TIMESTAMP_HEADER = 'x-integration-hub-timestamp';

/** The D3 event catalog (plan §7.D; PRD §37 result lifecycle events). */
export type WebhookEventType =
  | 'result.received'
  | 'result.validated'
  | 'result.failed'
  | 'order.received'
  | 'device.connected'
  | 'device.disconnected'
  | 'message.failed';

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
  'result.received',
  'result.validated',
  'result.failed',
  'order.received',
  'device.connected',
  'device.disconnected',
  'message.failed',
];

/** One domain event, delivered to matching subscriptions. */
export interface WebhookEvent {
  /** Delivery/idempotency key: replay re-sends the SAME id. */
  id: string;
  type: WebhookEventType;
  /** ISO timestamp. */
  occurredAt: string;
  /** Hub that observed the event (facility context). */
  source: string;
  /** Domain payload — the resource that changed (message/order/device id + key fields). */
  data: Record<string, unknown>;
}

export interface WebhookSubscription {
  id: string;
  name: string;
  url: string;
  /** HMAC key — signs every delivery to this endpoint. */
  secret: string;
  /** Subscribed event types, or '*' for all. */
  events: WebhookEventType[] | '*';
  enabled: boolean;
  /** Delivery retry policy (DEFAULT_RETRY when omitted). */
  retry?: RetryPolicy;
  createdAt: string;
}

export interface WebhookDeliveryAttempt {
  eventId: string;
  subscriptionId: string;
  attempt: number;
  ok: boolean;
  status?: number;
  error?: string;
  at: string;
}

export interface WebhookDelivery {
  eventId: string;
  subscriptionId: string;
  ok: boolean;
  attempts: WebhookDeliveryAttempt[];
  lastError?: string;
  deliveredAt?: string;
}

export interface EventBusOptions {
  /** Seed subscriptions (the bus starts empty when omitted). */
  subscriptions?: WebhookSubscription[];
  /** fetch override for tests (defaults to global fetch). */
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface FireEventInput {
  type: WebhookEventType;
  source: string;
  data: Record<string, unknown>;
  /** Explicit id (tests / replay of a known event); defaults to a UUID. */
  id?: string;
  occurredAt?: string;
}

/** HMAC-SHA256 signature header value for a body. */
export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Constant-time verification of `X-IntegrationHub-Signature` against a body. */
export function verifyWebhookSignature(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(signature.slice('sha256='.length), 'hex');
  const actual = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The event bus: fire(event) → deliver a signed POST to every enabled,
 * matching subscription (retries per policy), recording each attempt; list
 * subscriptions/deliveries; add/remove subscriptions; replay(eventId) →
 * re-send the failed deliveries for an event.
 */
export class EventBus {
  private readonly deliveries = new Map<string, WebhookDelivery>();
  /** Event envelopes kept for replay (bounded FIFO). */
  private readonly events = new Map<string, WebhookEvent>();
  /** Live subscriptions, managed at runtime via add/remove + the REST surface. */
  private readonly subs = new Map<string, WebhookSubscription>();
  private readonly doFetch: typeof fetch;
  private readonly log: EventBusOptions['log'];

  constructor(opts: EventBusOptions) {
    for (const sub of opts.subscriptions ?? []) this.subs.set(sub.id, sub);
    this.doFetch = opts.fetch ?? fetch.bind(globalThis);
    this.log = opts.log;
  }
  /** Every subscription (management + console views). */
  listSubscriptions(): WebhookSubscription[] {
    return [...this.subs.values()];
  }

  /** Add or replace a subscription (idempotent — REST upsert). */
  addSubscription(subscription: WebhookSubscription): void {
    this.subs.set(subscription.id, subscription);
  }

  /** Remove a subscription; returns false when it did not exist. */
  removeSubscription(id: string): boolean {
    return this.subs.delete(id);
  }

  private deliveryKey(eventId: string, subscriptionId: string): string {
    return `${eventId}/${subscriptionId}`;
  }

  private recordAttempt(key: string, attempt: WebhookDeliveryAttempt, ok: boolean): void {
    const current = this.deliveries.get(key) ?? {
      eventId: attempt.eventId,
      subscriptionId: attempt.subscriptionId,
      ok: false,
      attempts: [],
    };
    current.attempts.push(attempt);
    current.ok = ok;
    if (ok) {
      current.deliveredAt = attempt.at;
      current.lastError = undefined;
    } else {
      current.lastError = attempt.error ?? 'delivery failed';
    }
    this.deliveries.set(key, current);
  }

  /** Deliver one event to one subscription (used by fire + replay). */
  private async deliver(event: WebhookEvent, sub: WebhookSubscription): Promise<void> {
    const retry = sub.retry;
    const maxAttempts = retry?.maxAttempts ?? 3;
    const backoffMs = retry?.backoffMs ?? 1000;
    const backoffFactor = retry?.backoffFactor ?? 2;
    const key = this.deliveryKey(event.id, sub.id);

    const body = JSON.stringify(event);
    const signature = signWebhook(sub.secret, body);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [EVENT_HEADER]: event.type,
      [EVENT_ID_HEADER]: event.id,
      [TIMESTAMP_HEADER]: event.occurredAt,
      [SIGNATURE_HEADER]: signature,
    };

    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const at = new Date().toISOString();
      try {
        const res = await this.doFetch(sub.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        this.recordAttempt(key, { eventId: event.id, subscriptionId: sub.id, attempt, ok: true, status: res.status, at }, true);
        this.log?.(`[webhooks] ${event.type} -> ${sub.id} OK (attempt ${attempt})`);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.recordAttempt(
          key,
          { eventId: event.id, subscriptionId: sub.id, attempt, ok: false, error: lastError, at },
          false,
        );
        this.log?.(`[webhooks] ${event.type} -> ${sub.id} attempt ${attempt} failed: ${lastError}`);
        if (attempt < maxAttempts) {
          await sleep(backoffMs * backoffFactor ** (attempt - 1));
        }
      }
    }
  }

  /**
   * Fire a domain event to every enabled matching subscription. Non-matching
   * subscriptions are skipped; an event with NO matching subscription is a
   * no-op (nothing to deliver). The envelope is retained (bounded) so a later
   * replay re-sends the EXACT signed body. Returns the event id (the
   * idempotency key — consumers dedupe on it) and how many subscriptions
   * matched.
   */
  async fire(input: FireEventInput): Promise<{ id: string; matched: number }> {
    const event: WebhookEvent = {
      id: input.id ?? randomUUID(),
      type: input.type,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      source: input.source,
      data: input.data,
    };
    this.events.set(event.id, event);
    if (this.events.size > 500) {
      const oldest = this.events.keys().next().value;
      if (oldest) this.events.delete(oldest);
    }
    const subs = [...this.subs.values()].filter((s) => s.enabled && (s.events === '*' || s.events.includes(event.type)));
    await Promise.all(subs.map((sub) => this.deliver(event, sub)));
    return { id: event.id, matched: subs.length };
  }

  /** Every recorded delivery (ok + failed), newest first. */
  listDeliveries(): WebhookDelivery[] {
    return [...this.deliveries.values()].reverse();
  }

  /**
   * Replay the FAILED deliveries of one event (D exit: "webhook replay
   * tested"). Re-sends the same signed body with the same event id, so a
   * consumer that already saw the event dedupes on X-IntegrationHub-Event-Id.
   * Returns the number of subscriptions re-attempted.
   */
  async replay(eventId: string): Promise<number> {
    const event = this.events.get(eventId);
    if (!event) return 0;
    const failed = [...this.deliveries.values()].filter((d) => d.eventId === eventId && !d.ok);
    const subs = [...this.subs.values()].filter(
      (s) => failed.some((d) => d.subscriptionId === s.id) && s.enabled,
    );
    await Promise.all(subs.map((sub) => this.deliver(event, sub)));
    return subs.length;
  }
}
