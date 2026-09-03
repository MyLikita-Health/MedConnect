/**
 * Durable delivery dispatcher (plan E3 + §5.3 lifecycle; PRD §21–23).
 *
 * Implements `MessageSink`, so the gateway delivers into it exactly as it did
 * the plain store. The dispatcher:
 *
 *   1. persists the message (viewer sees it immediately),
 *   2. rejects duplicates within the dedup window (PRD §29 → DUPLICATE),
 *   3. sends pipeline-validation failures straight to the DLQ (never dropped),
 *   4. resolves destinations from DB-driven route rules (§5.1 Routing),
 *   5. delivers with per-destination retry/backoff, recording every attempt,
 *      then ROUTED on success or FAILED + DLQ once attempts are exhausted.
 *
 * Delivery is processed in-process (the edge-outbox pattern, plan §4.2); the
 * worker is swappable for Redis/BullMQ on the cloud side via the same seam.
 */
import type { CanonicalMessage, MessageAttempt, MessageSink, MessageStatus } from '@integration-hub/shared';
import { dedupKey, type DedupStore } from './dedup.js';
import { resolveDestinations, type Destination, type RetryPolicy, type RouteStore } from './routing.js';

export interface DeliveryStore {
  record(message: CanonicalMessage): void | Promise<void>;
  mark(id: string, status: MessageStatus, note?: string, fields?: { dlqAt?: string; duplicateOf?: string }): void | Promise<void>;
  recordAttempt(attempt: MessageAttempt): void | Promise<void>;
}

export interface DispatcherOptions {
  store: DeliveryStore;
  dedup: DedupStore;
  routes: RouteStore;
  /** Default true; disable to allow identical re-deliveries. */
  dedupEnabled?: boolean;
  dedupTtlMs?: number;
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

    const destinations = await resolveDestinations(this.opts.routes, message);
    await this.opts.store.mark(message.id, 'QUEUED', `${destinations.length} destination(s): ${destinations.map((d) => d.id).join(', ')}`);
    this.queue.push({ message, destinations });
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