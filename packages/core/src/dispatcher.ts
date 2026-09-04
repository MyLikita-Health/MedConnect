/**
 * Durable delivery dispatcher (plan E3 + §5.3 lifecycle; PRD §21–23).
 *
 * Implements `MessageSink`, so the gateway delivers into it exactly as it did
 * the plain store. The dispatcher:
 *
 *   1. persists the message (viewer sees it immediately),
 *   2. rejects duplicates within the dedup window (PRD §29 → DUPLICATE),
 *   3. sends pipeline-validation failures straight to the DLQ (never dropped),
 *   4. runs patient/order matching (E6, PRD §27) and result validation
 *      (E5, PRD §28); failures are HELD in the exception queue for review —
 *      never silently auto-assigned, never delivered,
 *   5. resolves destinations from DB-driven route rules (§5.1 Routing),
 *   6. delivers with per-destination retry/backoff, recording every attempt,
 *      then ROUTED on success or FAILED + DLQ once attempts are exhausted.
 *
 * Delivery is processed in-process (the edge-outbox pattern, plan §4.2); the
 * worker is swappable for Redis/BullMQ on the cloud side via the same seam.
 */
import type { CanonicalMessage, MessageAttempt, MessageMatch, MessageSink, MessageStatus } from '@integration-hub/shared';
import { dedupKey, type DedupStore } from './dedup.js';
import { matchMessage, matchToMessageMatch, DEFAULT_MATCHING_CONFIG, type MatchingConfig, type OrderRegistry } from './matching.js';
import { resolveDestinations, type Destination, type RetryPolicy, type RouteStore } from './routing.js';
import { validateMessage, type ValidationConfig } from './validate.js';

export interface DeliveryStore {
  record(message: CanonicalMessage): void | Promise<void>;
  mark(
    id: string,
    status: MessageStatus,
    note?: string,
    fields?: { dlqAt?: string; duplicateOf?: string; match?: MessageMatch },
  ): void | Promise<void>;
  recordAttempt(attempt: MessageAttempt): void | Promise<void>;
  /** Used by `release()` to re-enter a held message into delivery. */
  get?(id: string): CanonicalMessage | undefined | Promise<CanonicalMessage | undefined>;
}

export interface DeliveryEvent {
  messageId: string;
  destinationId: string;
  attempt: number;
  ok: boolean;
  error?: string;
}

/** Optional lifecycle observers (wired to alerting, plan workstream I). */
export interface DispatcherEvents {
  /** One delivery attempt finished (success or failure). */
  onDelivery?(event: DeliveryEvent): void | Promise<void>;
  /** A message entered the dead-letter queue. */
  onDlq?(message: CanonicalMessage, reason: string): void | Promise<void>;
  /** A message was parked in the HELD exception queue. */
  onHold?(message: CanonicalMessage, reason: string): void | Promise<void>;
  /** An operator released a held message into delivery. */
  onRelease?(messageId: string): void | Promise<void>;
}

export interface DispatcherOptions {
  store: DeliveryStore;
  dedup: DedupStore;
  routes: RouteStore;
  /** Default true; disable to allow identical re-deliveries. */
  dedupEnabled?: boolean;
  dedupTtlMs?: number;
  /**
   * Patient/order matching (PRD §27). Omit to skip matching (protocol-level
   * delivery only). When set with `onUnmatched: 'hold'` (the default), any
   * message that does not uniquely match a registered order is HELD.
   */
  matching?: { registry: OrderRegistry; config?: MatchingConfig };
  /** Result validation (PRD §28); runs after matching when configured. */
  validation?: { config: Partial<ValidationConfig> };
  /** Optional lifecycle observers (wired to alerting, plan workstream I). */
  events?: DispatcherEvents;
  /** Worker poll interval when the queue is empty. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export const DEFAULT_DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

interface Job {
  message: CanonicalMessage;
  destinations: Destination[];
}

export class Dispatcher implements MessageSink {
  private readonly queue: Job[] = [];
  private running = false;
  private timer?: NodeJS.Timeout;
  private inflight?: Promise<void>;

  constructor(private readonly opts: DispatcherOptions) {}

  /** Entry point from the gateway (MessageSink). */
  async record(message: CanonicalMessage): Promise<void> {
    await this.opts.store.record(message);

    // Pipeline-validation failures are routed straight to the DLQ — never dropped.
    if (message.status === 'FAILED') {
      await this.dlq(message, 'pipeline validation failed');
      return;
    }

    if (this.opts.dedupEnabled !== false) {
      const key = dedupKey(message);
      const original = await this.opts.dedup.find(key);
      if (original) {
        await this.opts.store.mark(message.id, 'DUPLICATE', `duplicate of ${original}`, { duplicateOf: original });
        this.opts.log?.(`[dispatcher] ${message.id} duplicate of ${original}`);
        return;
      }
      await this.opts.dedup.add(key, message.id, this.opts.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS);
    }

    // Patient/order matching (E6) then validation (E5). Hold outcomes park the
    // message in the exception queue; the operator reviews and releases it.
    let match: MessageMatch | undefined;
    if (this.opts.matching) {
      const outcome = await matchMessage(
        message,
        this.opts.matching.registry,
        this.opts.matching.config ?? DEFAULT_MATCHING_CONFIG,
      );
      match = matchToMessageMatch(outcome);
      message.match = match;
      await this.opts.store.mark(message.id, message.status, `match: ${outcome.status}${outcome.strategy ? ` (${outcome.strategy})` : ''}`, { match });
      const hold = outcome.status !== 'MATCHED' && (this.opts.matching.config ?? DEFAULT_MATCHING_CONFIG).onUnmatched === 'hold';
      if (hold) {
        await this.hold(message, outcome.status === 'REJECTED' ? outcome.reason ?? 'rejected' : `not matched: ${outcome.status}`);
        return;
      }
    }

    if (this.opts.validation) {
      const result = validateMessage(message, match, this.opts.validation.config);
      if (result.errors.length > 0) {
        await this.hold(message, `validation failed: ${result.errors.join('; ')}`);
        return;
      }
      if (result.warnings.length > 0) {
        await this.opts.store.mark(message.id, message.status, `validation: ${result.warnings.length} warning(s) — ${result.warnings.join('; ')}`);
      }
    }

    const destinations = await resolveDestinations(this.opts.routes, message);
    await this.opts.store.mark(message.id, 'QUEUED', `${destinations.length} destination(s): ${destinations.map((d) => d.id).join(', ')}`);
    this.queue.push({ message, destinations });
  }

