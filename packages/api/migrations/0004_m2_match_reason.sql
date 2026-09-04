-- 0004_m2_match_reason.sql — persist the matching reason (M2, PRD §27).
-- Kept separate from 0003 so the operator-facing reason (e.g. "order X is
-- cancelled") survives on stored messages exactly like in-memory matches do.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS match_reason text;