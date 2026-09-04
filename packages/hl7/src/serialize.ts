/**
 * Canonical → HL7 v2 serializer (workstream B3.1 — the outbound mirror of
 * `hl7ToCanonical`). Builds wire text for ORU^R01 (results to an LIS) and
 * ORM^O01 (order download, plan §6.4) from the platform's canonical
 * `LabPayload`.
 *
 * Wire text is built on OUR message model (`message.ts`) — never by
 * round-tripping through the `hl7v2` lib's `toHL7String()`, which
 * re-serializes through the datatype dictionary and normalizes values (the
 * documented D7 constraint: output must be byte-faithful to what we send).
 *
 * v1 scope (documented in the plan §13.15 kickoff): result codes are emitted
 * in canonical space (real per-destination code mapping is a B4 / §17–18
 * refinement); a single order group; OBX-2 (value type) is inferred — numeric
 * values → NM, otherwise ST; PID-5 is rebuilt from the display-name
 * convention "Family, Given"; free-text fields (OBX-5 values) are escaped so
 * delimiters survive the wire intact.
 */
import { randomBytes } from 'node:crypto';
import type { CanonicalPatient, CanonicalResult, LabPayload } from '@integration-hub/shared';
import { escapeText } from './message.js';

export interface OutboundOptions {
  /** MSH-3 sending application (default 'HUB'). */
  sendingApp?: string;
  /** MSH-4 sending facility. */
  sendingFacility?: string;
  /** MSH-5 receiving application (the LIS, for a results/order push). */
  receivingApp?: string;
  /** MSH-6 receiving facility. */
  receivingFacility?: string;
  /** MSH-12 version (default '2.5.1'). */
  version?: string;
  /** MSH-10 control id; generated when absent. */
  controlId?: string;
  /** MSH-7 timestamp override (deterministic tests); default = now (UTC). */
  dateTime?: string;
}

const DEFAULT_SENDING_APP = 'HUB';
const DEFAULT_VERSION = '2.5.1';

/**
 * Canonical results → ORU^R01 (MSH/PID/OBR/OBX). `payload.results` become
 * OBX rows under one OBR anchored on `payload.order.id` (the filler/accession,
 * matching what `hl7ToCanonical` reads back); the OBR-4 requested test is the
 * first order test, else the first result.
 */
export function canonicalToOru(payload: LabPayload, opts: OutboundOptions = {}): string {
  const first = payload.order.tests[0] ?? (payload.results[0] ? codeName(payload.results[0]) : undefined);
  const obr: string[] = ['1', '', payload.order.id, first ? `${first.code}${first.name ? `^${first.name}` : ''}` : ''];

  const obx: string[] = payload.results.map((r, i) => buildObx(r, i + 1));

  const segments = [
    buildMsh('ORU^R01', opts),
    buildPid(payload.patient),
    `OBR|${obr.join('|')}`,
    ...obx,
  ];
  return segments.join('\r');
}

/**
 * Canonical order → ORM^O01 (order download, plan §6.4): one ORC anchored on
 * `payload.order.id` plus one OBR per requested test, so multi-test orders
 * land as the LIS/device expects. `payload.results` is ignored (an order has
 * no results); pass a payload with `results: []`.
 */
export function canonicalToOrm(payload: LabPayload, opts: OutboundOptions = {}): string {
  const placer = `ORD-${payload.order.id}`;
  const tests = payload.order.tests.length > 0
    ? payload.order.tests
    : payload.results.length > 0 ? [codeName(payload.results[0]!)] : [];

  const segments = [buildMsh('ORM^O01', opts), buildPid(payload.patient)];
  segments.push(`ORC|NW|${placer}|${payload.order.id}|${tests[0] ? `${tests[0].code}${tests[0].name ? `^${tests[0].name}` : ''}` : ''}`);
  tests.forEach((test, i) => {
    segments.push(`OBR|${i + 1}|${placer}|${payload.order.id}|${test.code}${test.name ? `^${test.name}` : ''}`);
  });
  return segments.join('\r');
}

/** MSH header for a given trigger (MSH-9); structural fields, never escaped. */
function buildMsh(trigger: string, opts: OutboundOptions): string {
  const msh: string[] = [
    'MSH',
    '^~\\&',
    opts.sendingApp ?? DEFAULT_SENDING_APP,
    opts.sendingFacility ?? '',
    opts.receivingApp ?? '',
    opts.receivingFacility ?? '',
    opts.dateTime ?? hl7DateTime(),
    '',
    trigger,
    opts.controlId ?? generateControlId(),
    'P',
    opts.version ?? DEFAULT_VERSION,
  ];
  return msh.join('|');
}

/** PID from the canonical patient (PID-3 id · PID-5 name · PID-7 DOB · PID-8 sex). */
function buildPid(patient: CanonicalPatient): string {
  const [family, given] = splitDisplayName(patient.name);
  const name = family ? (given ? `${family}^${given}` : family) : given ?? '';
  return ['PID', '1', '', `${patient.id}^^^HUB^PI`, '', name, '', patient.dateOfBirth ?? '', patient.gender ?? ''].join('|');
}

/** OBX row from a canonical result (fields to OBX-14 = measured-at). */
function buildObx(r: CanonicalResult, seq: number): string {
  const valueType = isNumeric(r.value) ? 'NM' : 'ST';
  const testName = r.testName ? `^${r.testName}` : '';
  // 0-indexed after the segment id: OBX-5 (value) is fields[4], OBX-14 is fields[13].
  const obx: (string | undefined)[] = [
    String(seq),
    valueType,
    `${r.testCode}${testName}`,
    '',
    escapeText(r.value), // free text: escaped so delimiters survive the wire
    r.unit ?? '',
    r.referenceRange ?? '',
    r.flag ?? '',
    '',
    '',
    r.status ?? 'F',
    undefined, // OBX-12 (last normal range)
    undefined, // OBX-13
    r.measuredAt ?? '', // OBX-14
  ];
  return `OBX|${obx.map((v) => v ?? '').join('|')}`;
}

/** "Doe, Jane A" → ["Doe", "Jane A"]; no comma → whole string as family. */
function splitDisplayName(name: string | undefined): [string | undefined, string | undefined] {
  if (!name) return [undefined, undefined];
  const comma = name.indexOf(', ');
  if (comma < 0) return [name, undefined];
  return [name.slice(0, comma), name.slice(comma + 2)];
}

function isNumeric(value: string): boolean {
  return /^[-+]?\d+(\.\d+)?$/.test(value);
}

function codeName(r: CanonicalResult): { code: string; name?: string } {
  return { code: r.testCode, name: r.testName };
}

/** YYYYMMDDHHMMSS (UTC) — the HL7 DTM convention without microseconds. */
function hl7DateTime(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function generateControlId(): string {
  return `HUB-${randomBytes(6).toString('hex')}`;
}