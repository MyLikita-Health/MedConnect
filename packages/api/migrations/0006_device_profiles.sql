-- 0006_device_profiles.sql — M2: config-first device profiles (plan §6.3, A2).
-- One row per profile slug; the whole validated profile is the payload JSONB
-- (versioned inside it). Manufacturers/models are denormalized for admin UI
-- listing; certified profiles carry certified_at.

CREATE TABLE IF NOT EXISTS device_profiles (
  id            text PRIMARY KEY,           -- profile slug, e.g. 'acme-chem-200'
  version       integer NOT NULL DEFAULT 1,
  manufacturer  text NOT NULL,
  model         text NOT NULL,
  protocol      text NOT NULL DEFAULT 'ASTM',
  transport     text NOT NULL DEFAULT 'tcp',
  status        text NOT NULL DEFAULT 'draft',  -- draft | certified
  certified_at  timestamptz,
  payload       jsonb NOT NULL,             -- full validated DeviceProfile
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_profiles_manufacturer ON device_profiles (manufacturer, model);