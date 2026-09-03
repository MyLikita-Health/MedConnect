/**
 * In-memory message store. For the MVP scaffold this replaces PostgreSQL +
 * Redis/BullMQ; the `MessageSink` contract is what the gateway sees, so a
 * durable store can be swapped in without touching the pipeline.
 */
import { EventEmitter } from 'node:events';
import type { CanonicalMessage, MessageSink } from '@integration-hub/shared';

export interface MessageFilter {
  deviceId?: string;
  status?: string;
  limit?: number;
}

export interface StoreStats {
  total: number;
  today: number;
  failed: number;
  pending: number;
  byStatus: Record<string, number>;
}

export class MessageStore implements MessageSink {
  private readonly messages: CanonicalMessage[] = [];
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
    const limit = filter.limit ?? 100;
    return [...out].reverse().slice(0, limit);
  }

  get(id: string): CanonicalMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  subscribe(fn: (message: CanonicalMessage) => void): () => void {
    this.emitter.on('message', fn);
    return () => this.emitter.off('message', fn);
  }

  stats(): StoreStats {
    const today = new Date().toISOString().slice(0, 10);
    const byStatus: Record<string, number> = {};
    let todayCount = 0;
    for (const m of this.messages) {
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
      if (m.receivedAt.startsWith(today)) todayCount++;
    }
    return {
      total: this.messages.length,
      today: todayCount,
      failed: byStatus['FAILED'] ?? 0,
      pending: byStatus['RECEIVED'] ?? 0,
      byStatus,
    };
  }
}