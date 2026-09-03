-- 0001_init.sql — M0 foundations: Phase-1 entity groups (plan §5.1).
--
-- Tenancy scaffolding: org_id / facility_id columns are nullable and unused on
-- edge (single-facility) deployments; the cloud platform (M4) fills them and
-- adds Postgres RLS policies at that point (§5.2). No RLS policies are created
-- here because default-deny policies would break single-tenant edge mode.

-- Devices (plan §5.1 Devices group; PRD §11, §32)
CREATE TABLE IF NOT EXISTS devices (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  manufacturer    text,
  model           text,
  protocol        text NOT NULL DEFAULT 'ASTM',
  transport       text NOT NULL DEFAULT 'tcp',
  host            text,
  port            integer,
  state           text NOT NULL DEFAULT 'unknown',
  last_seen       timestamptz,
  auto_registered boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  org_id          text,
  facility_id     text
);
CREATE INDEX IF NOT EXISTS idx_devices_facility ON devices (facility_id);

-- Messages (plan §5.1 Messages group; PRD §24 Message Viewer).
-- Append-mostly; raw + parsed kept for the viewer and retention (PRD §44).
-- records/payload/timeline/errors are JSONB (plan §5.2).
CREATE TABLE IF NOT EXISTS messages (
  id          uuid PRIMARY KEY,
  protocol    text NOT NULL,
  direction   text NOT NULL,
  device_id   text,
  received_at timestamptz NOT NULL,
  raw         text NOT NULL,
  records     jsonb,
  payload     jsonb,
  status      text NOT NULL,
  errors      jsonb NOT NULL DEFAULT '[]'::jsonb,
  timeline    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  org_id      text,
  facility_id text
);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_device   ON messages (device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_status   ON messages (status);

-- Canonical clinical entities (plan §5.1 Clinical group; PRD §16).
-- Keyed by the identifiers as provided; patient matching/dedup is workstream E6.
CREATE TABLE IF NOT EXISTS patients (
  id            text PRIMARY KEY,
  name          text,
  date_of_birth text,
  gender        text,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id          text PRIMARY KEY,
  patient_id  text REFERENCES patients (id) ON DELETE CASCADE,
  sample_id   text,
  tests       jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_id  uuid,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_patient ON orders (patient_id);

CREATE TABLE IF NOT EXISTS results (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           text REFERENCES orders (id) ON DELETE CASCADE,
  message_id         uuid,
  test_code          text NOT NULL,
  original_test_code text,
  test_name          text,
  value              text NOT NULL,
  unit               text,
  reference_range    text,
  flag               text,
  status             text,
  measured_at        timestamptz,
  received_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_results_order ON results (order_id);

-- Mapping tables (plan §5.1 Mapping group; PRD §17–18).
-- device_id NULL = facility/global default; a non-null device_id overrides it.
-- NULLS NOT DISTINCT (PG 15+) lets multiple global rows share device_id NULL.
CREATE TABLE IF NOT EXISTS test_mappings (
  device_id      text,
  device_code    text NOT NULL,
  canonical_code text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_test_mappings_device_code
  ON test_mappings (device_id, device_code) NULLS NOT DISTINCT;