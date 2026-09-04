/**
 * Inbound ORM^O01 → expected-order translator (workstream B2c — the LIS
 * seam). ORM messages carry lab orders, not results: they have no canonical
 * `LabPayload` target, so (per the plan §13.15 decision) they are translated
 * directly into the **OrderRegistry** — the same registry the matching engine
 * (E6) reads, today hand-filled via `POST /api/v1/orders`. Feeding it from
 * the LIS wire closes the seam.
 *
 * Extracted shape (pure — no `@integration-hub/core` import):
 *
 *   ORC-1 action → status     (NW/RO/... → active · CA → cancelled ·
 *                              CM/OC → completed · anything else → active)
 *   ORC-3 filler (else ORC-2 placer, else OBR-3/OBR-2) → order id
 *   PID-3 → patientId · SPM-2 → sampleId (best-effort v1)
 *   OBR-4 requested tests (all OBR rows, deduped) → tests, mapped through
 *   the mappings table like the results translator (canonical codes)
 *
 * Failure follows the pipeline rule — never silently dropped: any issue
 * returns `null` + the reasons (the gateway ACKs AR, so the LIS knows).
 */
import { HL7Message as Parse, type HL7Message, type HL7Segment } from 'hl7v2';
import type { MappingTable } from '@integration-hub/shared';

export type OrderStatus = 'active' | 'completed' | 'cancelled';

/** The order shape the registry seam accepts (mirrors core's ExpectedOrder). */
export interface OrderRegistration {
  id: string;
  patientId: string;
  sampleId?: string;
  /** Canonical test codes requested on the order. */
  tests: string[];
  status: OrderStatus;
  receivedAt?: string;
}

export interface Hl7OrderResult {
  /** The registered order, or null when the message cannot be translated. */
  order: OrderRegistration | null;
  issues: string[];
}

export interface Hl7ToOrderOptions {
  /** Analyzer/LIS test-code → canonical mappings (PRD §17–18); empty = pass-through. */
  mappings?: MappingTable;
}

/** Translate an ORM^O01 (raw wire text or already parsed) to an expected order. */
export function hl7ToOrder(message: string | HL7Message, opts: Hl7ToOrderOptions = {}): Hl7OrderResult {
  const parsed = typeof message === 'string' ? Parse.parse(message) : message;
  const issues: string[] = [];

  const type = parsed.messageType;
  if (!type.startsWith('ORM^')) {
    return { order: null, issues: [`unsupported message type ${type || '(unknown)'}: only ORM^O01 orders are translated (v1)`] };
  }

  const pid = parsed.getSegment('PID');
  const patientId = pid ? comp(pid, 3, 1) ?? '' : '';
  if (!patientId) issues.push('Missing patient identifier');

  const orc = parsed.getSegment('ORC');
  const obrs = parsed.segments.filter((s) => s.segmentType === 'OBR');
  if (!orc && obrs.length === 0) issues.push('Missing order segments (need ORC or OBR)');

  let orderId = orc ? eiId(orc, 3) ?? eiId(orc, 2) : undefined;
  if (!orderId) {
    for (const o of obrs) {
      const id = eiId(o, 3) ?? eiId(o, 2);
      if (id) {
        orderId = id;
        break;
      }
    }
  }
  if (!orderId) issues.push('Missing order identifier');

  // Requested tests from every OBR row (an ORM legitimately carries several).
  const tests = [...new Set(obrs.map((o) => ceId(o, 4)).filter((c): c is string => c !== undefined && c.length > 0))];
  if (tests.length === 0) issues.push('No requested tests (OBR-4)');

  if (!patientId || !orderId || issues.length > 0) return { order: null, issues };

  const mappings = opts.mappings ?? {};
  const mappedTests = tests.map((t) => {
    const mapped = mappings[t] ?? mappings[t.toUpperCase()];
    return mapped ?? t;
  });

  const status = orc ? orderStatus(comp(orc, 1)) : 'active';
  const sampleId = parsed.getSegment('SPM') ? comp(parsed.getSegment('SPM')!, 2, 1) ?? undefined : undefined;

  return {
    order: {
      id: orderId,
      patientId,
      ...(sampleId ? { sampleId } : {}),
      tests: mappedTests,
      status,
    },
    issues,
  };
}

/** ORC-1 action code → registry status. Unknown actions default to active. */
function orderStatus(action: string | undefined): OrderStatus {
  switch (action?.toUpperCase()) {
    case 'CA':
      return 'cancelled';
    case 'CM':
    case 'OC':
    case 'DC':
      return 'completed';
    default:
      return 'active';
  }
}

/** Text of one component of a field (CE/EI/CX identifier etc). */
function comp(seg: HL7Segment, field: number, component?: number): string | undefined {
  const v = seg.field(field).getValue(component);
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'string' ? v : String(v);
  return s.length === 0 ? undefined : s;
}

/** CE code: identifier component (OBR-4). */
function ceId(seg: HL7Segment, field: number): string | undefined {
  return comp(seg, field, 1) ?? comp(seg, field);
}

/** EI id: entity-identifier component, else the whole field (ORC-2/3). */
function eiId(seg: HL7Segment, field: number): string | undefined {
  return comp(seg, field, 1) ?? comp(seg, field);
}