/**
 * PostgreSQL-backed expected-order registry (the LIS seam behind matching, E6).
 * Stores orders the LIS has told the hub to expect so incoming results can be
 * safely associated (PRD §27) — same contract as `InMemoryOrderRegistry`.
 */
import type { Pool } from 'pg';
import type { ExpectedOrder, OrderQuery, OrderRegistry } from './matching.js';

interface OrderRow {
  id: string;
  patient_id: string;
  sample_id: string | null;
  tests: unknown;
  status: string;
  created_at: Date | string;
}

export class PostgresOrderRegistry implements OrderRegistry {
  constructor(private readonly pool: Pool) {}

  async find(query: OrderQuery): Promise<ExpectedOrder[]> {
    const clauses: string[] = ['patient_id = $1'];
    const params: unknown[] = [query.patientId];
    if (query.orderId) {
      params.push(query.orderId);
      clauses.push(`id = $${params.length}`);
    }
    if (query.sampleId) {
      params.push(query.sampleId);
      clauses.push(`sample_id = $${params.length}`);
    }
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT id, patient_id, sample_id, tests, status, created_at
       FROM order_registry WHERE ${clauses.join(' AND ')}`,
      params,
    );
    return rows.map(rowToOrder);
  }

  async register(order: ExpectedOrder): Promise<void> {
    await this.pool.query(
      `INSERT INTO order_registry (id, patient_id, sample_id, tests, status)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET
         patient_id = EXCLUDED.patient_id,
         sample_id = EXCLUDED.sample_id,
         tests = EXCLUDED.tests,
         status = EXCLUDED.status,
         updated_at = now()`,
      [order.id, order.patientId, order.sampleId ?? null, JSON.stringify(order.tests), order.status],
    );
  }

  async remove(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM order_registry WHERE id = $1`, [id]);
  }

  async list(): Promise<ExpectedOrder[]> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT id, patient_id, sample_id, tests, status, created_at
       FROM order_registry ORDER BY created_at DESC`,
    );
    return rows.map(rowToOrder);
  }
}

function rowToOrder(row: OrderRow): ExpectedOrder {
  return {
    id: row.id,
    patientId: row.patient_id,
    sampleId: row.sample_id ?? undefined,
    tests: (row.tests as string[]) ?? [],
    status: row.status as ExpectedOrder['status'],
    // created_at is when the LIS registered the expected order.
    receivedAt: new Date(row.created_at).toISOString(),
  };
}