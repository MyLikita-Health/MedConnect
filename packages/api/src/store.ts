/**
 * In-memory message store (scaffold default; `PostgresMessageStore` is the
 * durable M0+ alternative). The `MessageSink` contract is what the gateway
 * sees, so the backend can be swapped without touching the pipeline.
 *
 * M1: lifecycle transitions via `mark` (plan §5.3), delivery-attempt history,
 * and a dead-letter-queue filter (PRD §23).
 */
import { EventEmitter } from 'node:events';
import type { CanonicalMessage, MessageAttempt, MessageSink, MessageStatus } from '@integration-hub/shared';
import type { MarkFields } from './backend.js';

export interface MessageFilter {
  deviceId?: string;
  status?: string;
  /** Only messages that reached the dead-letter queue. */
  dlq?: boolean;
  limit?: number;
}

export interface StoreStats {
  total: number;
  today: number;
  failed: number;
  pending: number;
  byStatus: Record<string, number>;
}

const PENDING_STATUSES: MessageStatus[] = ['RECEIVED', 'QUEUED', 'DELIVERING'];

export class MessageStore implements MessageSink {
  readonly kind = 'memory' as const;
  private readonly messages: CanonicalMessage[] = [];
  private readonly attempts = new Map<string, MessageAttempt[]>();
  private readonly emitter = new EventEmitter();

  constructor(private readonly maxMessages = 2000) {}

  record(message: CanonicalMessage): void {
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }
    this.emitter.emit('message', message);
  }

  /** Newest first. */
  list(filter: MessageFilter = {}): CanonicalMessage[] {
    let out = this.messages;
    if (filter.deviceId) out = out.filter((m) => m.deviceId === filter.deviceId);
    if (filter.status) out = out.filter((m) => m.status === filter.status);
    if (filter.dlq) out = out.filter((m) => m.dlqAt !== undefined);
    const limit = filter.limit ?? 100;
    return [...out].reverse().slice(0, limit);
  }

  get(id: string): CanonicalMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  /** Advance the lifecycle: update status (+DLQ/duplicate markers) and append a timeline entry. */
  mark(id: string, status: MessageStatus, note?: string, fields?: MarkFields): void {
    const message = this.messages.find((m) => m.id === id);
    if (!message) return;
    message.status = status;
    if (fields?.dlqAt) message.dlqAt = fields.dlqAt;
    if (fields?.duplicateOf) message.duplicateOf = fields.duplicateOf;
    message.timeline.push({ stage: status, at: new Date().toISOString(), note });
  }

  recordAttempt(attempt: MessageAttempt): void {
    const list = this.attempts.get(attempt.messageId) ?? [];
    list.push(attempt);
    this.attempts.set(attempt.messageId, list);
  }

  attemptsFor(messageId: string): MessageAttempt[] {
    return this.attempts.get(messageId) ?? [];
  }

  subscribe(fn: (message: CanonicalMessage) => void): () => void {
    this.emitter.on('message', fn);
    return () => this.emitter.off('message', fn);
  }

  stats(): StoreStats {
    const today = new Date().toISOString().slice(0, 10);
    const byStatus: Record<string, number> = {};
    let todayCount = 0;
    let pending = 0;
    for (const m of this.messages) {
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
      if (m.receivedAt.startsWith(today)) todayCount++;
      if (PENDING_STATUSES.includes(m.status)) pending++;
    }
    return {
      total: this.messages.length,
      today: todayCount,
      failed: byStatus['FAILED'] ?? 0,
      pending,
      byStatus,
    };
  }
}