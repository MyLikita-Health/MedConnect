/**
 * D3 slice 3 — webhook-subscriptions REST surface (workstream D / M4, plan
 * §7.D D3; PRD §37). Makes the event bus operable at runtime:
 *
 *   GET    /api/v1/webhooks                       → subscriptions (secret never re-sent)
 *   POST   /api/v1/webhooks                       → create (secret echoed exactly once)
 *   PATCH  /api/v1/webhooks/:id                   → update (name/url/events/enabled/retry, optional new secret)
 *   DELETE /api/v1/webhooks/:id                   → remove
 *   GET    /api/v1/webhooks/deliveries            → delivery log (newest first, ?limit=)
 *   POST   /api/v1/webhooks/deliveries/:eventId/replay → re-send failed deliveries of one event
 *   POST   /api/v1/webhooks/test                  → fire a synthetic event (endpoint wiring check)
 *
 * Mounted under /api/v1 so every route inherits key auth + the fail-closed
 * ROUTE_SCOPES table (reads are `api:read`, mutations `config:write`).
 *
 * Secret handling mirrors the API-key surface: the HMAC secret is submitted
 * at create (or generated when omitted) and returned exactly once — the
 * subscription list and delivery log never re-expose it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES, type EventBus, type WebhookEventType, type WebhookSubscription } from '@integration-hub/core';

const EVENT_TYPES = [...WEBHOOK_EVENT_TYPES] as [WebhookEventType, ...WebhookEventType[]];

const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoffMs: z.number().int().min(0).max(60000).default(1000),
  backoffFactor: z.number().min(1).max(10).default(2),
  jitter: z.boolean().default(false),
});

const eventsSchema = z.union([z.array(z.enum(EVENT_TYPES)).min(1), z.literal('*')]).default('*');

const createSubscriptionSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  name: z.string().min(1).max(200),
  url: z.string().url(),
  /** HMAC key shared with the receiver. Omitted → generated + echoed once. */
  secret: z.string().min(16).max(512).optional(),
  events: eventsSchema,
  enabled: z.boolean().default(true),
  retry: retrySchema.optional(),
});

const updateSubscriptionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  url: z.string().url().optional(),
  secret: z.string().min(16).max(512).optional(),
  events: eventsSchema.optional(),
  enabled: z.boolean().optional(),
  retry: retrySchema.optional(),
});

const listDeliveriesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const testSchema = z.object({
  /** Event type to fire (default result.received — the most common one). */
  type: z.enum(EVENT_TYPES).default('result.received'),
  /** Optional extra data merged into the test envelope. */
  data: z.record(z.string(), z.unknown()).optional(),
});

/** Subscription DTOs never carry the secret back to the client. */
function toDto(sub: WebhookSubscription): Omit<WebhookSubscription, 'secret'> {
  const { secret: _secret, ...rest } = sub;
  return rest;
}

export function registerWebhookRoutes(app: FastifyInstance, opts: { bus?: EventBus }): void {
  const bus = opts.bus;
  const missing = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(404).send({ error: 'webhook event bus not configured (the hub wires it on boot)' });

  app.get('/api/v1/webhooks', async (_req, reply) => {
    if (!bus) return missing(reply);
    return bus.listSubscriptions().map(toDto);
  });

  app.post('/api/v1/webhooks', async (req, reply) => {
    if (!bus) return missing(reply);
    const input = createSubscriptionSchema.parse(req.body);
    const secret = input.secret ?? randomBytes(24).toString('hex');
    const sub: WebhookSubscription = {
      id: input.id ?? `wh-${randomUUID()}`,
      name: input.name,
      url: input.url,
      secret,
      events: input.events,
      enabled: input.enabled,
      retry: input.retry,
      createdAt: new Date().toISOString(),
    };
    bus.addSubscription(sub);
    // The secret is returned exactly once, at create (like API keys).
    return reply.code(201).send(sub);
  });

  app.patch('/api/v1/webhooks/:id', async (req, reply) => {
    if (!bus) return missing(reply);
    const { id } = req.params as { id: string };
    const patch = updateSubscriptionSchema.parse(req.body);
    const existing = bus.listSubscriptions().find((s) => s.id === id);
    if (!existing) return reply.code(404).send({ error: 'webhook subscription not found' });
    const updated: WebhookSubscription = {
      ...existing,
      ...patch,
      // A secret is only ever replaced when a new one is submitted.
      secret: patch.secret ?? existing.secret,
    };
    bus.addSubscription(updated);
    return reply.code(200).send(toDto(updated));
  });

  app.delete('/api/v1/webhooks/:id', async (req, reply) => {
    if (!bus) return missing(reply);
    const { id } = req.params as { id: string };
    if (!bus.removeSubscription(id)) return reply.code(404).send({ error: 'webhook subscription not found' });
    return reply.code(204).send();
  });

  app.get('/api/v1/webhooks/deliveries', async (req, reply) => {
    if (!bus) return missing(reply);
    const { limit } = listDeliveriesSchema.parse(req.query);
    return bus.listDeliveries().slice(0, limit);
  });

  app.post('/api/v1/webhooks/deliveries/:eventId/replay', async (req, reply) => {
    if (!bus) return missing(reply);
    const { eventId } = req.params as { eventId: string };
    const attempted = await bus.replay(eventId);
    if (attempted === 0) return reply.code(404).send({ error: 'no failed deliveries retained for this event' });
    return reply.code(200).send({ ok: true, eventId, attempted });
  });

  // Endpoint wiring check: fires a synthetic domain event through the real
  // bus — the operator sees the signed POST land (or fail) in the delivery log.
  app.post('/api/v1/webhooks/test', async (req, reply) => {
    if (!bus) return missing(reply);
    const { type, data } = testSchema.parse(req.body);
    const fired = await bus.fire({
      type,
      source: 'hub:console-test',
      data: { note: 'test ping from the webhooks console', at: new Date().toISOString(), ...(data ?? {}) },
    });
    const note = fired.matched === 0 ? 'no enabled subscription matches this event type' : undefined;
    return reply.code(201).send({ ok: true, id: fired.id, matched: fired.matched, ...(note ? { note } : {}) });
  });
}