-- 0009_key_rotation.sql — key-rotation ergonomics: expiry + per-secret issue
-- tracking so the re-issue flow can warn when a secret was never seen.
-- name/enabled already exist on api_keys (rename + disable need no schema).

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;
-- When the current secret was issued (set at create and on rotate). Compared
-- with last_used_at: a key whose secret was never presented since issue is a
-- "never seen" key — rotating it warrants a warning.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS secret_issued_at timestamptz NOT NULL DEFAULT now();
