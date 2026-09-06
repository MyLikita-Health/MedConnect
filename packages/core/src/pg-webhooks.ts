/**
 * PostgreSQL-backed webhook-subscription store (D3, plan §7.D; PRD §37).
 *
 * Subscriptions survive hub restarts: startHub attaches this store to the
 * event bus, which loads subscriptions at boot (`EventBus.ready`) and writes
 * through on every add/update/remove. Rows are JSONB payloads — the full
 * subscription object (HMAC secret included; the REST layer never re-exposes
 * it). Reading back runs zod validation (the pg-profiles pattern) so a
 * corrupt row fails loudly instead of silently mis-parsing the delivery config.
 */
import type { Pool } from 'pg';
import {
  parseWebhookSubscription,
  type WebhookSubscription,
  type WebhookSubscriptionStore,
} from './event-bus.js';

interface SubscriptionRow {
  id: string;
  payload: unknown;
}

export class PostgresWebhookStore implements WebhookSubscriptionStore {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<WebhookSubscription[]> {
    const { rows } = await this.pool.query<SubscriptionRow>(
      `SELECT id, payload FROM webhook_subscriptions ORDER BY created_at`,
    );
    return rows.map((r) => parseWebhookSubscription(r.payload));
  }

  async upsert(subscription: WebhookSubscription): Promise<void> {
    // Validate on the way in too — only well-formed subscriptions persist.
    const parsed = parseWebhookSubscription(subscription);
    await this.pool.query(
      `INSERT INTO webhook_subscriptions (id, payload)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [parsed.id, JSON.stringify(parsed)],
    );
  }

  async remove(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM webhook_subscriptions WHERE id = $1`, [id]);
  }
}