  /**
   * Operator action on the exception queue (PRD §27/§28): re-enters a HELD
   * message into delivery. Returns false when the message is not held.
   */
  async release(id: string): Promise<boolean> {
    if (!this.opts.store.get) return false;
    const message = await this.opts.store.get(id);
    if (!message || message.status !== 'HELD') return false;
    await this.opts.store.mark(id, 'QUEUED', 'released by operator after review');
    message.status = 'QUEUED';
    const destinations = await resolveDestinations(this.opts.routes, message);
    this.queue.push({ message, destinations });
    this.opts.log?.(`[dispatcher] ${id} released into delivery`);
    await this.opts.events?.onRelease?.(id);
    return true;
  }

  private async hold(message: CanonicalMessage, reason: string): Promise<void> {
    await this.opts.store.mark(message.id, 'HELD', `HELD: ${reason}`);
    this.opts.log?.(`[dispatcher] ${message.id} → HELD (${reason})`);
    await this.opts.events?.onHold?.(message, reason);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pump();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inflight) await this.inflight.catch(() => undefined);
  }

  /** Test helper: number of queued but undelivered jobs. */
  pendingJobs(): number {
    return this.queue.length;
  }

  private pump(): void {
    if (!this.running) return;
    const job = this.queue.shift();
    if (!job) {
      this.timer = setTimeout(() => this.pump(), this.opts.pollMs ?? 10);
      return;
    }
    this.inflight = this.process(job).finally(() => {
      this.inflight = undefined;
      this.pump();
    });
  }

  private async process(job: Job): Promise<void> {
    const { message, destinations } = job;
    const failures: string[] = [];
    for (const destination of destinations) {
      await this.opts.store.mark(message.id, 'DELIVERING', `destination ${destination.id}`);
      let delivered = false;
      let lastError = '';
      for (let attempt = 1; attempt <= destination.retry.maxAttempts; attempt++) {
        try {
          await deliver(destination, message);
          await this.opts.store.recordAttempt({
            messageId: message.id,
            destinationId: destination.id,
            attempt,
            status: 'OK',
            at: iso(),
          });
          delivered = true;
          await this.opts.events?.onDelivery?.({
            messageId: message.id,
            destinationId: destination.id,
            attempt,
            ok: true,
          });
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          await this.opts.store.recordAttempt({
            messageId: message.id,
            destinationId: destination.id,
            attempt,
            status: 'FAILED',
            error: lastError,
            at: iso(),
          });
          await this.opts.events?.onDelivery?.({
            messageId: message.id,
            destinationId: destination.id,
            attempt,
            ok: false,
            error: lastError,
          });
          if (attempt < destination.retry.maxAttempts) {
            await this.sleep(backoffMs(destination.retry, attempt));
          }
        }
      }
      if (!delivered) failures.push(`${destination.id}: ${lastError}`);
    }

    if (failures.length === 0) {
      await this.opts.store.mark(message.id, 'ROUTED', `delivered to ${destinations.length} destination(s)`);
    } else {
      await this.dlq(message, `delivery failed: ${failures.join('; ')}`);
    }
  }

  private async dlq(message: CanonicalMessage, reason: string): Promise<void> {
    await this.opts.store.mark(message.id, 'FAILED', `DLQ: ${reason}`, { dlqAt: iso() });
    this.opts.log?.(`[dispatcher] ${message.id} → DLQ (${reason})`);
    await this.opts.events?.onDlq?.(message, reason);
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Exponential backoff with optional ±20% jitter. */
export function backoffMs(retry: RetryPolicy, attempt: number): number {
  const base = retry.backoffMs * Math.pow(retry.backoffFactor, attempt - 1);
  if (!retry.jitter || base === 0) return base;
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function iso(): string {
  return new Date().toISOString();
}

/** Deliver a message to one destination. */
export async function deliver(destination: Destination, message: CanonicalMessage): Promise<void> {
  if (destination.kind === 'console') return; // already persisted in the store
  if (destination.kind === 'http') {
    if (!destination.url) throw new Error(`destination ${destination.id} has no url`);
    const res = await fetch(destination.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${destination.url}`);
    return;
  }
  throw new Error(`unknown destination kind: ${destination.kind}`);
}