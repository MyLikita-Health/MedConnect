/**
 * ORU^R01 → canonical translator (workstream B2a).
 *
 * The inbound mirror of `astmToCanonical` (gateway/pipeline.ts): it reads an
 * HL7 result message parsed on the `hl7v2` substrate and produces the
 * platform's canonical `LabPayload` (PRD §16/§52 invariant — the core never
 * sees the wire protocol). Semantics mirror the ASTM reference layout so both
 * protocols feed the same downstream machinery (dedup → matching → validation
 * → HELD → route) with the same meaning:
 *
 *   PID   → patient  (PID-3 id · PID-5 name · PID-7 DOB · PID-8 sex)
 *   OBR   → order    (OBR-3 filler/accession id, else OBR-2 placer;
 *                     OBR-4 requested test) — ORC-2/3 as fallback anchor
 *   OBX   → results  (OBX-3 test · OBX-5 value · OBX-6 unit · OBX-7 ref ·
 *                     OBX-8 flag · OBX-11 status · OBX-14 measured-at)
 *
 * Field reads go through the dictionary: CE-type codes (OBR-4, OBX-3, OBX-6)
 * yield their identifier component. OBX-5 keeps its whole first repetition —
 * composite values (SN/CE) and escaped text are restored from wire text.
 * Failures follow the pipeline rule — never dropped silently: any issue
 * returns `payload: null` + the issues (message recorded FAILED/DLQ).
 *
 * V1 limits (mirror the scaffold's single-O/R assumption): one order per
 * message (an ORU carrying several distinct OBR groups is flagged, not
 * conflated); `sampleId` stays unset (no SPM parsing yet), so HL7 matching
 * uses the patientId+orderId strategy; only ORU^R01-family triggers are
 * translated (ADT/ORM get their own translators — B2c).
 */
import { HL7Message as Parse, type HL7Message, type HL7Segment } from 'hl7v2';
import { serializeMessage, unescapeText, type Hl7Encoding, type Hl7Message as PlatformMessage } from './message.js';
import { defaultHl7LayoutFor, type Hl7FieldRef, type Hl7RecordLayout, type LabPayload, type MappingTable } from '@integration-hub/shared';

/** Canonicalization result shape, mirroring the ASTM pipeline's return. */
export interface Hl7CanonicalizationResult {
  payload: LabPayload | null;
  issues: string[];
}

export interface Hl7ToCanonicalOptions {
  /** Analyzer/LIS test-code → canonical mappings (PRD §17–18); empty = pass-through. */
  mappings?: MappingTable;
  /**
   * B4: vendor HL7 segment-level layout overrides (a profile's `hl7`
   * config). Position defaults match the generic translator exactly;
   * `delimiters` overrides a sender's (wrong) MSH-2 for raw-wire input.
   */
  layout?: Hl7RecordLayout;
}

