-- 0002_m1_lifecycle.sql — M1: durable delivery core (plan §5.3 lifecycle, E3).
-- Dead-letter queue markers, delivery destinations + route rules (§5.1
-- Routing group), per-attempt history (Messages group), and dedup keys (§29).

ALTER TABLE messages ADD COLUMN IF NOT EXISTS dlq_at      timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS duplicate_of uuid;
CREATE INDEX IF NOT EXISTS idx_messages_dlq ON messages (dlq_at) WHERE dlq_at IS NOT NULL;

-- Outbound delivery destinations. kind = 'console' is built-in (not stored);
-- rows here are user-registered destinations (HTTP endpoints in M1).
CREATE TABLE IF NOT EXISTS destinations (
  id           text PRIMARY KEY,
  kind         text NOT NULL DEFAULT 'http',
  name         text NOT NULL,
  url          text,
  enabled      boolean NOT NULL DEFAULT true,
  retry_policy jsonb NOT NULL DEFAULT '{"maxAttempts":3,"backoffMs":250,"backoffFactor":2,"jitter":true}'
);

-- Route rules: match by device and/or status; lower priority number wins.
CREATE TABLE IF NOT EXISTS route_rules (
  id             text PRIMARY KEY,
  destination_id text NOT NULL REFERENCES destinations (id) ON DELETE CASCADE,
  device_id      text,
  status         text,
  priority       integer NOT NULL DEFAULT 100,
  enabled        boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_route_rules_destination ON route_rules (destination_id);

-- One row per delivery attempt (retry history, plan §5.1 MessageAttempt).
CREATE TABLE IF NOT EXISTS message_attempts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id     uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  destination_id text NOT NULL,
  attempt        integer NOT NULL,
  status         text NOT NULL,
  error          text,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_attempts_message ON message_attempts (message_id);

-- Duplicate-detection window (PRD §29): key = sha256(protocol|device|raw).
CREATE TABLE IF NOT EXISTS dedup_keys (
  key        text PRIMARY KEY,
  message_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedup_keys_expires ON dedup_keys (expires_at);