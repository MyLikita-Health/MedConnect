/**
 * Patient/order matching (PRD §27; plan workstream E6).
 *
 * Safety-critical: results must never be silently assigned to the wrong
 * patient/order. The engine tries configured key strategies against the order
 * registry (the LIS seam — the registry holds orders the LIS told us to
 * expect). Outcomes:
 *
 *   MATCHED   — exactly one active registry order satisfies a strategy
 *   AMBIGUOUS — more than one candidate → held for operator review
 *   REJECTED  — a matching order exists but is cancelled → held
 *   UNMATCHED — no strategy hit → held (no silent auto-assign)
 */
import type { CanonicalMessage, MessageMatch } from '@integration-hub/shared';

export type OrderStatus = 'active' | 'completed' | 'cancelled';

/** An order the LIS has told the hub to expect (the LIS interface seam). */
export interface ExpectedOrder {
  /** Order / accession id. */
  id: string;
  patientId: string;
  sampleId?: string;
  /** Canonical test codes requested on the order. */
  tests: string[];
  status: OrderStatus;
  receivedAt: string; // ISO timestamp
}

export interface OrderQuery {
  patientId: string;
  orderId?: string;
  sampleId?: string;
}

/**
 * Registry of expected orders. Implementations may be synchronous (in-memory)
 * or asynchronous (PostgreSQL) — the engine awaits everything.
 */
export interface OrderRegistry {
  /** Candidates matching the query; engine applies strategy filtering on top. */
  find(query: OrderQuery): ExpectedOrder[] | Promise<ExpectedOrder[]>;
  register(order: ExpectedOrder): void | Promise<void>;
  remove(id: string): void | Promise<void>;
  list(): ExpectedOrder[] | Promise<ExpectedOrder[]>;
}

export type MatchKey = 'patientId' | 'orderId' | 'sampleId';

export interface MatchingConfig {
  /**
   * Key sets tried in order; the first set that resolves to exactly one
   * active candidate wins (PRD §27 example: patient id + order id, then
   * patient id + accession/sample id).
   */
  strategies: MatchKey[][];
  /** How UNMATCHED/AMBIGUOUS messages are handled. 'hold' is the safe default. */
  onUnmatched: 'hold' | 'deliver';
}

export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
  strategies: [
    ['patientId', 'orderId'],
    ['patientId', 'sampleId'],
  ],
  onUnmatched: 'hold',
};

export interface MatchOutcome {
  status: MessageMatch['status'];
  matchedOrderId?: string;
  matchedPatientId?: string;
  strategy?: string;
  reason?: string;
  at: string;
}

export class InMemoryOrderRegistry implements OrderRegistry {
  private readonly orders = new Map<string, ExpectedOrder>();

  async find(query: OrderQuery): Promise<ExpectedOrder[]> {
    return [...this.orders.values()].filter((o) => {
      if (o.patientId !== query.patientId) return false;
      if (query.orderId && o.id !== query.orderId) return false;
      if (query.sampleId && o.sampleId !== query.sampleId) return false;
      return true;
    });
  }

  async register(order: ExpectedOrder): Promise<void> {
    this.orders.set(order.id, order);
  }

  async remove(id: string): Promise<void> {
    this.orders.delete(id);
  }

  async list(): Promise<ExpectedOrder[]> {
    return [...this.orders.values()];
  }
}

/**
 * Match an incoming message against the order registry using the configured
 * strategies. Returns a MATCHED outcome on a unique hit, otherwise a hold
 * outcome (UNMATCHED / AMBIGUOUS / REJECTED) — never a silent assignment.
 */
export async function matchMessage(
  message: CanonicalMessage,
  registry: OrderRegistry,
  config: MatchingConfig = DEFAULT_MATCHING_CONFIG,
): Promise<MatchOutcome> {
  const payload = message.payload;
  if (!payload) {
    return { status: 'UNMATCHED', reason: 'no canonical payload to match', at: iso() };
  }

  const { patient, order } = payload;

  for (const keys of config.strategies) {
    // Scope the registry query to the keys this strategy needs, so e.g. the
    // [patientId, sampleId] fallback is not pre-filtered by an unmatched order id.
    const query: OrderQuery = { patientId: patient.id };
    if (keys.includes('orderId')) query.orderId = order.id;
    if (keys.includes('sampleId')) query.sampleId = order.sampleId;

    const candidates = await registry.find(query);
    const active = candidates.filter((o) => o.status === 'active');

    // A matching cancelled order means the result should never be delivered.
    const cancelled = candidates.find((o) => o.status === 'cancelled');
    if (cancelled) {
      return {
        status: 'REJECTED',
        matchedOrderId: cancelled.id,
        matchedPatientId: cancelled.patientId,
        reason: `order ${cancelled.id} is cancelled`,
        at: iso(),
      };
    }

    const matched = active.filter((o) => matchesKeys(o, keys, query));
    if (matched.length === 1) {
      const hit = matched[0]!;
      return {
        status: 'MATCHED',
        matchedOrderId: hit.id,
        matchedPatientId: hit.patientId,
        strategy: keys.join('+'),
        at: iso(),
      };
    }
    if (matched.length > 1) {
      return {
        status: 'AMBIGUOUS',
        reason: `${matched.length} orders match strategy ${keys.join('+')} — held for review`,
        at: iso(),
      };
    }
  }

  return { status: 'UNMATCHED', reason: 'no registered order matched', at: iso() };
}

/** True when the order satisfies every key of the strategy. */
function matchesKeys(order: ExpectedOrder, keys: MatchKey[], query: OrderQuery): boolean {
  return keys.every((key) => {
    switch (key) {
      case 'patientId':
        return order.patientId === query.patientId;
      case 'orderId':
        return order.id === query.orderId;
      case 'sampleId':
        return order.sampleId !== undefined && order.sampleId === query.sampleId;
    }
  });
}

export function matchToMessageMatch(outcome: MatchOutcome): MessageMatch {
  return {
    status: outcome.status,
    matchedOrderId: outcome.matchedOrderId,
    matchedPatientId: outcome.matchedPatientId,
    strategy: outcome.strategy,
    reason: outcome.reason,
    at: outcome.at,
  };
}

function iso(): string {
  return new Date().toISOString();
}