/** Translate an ORU^R01 (raw wire text or already parsed) to the canonical model. */
export function hl7ToCanonical(
  message: string | HL7Message | PlatformMessage,
  opts: Hl7ToCanonicalOptions = {},
): Hl7CanonicalizationResult {
  const layout = defaultHl7LayoutFor({ hl7: opts.layout });
  const parsed = toHl7v2Message(opts.layout?.delimiters && typeof message === 'string' ? forceDelimiters(message, opts.layout.delimiters) : message);
  const issues: string[] = [];

  // v1 translator scope: results-up only. Anything else fails loudly.
  const type = parsed.messageType;
  if (!type.startsWith('ORU^')) {
    return { payload: null, issues: [`unsupported message type ${type || '(unknown)'}: only ORU^R01 results are translated (v1)`] };
  }

  const pid = parsed.getSegment('PID');
  const patient: LabPayload['patient'] = pid
    ? {
        id: refComp(pid, layout.patient.id) ?? '',
        name: formatPersonName(pid, layout.patient.name?.field ?? 5),
        dateOfBirth: refPlain(pid, layout.patient.dateOfBirth),
        gender: refPlain(pid, layout.patient.sex),
      }
    : { id: '' };
  if (!patient.id) issues.push('Missing patient identifier');

  const { order, extraGroups } = resolveOrder(parsed, layout);
  if (!order || !order.id) issues.push('Missing order identifier');
  if (extraGroups > 0) {
    issues.push(`message contains ${extraGroups + 1} distinct order groups — only one order per message is supported (v1)`);
  }

  const results = collectResults(parsed, layout);
  if (results.length === 0) issues.push('No result records');
  for (const r of results) {
    if (!r.value) issues.push(`Result for "${r.testCode || '(unknown test)'}" has no value`);
  }

  if (!patient.id || !order || !order.id || results.length === 0 || issues.length > 0) {
    return { payload: null, issues };
  }

  const mappings = opts.mappings ?? {};
  const mapped = results.map((r) => {
    const mappedCode = mappings[r.testCode] ?? mappings[r.testCode.toUpperCase()];
    if (mappedCode && mappedCode !== r.testCode) {
      return { ...r, testCode: mappedCode, originalTestCode: r.testCode };
    }
    return r;
  });

  return { payload: { patient, order, results: mapped }, issues };

  /** Resolve the single order anchor (OBR by default, ORC when pinned) + group count. */
  function resolveOrder(m: HL7Message, lay: ReturnType<typeof defaultHl7LayoutFor>): { order?: LabPayload['order']; extraGroups: number } {
    const obrs = m.segments.filter((s) => s.segmentType === 'OBR');
    const orcs = m.segments.filter((s) => s.segmentType === 'ORC');
    if (obrs.length === 0 && orcs.length === 0) return { extraGroups: 0 };

    // The guard above guarantees at least one exists (length checks do not
    // narrow index access under noUncheckedIndexedAccess, hence the assert).
    const anchor = (lay.order.segment === 'ORC' ? orcs[0] ?? obrs[0] : obrs[0] ?? orcs[0])!;
    // Filler is the usual accession anchor; placer is the fallback. The
    // requested test always reads from the first OBR row (an ORC-anchored
    // feed still carries its tests on OBR — B4 layout `segment: 'ORC'`).
    const orderId = refComp(anchor, lay.order.fillerId) ?? refComp(anchor, lay.order.placerId);
    const obr = obrs[0];
    const test = obr
      ? { code: refComp(obr, lay.order.test) ?? '', name: comp(obr, lay.order.test.field, 2) ?? comp(obr, lay.order.test.field) }
      : undefined;

    // Distinct secondary groups (by resolved id) are flagged, not merged.
    // OBR rows are the observation groups; a single ORC header belongs to the
    // first one (an ORC+OBR pair for the same order is ONE group, not two).
    const groupSegs = obrs.length > 0 ? obrs : orcs;
    const ids = new Set<string>();
    for (const o of groupSegs) {
      const id = refComp(o, lay.order.fillerId) ?? refComp(o, lay.order.placerId);
      if (id) ids.add(id);
    }

    return {
      order: {
        id: orderId ?? '',
        // v1: no SPM parsing — sample/accession stays the order-id path only.
        tests: test?.code ? [{ code: test.code, name: test.name }] : [],
      },
      extraGroups: Math.max(0, ids.size - 1),
    };
  }

  /** Results under the order anchor: OBX after the first OBR (all when one group). */
  function collectResults(m: HL7Message, lay: ReturnType<typeof defaultHl7LayoutFor>): LabPayload['results'] {
    const out: LabPayload['results'] = [];
    const obrs = m.segments.filter((s) => s.segmentType === 'OBR');
    const firstObrIndex = m.segments.findIndex((s) => s.segmentType === 'OBR');
    const singleGroup = obrs.length <= 1;

    for (let i = 0; i < m.segments.length; i++) {
      const s = m.segments[i]!;
      if (s.segmentType !== 'OBX') continue;
      // With multiple OBR groups only the first group's OBX rows count (the
      // message is already flagged; later groups are not delivered).
      if (!singleGroup && firstObrIndex >= 0) {
        let group = firstObrIndex;
        for (let j = firstObrIndex + 1; j < i; j++) {
          if (m.segments[j]!.segmentType === 'OBR') group = j;
        }
        if (group !== firstObrIndex) continue;
      }
      out.push({
        testCode: refComp(s, lay.result.testCode) ?? '',
        // Name defaults to the CE text component of the code field; a vendor
        // that names its code differently pins `testName` explicitly (B4).
        testName: lay.result.testName
          ? refComp(s, lay.result.testName) ?? ''
          : comp(s, lay.result.testCode.field, 2) ?? comp(s, lay.result.testCode.field),
        value: valueText(s, lay.result.value.field) ?? '',
        unit: refComp(s, lay.result.unit),
        referenceRange: refPlain(s, lay.result.referenceRange),
        flag: refPlain(s, lay.result.flag),
        status: refPlain(s, lay.result.status) ?? 'F',
        measuredAt: refPlain(s, lay.result.measuredAt),
      });
    }
    return out;
  }
}

