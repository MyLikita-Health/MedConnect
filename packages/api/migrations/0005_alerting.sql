-- 0005_alerting.sql — M2: alerting (plan workstream I; PRD §33).
-- Alert rules are config; `alerts` rows are derived fire/resolve history.
-- A rule fires per subject at most once until resolved (see core/alerts.ts).

CREATE TABLE IF NOT EXISTS alert_rules (
  id          text PRIMARY KEY,
  kind        text NOT NULL,            -- device-offline | destination-down | dlq | held-backlog
  name        text NOT NULL,
  subject     text,                     -- device/destination id; NULL = any subject
  threshold   integer NOT NULL DEFAULT 1,
  cooldown_ms integer,
  channels    jsonb NOT NULL DEFAULT '["console"]'::jsonb,
  webhook_url text,
  enabled     boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS alerts (
  id          text PRIMARY KEY,
  rule_id     text NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
  kind        text NOT NULL,
  subject     text,
  message     text NOT NULL,
  status      text NOT NULL,            -- FIRING | RESOLVED
  count       integer NOT NULL DEFAULT 1,
  fired_at    timestamptz NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts (rule_id, subject, status) WHERE status = 'FIRING';