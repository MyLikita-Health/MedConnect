-- 0010_hl7_destinations.sql — B3.2: HL7 v2 outbound destination kind.
-- Additive: an `hl7` destination carries its MLLP endpoint + MSH header
-- fields in this JSONB column; `kind` is already a free text column.
ALTER TABLE destinations ADD COLUMN IF NOT EXISTS hl7_config jsonb;