/**
 * Inbound ADT^A01/A04/A08 patient-admission translator (workstream B2c
 * extension — the patient-side of the LIS/HIS seam). ADT messages carry
 * patient admissions, not results: like ORM orders they have no canonical
 * `LabPayload` target, so (mirroring the plan §13.15 decision for orders)
 * they translate directly into the **admission registry** — the patient
 * counterpart of the expected-order registry.
 *
 * Extracted shape (pure — no `@integration-hub/core` import):
 *
 *   PID-3 → patientId · PID-5 → name (family^given convention)
 *   PID-7 → dateOfBirth · PID-8 → gender · PV1-19 → visitId (best-effort)
 *   trigger → status (A01 admit / A04 register / A08 update → 'admitted';
 *   A03 discharge → 'discharged')
 *
 * Field reads honor a B4 vendor `hl7` layout exactly like the ORU/ORM
 * translators (`defaultHl7LayoutFor` — PID position overrides + delimiter
 * stamping). Failure follows the pipeline rule — never silently dropped:
 * any issue returns `null` + the reasons (the gateway ACKs AR).
 */
import { HL7Message as Parse, type HL7Message, type HL7Segment } from 'hl7v2';
import { defaultHl7LayoutFor, type Hl7FieldRef, type Hl7RecordLayout } from '@integration-hub/shared';
import { forceDelimiters } from './translate.js';

export type AdmissionStatus = 'admitted' | 'discharged';

/** The admission shape the registry seam accepts (mirrors OrderRegistration). */
export interface AdmissionRegistration {
  patientId: string;
  name?: string;
  dateOfBirth?: string;
  gender?: string;
  /** Visit / encounter number when carried (PV1-19). */
  visitId?: string;
  status: AdmissionStatus;
  receivedAt?: string;
}

export interface Hl7AdmissionResult {
  /** The registered admission, or null when the message cannot be translated. */
  admission: AdmissionRegistration | null;
  issues: string[];
}

export interface Hl7ToAdmissionOptions {
  /**
   * B4: vendor HL7 segment-level layout overrides (a profile's `hl7`
   * config). Position defaults match the generic translator exactly.
   */
  layout?: Hl7RecordLayout;
}

/** Supported admission triggers (plan: ADT^A01/A04/A08 message support). */
const ADT_TRIGGERS = new Set(['A01', 'A04', 'A08', 'A03']);

/** Translate an ADT^A01/A04/A08 (raw wire text or already parsed) to an admission. */
export function hl7ToAdmission(
  message: string | HL7Message,
  opts: Hl7ToAdmissionOptions = {},
): Hl7AdmissionResult {
  const layout = defaultHl7LayoutFor({ hl7: opts.layout });
  const parsed = typeof message === 'string'
    ? Parse.parse(opts.layout?.delimiters ? forceDelimiters(message, opts.layout.delimiters) : message)
    : message;
  const issues: string[] = [];

  const type = parsed.messageType;
  if (!type.startsWith('ADT^')) {
    return { admission: null, issues: [`unsupported message type ${type || '(unknown)'}: only ADT^A01 patient admissions are translated (v1)`] };
  }
  const trigger = type.split('^')[1] ?? '';
  if (!ADT_TRIGGERS.has(trigger)) {
    return { admission: null, issues: [`unsupported ADT trigger ${trigger || '(unknown)'}: A01/A04/A08/A03 are supported (v1)`] };
  }

  const pid = parsed.getSegment('PID');
  const patientId = pid ? refComp(pid, layout.patient.id) ?? '' : '';
  if (!patientId) issues.push('Missing patient identifier');

  // PV1-19 visit number (best-effort — an ADT without PV1 still registers).
  const pv1 = parsed.getSegment('PV1');
  const visitId = pv1 ? comp(pv1, 19, 1) ?? undefined : undefined;

  if (!patientId || issues.length > 0) return { admission: null, issues };

  const name = pid && layout.patient.name ? formatPersonName(pid, layout.patient.name.field) : undefined;
  const dob = pid ? refPlain(pid, layout.patient.dateOfBirth) : undefined;
  const gender = pid ? refPlain(pid, layout.patient.sex) : undefined;

  return {
    admission: {
      patientId,
      ...(name ? { name } : {}),
      ...(dob ? { dateOfBirth: dob } : {}),
      ...(gender ? { gender } : {}),
      ...(visitId ? { visitId } : {}),
      status: trigger === 'A03' ? 'discharged' : 'admitted',
    },
    issues,
  };
}

/** Text of one component of a field (CE/EI/CX identifier etc). */
function comp(seg: HL7Segment, field: number, component?: number): string | undefined {
  const v = seg.field(field).getValue(component);
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'string' ? v : String(v);
  return s.length === 0 ? undefined : s;
}

/** Identifier-component default for a field ref (component 1, else whole field). */
function refComp(seg: HL7Segment, ref?: Hl7FieldRef): string | undefined {
  if (!ref) return undefined;
  return comp(seg, ref.field, ref.component) ?? comp(seg, ref.field);
}

/** Plain read for a field ref (no identifier-component default — TS/IS/ST). */
function refPlain(seg: HL7Segment, ref?: Hl7FieldRef): string | undefined {
  if (!ref) return undefined;
  return ref.component !== undefined ? comp(seg, ref.field, ref.component) : comp(seg, ref.field);
}

/** "Doe^Jane^A" → "Doe, Jane A" (same display convention as the ORU translator). */
function formatPersonName(pid: HL7Segment, field: number): string | undefined {
  const family = comp(pid, field, 1);
  const given = [comp(pid, field, 2), comp(pid, field, 3)].filter((c): c is string => c !== undefined).join(' ').trim();
  if (!family) return given || undefined;
  return given ? `${family}, ${given}` : family;
}