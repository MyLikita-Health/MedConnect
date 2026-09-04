-- 0012_imaging_messages.sql — M3.3: imaging study events on messages.
-- The envelope's `imaging` field (performed-study metadata + storage URLs;
-- pixels never enter the hub) rides in its own jsonb column like payload —
-- without it, imaging messages recorded through the PG store would lose the
-- study event on write and read.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS imaging jsonb;
