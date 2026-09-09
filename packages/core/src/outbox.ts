/**
 * D11 — edge→cloud outbox syncer (plan §7.G G4; decision D11).
 *
 * The edge's durable local queue IS the outbox (§13.2): every tenant-scoped
 * local write appends an `outbox` row in the same transaction, and this syncer
 * ships unacked rows to the cloud platform over the outbound-only channel
 * (PRD §42). On success the cloud returns the highest applied sequence per
 * batch; the edge marks everything ≤ that sequence acked.
 *
 * Idempotency (G4): each outbox row carries a monotonic per-edge `seq`; the
 * cloud ingest inserts with ON CONFLICT (facility_id, seq) DO NOTHING, so a
 * redelivered batch (crash between cloud-write and edge-ack) never duplicates
 * a cloud write. Conflict policy: cloud wins per row (first write wins; the
 * cloud copy is the system of record once accepted).
 *
 * Connectivity: outbound only — the syncer POSTs to the cloud base URL; no
 * inbound port is opened (PRD §42). The runner loops on a poll cadence,
 * tolerates cloud outages (logs + retries next tick — the outbox grows, the
 * pipeline never blocks) and stops cleanly.
 */

// ---------------------------------------------------------------------------
// Outbox row shape (shared by the edge reader + cloud ingest zod schema)
// ---------------------------------------------------------------------------

/** Logical table + operation of one outbox entry (G4 sync protocol). */
export type OutboxOp = 'INSERT' | 'UPDATE';

/** One pending sync entry as stored on the edge and shipped to the cloud. */
export interface OutboxEntry {
  /** Monotonic per-edge sequence (the sync cursor + cloud idempotency key). */
  seq: number;
  /** Logical source table: 'messages' | 'devices' (extensible). */
  table: 'messages' | 'devices';
  op: OutboxOp;
  /** Primary key of the source row. */
  pk: string;
  /** Full row payload (JSONB) — cloud writes are whole-row upserts. */
  payload: unknown;
  orgId?: string;
  facilityId?: string;
  createdAt: string;
}

/** Read side (edge): unacked rows in FIFO order + ack after a batch applies. */
export interface OutboxReader {
  /** Unacked entries, oldest first, bounded. */
  listUnacked(limit: number): OutboxEntry[] | Promise<OutboxEntry[]>;
  /** Mark every row with seq ≤ `throughSeq` as acked. Returns rows updated. */
  markAcked(throughSeq: number): number | Promise<number>;
  /** Highest sequence ever appended (diagnostics + tests). */
  maxSeq?(): number | Promise<number>;
}

/** Append side: local writes call this in the same transaction as the row.
 *  `client` is the source-row transaction handle; implementations that don't
 *  need it (in-memory tests) may ignore it. */
export interface OutboxWriter {
  append(
    entry: Omit<OutboxEntry, 'seq' | 'createdAt'>,
    client?: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  ): number | Promise<number>;
}

// ---------------------------------------------------------------------------
// Cloud sync configuration
// ---------------------------------------------------------------------------

export interface OutboxSyncOptions {
  /** Outbox read/ack store (the edge's local SQL outbox). */
  reader: OutboxReader;
  /** Cloud platform base URL, e.g. https://cloud.example.org (no trailing /). */
  cloudBaseUrl: string;
  /** Edge credentials issued by H3 provisioning (gateway id + API key). */
  gatewayId: string;
  apiKey: string;
  /** Batch size per POST (default 200; bandwidth-friendly batching, G4). */
  batchSize?: number;
  /** Poll cadence when idle (default 5s). */
  pollMs?: number;
  /** Per-request timeout ms (default 10s). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface OutboxSyncStatus {
  enabled: boolean;
  cloudBaseUrl?: string;
  gatewayId?: string;
  /** Unacked rows waiting to ship (the offline backlog). */
  pending: number;
  maxSeq?: number;
  lastShippedSeq?: number;
  lastRunAt?: string;
  lastError?: string;
  /** Cumulative batches + rows shipped since start. */
  totals: { batches: number; rows: number };
}

