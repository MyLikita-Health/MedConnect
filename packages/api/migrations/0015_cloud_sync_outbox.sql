-- 0015_cloud_sync_outbox.sql — D11 edge→cloud sync substrate (plan §7.G G4;
-- decision D11 resolved: the edge outbox IS the cloud sync outbox).
--
-- Two roles, two tables, one migration (the same migrations run on both sides;
-- each deployment only fills the table matching its role):
--
-- outbox (EDGE): every tenant-scoped local write (messages, devices) appends a
--   row in the SAME transaction (write-through). The OutboxSyncer reads unacked
--   rows in seq order and ships them to the cloud ingest endpoint over the
--   outbound-only secure channel (PRD §42); the cloud acks per batch and the
--   edge marks rows acked on success. seq is the per-edge monotonic cursor.
--
-- ingest_ledger (CLOUD): applies shipped batches. PK (facility_id, seq) makes
--   the apply idempotent — a redelivered batch (edge crashed between cloud-
--   write and edge-ack) inserts ON CONFLICT DO NOTHING and the ack stays
--   truthful. facility_id + seq come from the shipping gateway (each edge's
--   seq starts at 1, so the pair — not seq alone — is the dedup key).

-- ---------------------------------------------------------------------------
-- EDGE — sync outbox
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox (
  seq         bigserial PRIMARY KEY,
  table_name  text        NOT NULL,
  op          text        NOT NULL,
  pk          text        NOT NULL,
  payload     jsonb       NOT NULL,
  org_id      text,
  facility_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  acked       boolean     NOT NULL DEFAULT false,
  acked_at    timestamptz
);

-- FIFO claim order (unacked first, oldest first).
CREATE INDEX IF NOT EXISTS idx_outbox_unacked ON outbox (seq) WHERE acked = false;

-- ---------------------------------------------------------------------------
-- CLOUD — ingest ledger (idempotent apply per (facility, edge-seq) pair)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_ledger (
  facility_id text        NOT NULL,
  seq         bigint      NOT NULL,
  table_name  text        NOT NULL,
  op          text        NOT NULL,
  pk          text        NOT NULL,
  payload     jsonb       NOT NULL,
  org_id      text,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (facility_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_ingest_ledger_facility_applied
  ON ingest_ledger (facility_id, applied_at DESC);
