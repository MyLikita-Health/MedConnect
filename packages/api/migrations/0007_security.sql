-- 0007_security.sql — M2: API-key authn + audit log (plan F2/F4, PRD §30, §34).
-- Only SHA-256 hashes of key secrets are stored (prefix kept for display);
-- the plaintext secret is returned once at creation. Every mutating API
-- action is written to audit_log with actor/action/result.

CREATE TABLE IF NOT EXISTS api_keys (
  id           text PRIMARY KEY,            -- stable slug, e.g. 'admin'
  name         text NOT NULL,
  role         text NOT NULL CHECK (role IN ('admin', 'engineer', 'operator', 'viewer')),
  key_hash     text NOT NULL UNIQUE,        -- sha256(secret); secret never stored
  prefix       text NOT NULL,               -- first chars of the secret, for display
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  created_by   text
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          text PRIMARY KEY,
  seq         bigserial NOT NULL,            -- monotonic append order: ties on `at`
                                             -- (same-ms bursts) break deterministically
  at          timestamptz NOT NULL DEFAULT now(),
  actor_key   text,                          -- api key id when identified
  actor_name  text,
  actor_role  text,
  action      text NOT NULL,                 -- 'POST /api/v1/messages/:id/release'
  target      text,                          -- concrete id the action touched
  result      text NOT NULL CHECK (result IN ('ok', 'error', 'denied')),
  status_code integer,
  ip          text,
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC, seq DESC);
