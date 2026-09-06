-- D3 webhook event bus — durable subscriptions (plan §7.D D3; PRD §37).
-- Subscriptions survive hub restarts: the bus loads them at boot
-- (EventBus.ready) and writes through on every add/update/remove.
-- `payload` is the full subscription JSONB (HMAC secret included — the REST
-- layer never re-exposes it); reading back runs zod validation so a corrupt
-- row fails loudly instead of mis-parsing the delivery config.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id         TEXT PRIMARY KEY,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);