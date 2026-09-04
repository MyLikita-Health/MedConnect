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
import type { LabPayload, MappingTable } from '@integration-hub/shared';

/** Canonicalization result shape, mirroring the ASTM pipeline's return. */
export interface Hl7CanonicalizationResult {
  payload: LabPayload | null;
  issues: string[];
}

export interface Hl7ToCanonicalOptions {
  /** Analyzer/LIS test-code → canonical mappings (PRD §17–18); empty = pass-through. */
  mappings?: MappingTable;
}

/** Translate an ORU^R01 (raw wire text or already parsed) to the canonical model. */
export function hl7ToCanonical(
  message: string | HL7Message | PlatformMessage,
  opts: Hl7ToCanonicalOptions = {},
): Hl7CanonicalizationResult {
  const parsed = toHl7v2Message(message);
  const issues: string[] = [];

  // v1 translator scope: results-up only. Anything else fails loudly.
  const type = parsed.messageType;
  if (!type.startsWith('ORU^')) {
    return { payload: null, issues: [`unsupported message type ${type || '(unknown)'}: only ORU^R01 results are translated (v1)`] };
  }

  const pid = parsed.getSegment('PID');
  const patient: LabPayload['patient'] = pid
    ? {
        id: comp(pid, 3, 1) ?? '',
        name: formatPersonName(pid),
        dateOfBirth: comp(pid, 7),
        gender: comp(pid, 8),
      }
    : { id: '' };
  if (!patient.id) issues.push('Missing patient identifier');

  const { order, extraGroups } = resolveOrder(parsed);
  if (!order || !order.id) issues.push('Missing order identifier');
  if (extraGroups > 0) {
    issues.push(`message contains ${extraGroups + 1} distinct order groups — only one order per message is supported (v1)`);
  }

  const results = collectResults(parsed);
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

  /** Resolve the single order anchor (first OBR, else first ORC) + group count. */
  function resolveOrder(m: HL7Message): { order?: LabPayload['order']; extraGroups: number } {
    const obrs = m.segments.filter((s) => s.segmentType === 'OBR');
    const orcs = m.segments.filter((s) => s.segmentType === 'ORC');
    if (obrs.length === 0 && orcs.length === 0) return { extraGroups: 0 };

    // The guard above guarantees at least one exists (length checks do not
    // narrow index access under noUncheckedIndexedAccess, hence the assert).
    const anchor = (obrs[0] ?? orcs[0])!;
    const isObr = anchor.segmentType === 'OBR';
    // Filler (3) is the usual accession anchor; placer (2) is the fallback.
    const orderId = eiId(anchor, 3) ?? eiId(anchor, 2);
    const test = isObr ? { code: ceId(anchor, 4), name: ceText(anchor, 4) } : undefined;

    // Distinct secondary groups (by resolved id) are flagged, not merged.
    const ids = new Set<string>();
    for (const o of [...obrs, ...orcs]) {
      const id = eiId(o, 3) ?? eiId(o, 2);
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
  function collectResults(m: HL7Message): LabPayload['results'] {
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
        testCode: ceId(s, 3) ?? '',
        testName: ceText(s, 3),
        value: valueText(s, 5) ?? '',
        unit: ceId(s, 6),
        referenceRange: comp(s, 7),
        flag: comp(s, 8),
        status: comp(s, 11) ?? 'F',
        measuredAt: comp(s, 14),
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

/** CE text: second component (the display name). */
function ceText(seg: HL7Segment, field: number): string | undefined {
  return comp(seg, field, 2);
}

/** EI id: entity-identifier component, else the whole field (OBR-2/3, ORC-2/3). */
function eiId(seg: HL7Segment, field: number): string | undefined {
  return comp(seg, field, 1) ?? comp(seg, field);
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
function formatPersonName(pid: HL7Segment): string | undefined {
  const family = comp(pid, 5, 1);
  const given = [comp(pid, 5, 2), comp(pid, 5, 3)].filter((c): c is string => c !== undefined).join(' ').trim();
  if (!family) return given || undefined;
  return given ? `${family}, ${given}` : family;
}
