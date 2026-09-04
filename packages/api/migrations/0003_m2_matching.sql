-- 0003_m2_matching.sql — M2: patient/order matching (plan E6, PRD §27).
-- Expected-order registry (the LIS seam: orders the LIS told us to expect) and
-- per-message matching outcome persisted alongside the lifecycle.

-- Expected orders: registered by the LIS interface (HL7 ORM / REST later);
-- incoming results are matched against these before delivery (never silently
-- auto-assigned — AMBIGUOUS/UNMATCHED/REJECTED go to the HELD review queue).
CREATE TABLE IF NOT EXISTS order_registry (
  id          text PRIMARY KEY,          -- order / accession id
  patient_id  text NOT NULL,
  sample_id   text,
  tests       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- canonical test codes
  status      text NOT NULL DEFAULT 'active',      -- active | completed | cancelled
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_registry_patient ON order_registry (patient_id);

-- Matching outcome on each message (MATCHED/UNMATCHED/AMBIGUOUS/REJECTED).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS match_status       text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS matched_order_id   text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS matched_patient_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS match_strategy     text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS match_at           timestamptz;
CREATE INDEX IF NOT EXISTS idx_messages_match ON messages (match_status) WHERE match_status IS NOT NULL;