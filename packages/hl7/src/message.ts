/**
 * Minimal HL7 v2 message model (workstream B1 — the substrate the MLLP layer
 * and the ACK builder work on; the segment → canonical translator (B2) and
 * serializer (B3) build on top of this later).
 *
 * Conventions kept deliberately small and vendor-tolerant:
 *   - one message = segments separated by CR (LF / CRLF accepted on input),
 *   - every segment = an id (MSH, PID, OBR, OBX, MSA, ...) followed by
 *     pipe-separated fields; the MSH-2 encoding characters (^~\&) define the
 *     component/repetition/escape/subcomponent separators,
 *   - fields are stored raw (0-indexed, MSH-2 at index 0), matching how the
 *     rest of the platform stores `ParsedRecord {type, fields}`.
 *
 * Escaping follows the standard sequences \F\ \S\ \T\ \R\ \E\ (and assumes the
 * conventional backslash escape character); \X..\ hex escapes are preserved
 * uninterpreted for now.
 */
export interface Hl7Encoding {
  /** Field separator, e.g. '|' (MSH-1). */
  field: string;
  /** Component separator, e.g. '^' (MSH-2[0]). */
  component: string;
  /** Repetition separator, e.g. '~' (MSH-2[1]). */
  repetition: string;
  /** Escape character, e.g. '\\' (MSH-2[2]). */
  escape: string;
  /** Subcomponent separator, e.g. '&' (MSH-2[3]). */
  subcomponent: string;
}

/** The standard HL7 v2 encoding (as used by virtually every real system). */
export const DEFAULT_ENCODING: Hl7Encoding = {
  field: '|',
  component: '^',
  repetition: '~',
  escape: '\\',
  subcomponent: '&',
};

export interface Hl7Segment {
  /** Segment id, e.g. 'MSH', 'PID', 'OBR', 'OBX', 'MSA'. */
  id: string;
  /** Fields after the segment id (0-indexed; MSH-2 encoding chars = index 0). */
  fields: string[];
}

export interface Hl7Message {
  /** Delimiters this message was parsed with (from its own MSH-2). */
  encoding: Hl7Encoding;
  segments: Hl7Segment[];
}

/**
 * 0-based field indexes into an MSH segment's `fields` for the commonly used
 * MSH-2..12 slots. MSH-1 (the field separator) is not stored; MSH-2, the
 * encoding characters, is `fields[0]`.
 */
export const MSH_SLOTS = {
  encodingChars: 0,
  /** MSH-3. */
  sendingApp: 1,
  /** MSH-4. */
  sendingFacility: 2,
  /** MSH-5. */
  receivingApp: 3,
  /** MSH-6. */
  receivingFacility: 4,
  /** MSH-7. */
  dateTime: 5,
  /** MSH-8. */
  security: 6,
  /** MSH-9. */
  messageType: 7,
  /** MSH-10. */
  controlId: 8,
  /** MSH-11. */
  processingId: 9,
  /** MSH-12. */
  version: 10,
} as const;

/** Split a message into segments and fields, honouring its own MSH delimiters. */
export function parseMessage(raw: string): Hl7Message {
  const encoding = detectEncoding(raw);
  const segments: Hl7Segment[] = [];
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (line.trim().length === 0) continue; // tolerate blank padding lines
    const parts = line.split(encoding.field);
    const id = (parts[0] ?? '').trim();
    if (!id) continue;
    segments.push({ id, fields: parts.slice(1) });
  }
  return { encoding, segments };
}

/** Serialize a message back to wire text (segments joined by CR, no wrapper). */
export function serializeMessage(message: Hl7Message): string {
  return message.segments
    .map((s) => `${s.id}${message.encoding.field}${s.fields.join(message.encoding.field)}`)
    .join('\r');
}

/** 0-based field accessor on a segment (undefined when the field is absent). */
export function segmentField(segment: Hl7Segment, index: number): string | undefined {
  return segment.fields[index];
}

/** First segment with the given id (undefined when absent). */
export function firstSegment(message: Hl7Message, id: string): Hl7Segment | undefined {
  return message.segments.find((s) => s.id === id);
}

/** All segments with the given id (e.g. multiple OBX rows). */
export function allSegments(message: Hl7Message, id: string): Hl7Segment[] {
  return message.segments.filter((s) => s.id === id);
}

/** Escape delimiter characters in free text (e.g. an MSA-3 error message). */
export function escapeText(value: string, encoding: Hl7Encoding = DEFAULT_ENCODING): string {
  return value
    .split(encoding.escape)
    .join(seq(encoding.escape, 'E'))
    .split(encoding.field)
    .join(seq(encoding.escape, 'F'))
    .split(encoding.component)
    .join(seq(encoding.escape, 'S'))
    .split(encoding.repetition)
    .join(seq(encoding.escape, 'R'))
    .split(encoding.subcomponent)
    .join(seq(encoding.escape, 'T'));
}

/** Reverse escapeText: \F\ \S\ \T\ \R\ \E\ back to their delimiter characters. */
export function unescapeText(value: string, encoding: Hl7Encoding = DEFAULT_ENCODING): string {
  const esc = encoding.escape;
  const pairs: Array<[from: string, to: string]> = [
    [seq(esc, 'F'), encoding.field],
    [seq(esc, 'S'), encoding.component],
    [seq(esc, 'T'), encoding.subcomponent],
    [seq(esc, 'R'), encoding.repetition],
    [seq(esc, 'E'), esc],
  ];
  let out = value;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}

/** escape-char + code + escape-char, e.g. ('\\', 'F') -> '\\F\\'. */
function seq(escape: string, code: string): string {
  return `${escape}${code}${escape}`;
}

/**
 * Delimiters come from the message's own MSH header when present
 * (field sep at byte 3, encoding chars at bytes 4–7); anything else defaults.
 */
function detectEncoding(raw: string): Hl7Encoding {
  if (!raw.startsWith('MSH')) return { ...DEFAULT_ENCODING };
  const field = raw[3];
  if (!field || field === '\r' || field === '\n') return { ...DEFAULT_ENCODING };
  return {
    field,
    component: raw[4] ?? DEFAULT_ENCODING.component,
    repetition: raw[5] ?? DEFAULT_ENCODING.repetition,
    escape: raw[6] ?? DEFAULT_ENCODING.escape,
    subcomponent: raw[7] ?? DEFAULT_ENCODING.subcomponent,
  };
}
