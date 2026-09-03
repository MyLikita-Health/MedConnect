/**
 * Duplicate detection (PRD §29, plan §5.3 DUPLICATE state).
 *
 * The dedup key is a SHA-256 of protocol + device + raw wire text, so a device
 * resending the same result (e.g. after a reconnect that lost the ACK) is
 * recognized within the retention window. Replays deliberately bypass dedup
 * because they produce a fresh message id with identical raw text — see
 * Dispatcher.record and gateway.replay.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { CanonicalMessage } from '@integration-hub/shared';

export interface DedupStore {
  /** Message id previously recorded for this key, or undefined if new. */
  find(key: string): Promise<string | undefined>;
  /** Record the key → message association for the given TTL. */
  add(key: string, messageId: string, ttlMs: number): Promise<void>;
}

export function dedupKey(message: CanonicalMessage): string {
  return createHash('sha256')
    .update(`${message.protocol}\u0000${message.deviceId ?? ''}\u0000${message.raw}`)
    .digest('hex');
}

export class InMemoryDedupStore implements DedupStore {
  private readonly keys = new Map<string, { messageId: string; expiresAt: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  async find(key: string): Promise<string | undefined> {
    const now = this.clock();
    const entry = this.keys.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.keys.delete(key);
      return undefined;
    }
    return entry.messageId;
  }

  async add(key: string, messageId: string, ttlMs: number): Promise<void> {
    this.keys.set(key, { messageId, expiresAt: this.clock() + ttlMs });
  }

  /** Test helper. */
  size(): number {
    return this.keys.size;
  }
}

export class PostgresDedupStore implements DedupStore {
  constructor(private readonly pool: Pool) {}

  async find(key: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ message_id: string }>(
      `SELECT message_id FROM dedup_keys WHERE key = $1 AND expires_at > now()`,
      [key],
    );
    return rows[0]?.message_id;
  }

  async add(key: string, messageId: string, ttlMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO dedup_keys (key, message_id, expires_at)
       VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE SET message_id = EXCLUDED.message_id, expires_at = EXCLUDED.expires_at`,
      [key, messageId, Math.max(ttlMs, 1000)],
    );
  }
}