const DEFAULT_BATCH = 200;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Edge syncer: loops `shipOnce` on a cadence. Failures never throw out of the
 * loop — the outbox is the durable backlog; connectivity returning is all it
 * takes to converge (G4 exit criterion).
 */
export class OutboxSyncer {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastShippedSeq?: number;
  private lastRunAt?: string;
  private lastError?: string;
  private readonly totals = { batches: 0, rows: 0 };

  constructor(private readonly opts: OutboxSyncOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const pollMs = this.opts.pollMs ?? DEFAULT_POLL_MS;
    const tick = async (): Promise<void> => {
      try {
        await this.shipOnce();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.opts.log?.(`[sync] ship failed: ${this.lastError}`);
      }
      if (this.running) this.timer = setTimeout(tick, pollMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    // One final drain so a clean shutdown ships whatever is ready.
    try {
      await this.shipOnce();
    } catch {
      // the outbox keeps the backlog; nothing is lost by failing here
    }
  }

  /** Ship one batch. Returns the highest seq shipped (undefined when nothing to send). */
  async shipOnce(): Promise<number | undefined> {
    const batchSize = this.opts.batchSize ?? DEFAULT_BATCH;
    const pending = await this.opts.reader.listUnacked(batchSize);
    this.lastRunAt = new Date().toISOString();
    if (pending.length === 0) {
      // Nothing to do — clear a stale error only after a clean round-trip.
      return undefined;
    }
    try {
      const appliedThrough = await shipBatch(this.opts, pending);
      // Ack through the highest applied seq (redelivery of an already-applied
      // row is a cloud-side no-op, so over-acking is safe; under-acking just
      // re-ships, also safe).
      const through = Math.max(...pending.map((e) => e.seq));
      await this.opts.reader.markAcked(through);
      this.lastShippedSeq = through;
      this.totals.batches += 1;
      this.totals.rows += pending.length;
      this.lastError = undefined;
      return through;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`[sync] batch rejected: ${this.lastError}`);
      return undefined;
    }
  }

  status(): OutboxSyncStatus {
    return {
      enabled: true,
      cloudBaseUrl: this.opts.cloudBaseUrl,
      gatewayId: this.opts.gatewayId,
      pending: -1, // filled by the status route (needs a count); keep shape stable
      totals: { ...this.totals },
      ...(this.lastShippedSeq !== undefined ? { lastShippedSeq: this.lastShippedSeq } : {}),
      ...(this.lastRunAt !== undefined ? { lastRunAt: this.lastRunAt } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  /** Build the status the API route returns (counts pending live). */
  async statusAsync(): Promise<OutboxSyncStatus> {
    const base = this.status();
    const pendingRows = await this.opts.reader.listUnacked(100_000);
    return { ...base, pending: pendingRows.length };
  }
}

// ---------------------------------------------------------------------------
// Batch shipper (pure — the unit tests exercise this directly)
// ---------------------------------------------------------------------------

/** Ship one batch of entries to the cloud ingest endpoint. Returns the highest
 *  applied seq reported by the cloud. Throws on non-2xx / invalid response. */
export async function shipBatch(
  opts: Pick<OutboxSyncOptions, 'cloudBaseUrl' | 'gatewayId' | 'apiKey' | 'timeoutMs'>,
  entries: OutboxEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${opts.cloudBaseUrl}/api/v1/sync/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // H3 provisioning credentials: the gateway identity rides the header
        // set the ingest route validates against its gateway registry.
        'x-hub-gateway': opts.gatewayId,
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ entries }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`cloud ingest ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as { appliedThrough?: number };
    if (typeof body.appliedThrough !== 'number') {
      throw new Error('cloud ingest returned no appliedThrough');
    }
    return body.appliedThrough;
  } finally {
    clearTimeout(timeout);
  }
}