/** Normalize string | lib-parsed | our-platform-model input to an hl7v2 message. */
function toHl7v2Message(message: string | HL7Message | PlatformMessage): HL7Message {
  if (typeof message === 'string') return Parse.parse(message);
  if (typeof (message as HL7Message).getSegment === 'function') return message as HL7Message;
  // Our platform model holds raw fields per segment; re-serialize losslessly
  // and parse through the dictionary.
  return Parse.parse(serializeMessage(message as PlatformMessage));
}

/** Text of one component of a field (CE/EI/CX identifier etc). */
function comp(seg: HL7Segment, field: number, component?: number): string | undefined {
  const v = seg.field(field).getValue(component);
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'string' ? v : String(v);
  return s.length === 0 ? undefined : s;
}

/** CE code: identifier component (OBR-4, OBX-3, OBX-6). */
function ceId(seg: HL7Segment, field: number): string | undefined {
  return comp(seg, field, 1) ?? comp(seg, field);
}

/** EI id: entity-identifier component, else the whole field (OBR-2/3, ORC-2/3). */
function eiId(seg: HL7Segment, field: number): string | undefined {
  return comp(seg, field, 1) ?? comp(seg, field);
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

/**
 * Override a raw message's MSH-2 separators (B4: senders whose MSH-2 lies).
 * Position 0-3 hold `MSH|`; MSH-2 lives at offset 4 — the declared field,
 * repetition, escape and subcomponent separators are stamped in place.
 */
export function forceDelimiters(raw: string, d: NonNullable<Hl7RecordLayout['delimiters']>): string {
  if (!raw.startsWith('MSH') || raw.length < 8) return raw;
  const chars = raw.split('');
  if (d.component) chars[4] = d.component;
  if (d.repetition) chars[5] = d.repetition;
  if (d.escape) chars[6] = d.escape;
  if (d.subcomponent) chars[7] = d.subcomponent;
  return chars.join('');
}

/**
 * Whole first-repetition value of OBX-5, restored from wire text: escaped
 * delimiters come back (`\F\` `\S\` → real), composite types (SN `1.2^2^3`,
 * CE) keep every component — unlike dictionary `getValue()`, which would
 * return only the first component of a composite value.
 */
function valueText(seg: HL7Segment, field: number): string | undefined {
  const m = seg.message;
  const encoding: Hl7Encoding = {
    field: m.fieldSeparator,
    component: m.componentSeparator,
    repetition: m.repetitionSeparator,
    escape: m.escapeCharacter,
    subcomponent: m.subComponentSeparator,
  };
  const raw = seg.field(field).repetition(0).toHL7String();
  if (!raw) return undefined;
  const v = unescapeText(raw, encoding);
  return v.length > 0 ? v : undefined;
}

/** "Doe^Jane^A" → "Doe, Jane A" (same display convention as the ASTM pipeline). */
function formatPersonName(pid: HL7Segment, field: number): string | undefined {
  const family = comp(pid, field, 1);
  const given = [comp(pid, field, 2), comp(pid, field, 3)].filter((c): c is string => c !== undefined).join(' ').trim();
  if (!family) return given || undefined;
  return given ? `${family}, ${given}` : family;
}
