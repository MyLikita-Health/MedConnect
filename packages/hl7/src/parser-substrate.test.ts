/**
 * D7 spike — parser substrate evaluation (workstream B1b).
 *
 * Verdict (recorded 2026-09): **adopt `hl7v2` (panates, MIT) as the parsing
 * substrate for the HL7 translators.** Verified here against a golden corpus:
 *
 *   1. Parses ORU/ADT across 2.3.1 / 2.4 / 2.5.1 without throwing, with
 *      dictionary-typed access to segments, fields, repetitions and
 *      components.
 *   2. Unescaping is correct (OBX-5/NTE-3 `\F\` `\S\` come back as the real
 *      delimiters) and repetition counts are right (2-rep PID-3).
 *   3. Failure is a typed, predictable `HL7Error` (missing MSH / garbage),
 *      while truncated-but-MSH-leading input is tolerated — good enough for a
 *      gateway that must never crash on the wire.
 *   4. Quirk to design around: `toHL7String()` re-serializes through the
 *      datatype dictionary and normalizes (e.g. a 14-digit DTM lost its
 *      seconds). So the lib is our **read/extract** substrate; byte-fidelity
 *      output (viewer raw, outbound ORM/ORU) is built from our own model —
 *      never by round-tripping a parsed message through `toHL7String()`.
 *
 * Seam decision: translators live inside `@integration-hub/hl7` (the lib is a
 * dep of this package only) and expose platform shapes; `hl7v2` never leaks
 * into `shared`/`core`/`api`. This file is the regression corpus that pins
 * the substrate's contract — it also seeds the HL7 golden library (B4/K).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HL7Error, HL7Message } from 'hl7v2';
import { parseMessage, segmentField, unescapeText } from './message.js';

/** Golden corpus: raw messages → the facts the ORU/ADT translators need. */
interface CorpusCase {
  name: string;
  raw: string;
  version: string;
  messageType: string;
  controlId: string;
  pid3FirstId: string;
  pid3Reps: number;
  pid5Family: string;
  obxCount: number;
  /** First OBX-5 value unescaped by the parser (or undefined when none). */
  firstObxValue?: string;
  /** Raw wire text of the first OBX-5 field (escaping intact). */
  firstObx5Raw?: string;
}

const CORPUS: CorpusCase[] = [
  {
    name: 'ORU 2.3.1',
    raw: [
      'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG0001|P|2.3.1',
      'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
      'OBR|1|ORD-77|ORD-77|GLU^Glucose|||||||||||||||||||||||F',
      'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N||F',
    ].join('\r'),
    version: '2.3.1',
    messageType: 'ORU^R01',
    controlId: 'MSG0001',
    pid3FirstId: 'PID-1001',
    pid3Reps: 1,
    pid5Family: 'Adeyemi',
    obxCount: 1,
    firstObxValue: '95',
    firstObx5Raw: '95',
  },
  {
    name: 'ORU 2.4 with escaped NTE text',
    raw: [
      'MSH|^~\\&|LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG2|P|2.4',
      'PID|1||PID-2001^^^HOSP^MR||Okafor^Chioma||19921107|F',
      'OBR|1||ORD-2|CHEM^Panel',
      'OBX|1|NM|GLU^Glucose||92|mg/dL|70-110|N||F',
      'NTE|1||See\\F\\comments\\S\\file',
    ].join('\r'),
    version: '2.4',
    messageType: 'ORU^R01',
    controlId: 'MSG2',
    pid3FirstId: 'PID-2001',
    pid3Reps: 1,
    pid5Family: 'Okafor',
    obxCount: 1,
    firstObxValue: '92',
    firstObx5Raw: '92',
  },
  {
    name: 'ORU 2.5.1 with 2-rep PID-3 and escaped TX comment',
    raw: [
      'MSH|^~\\&|SEND|SENDFAC|RECV|RECVFAC|20260904123000||ORU^R01|B2|P|2.5.1',
      'PID|1||MRN-1^^^HOSP^MR~ALT-2^^^HOSP^PI||Doe^Jane^A||19800101|F',
      'OBR|1||ORD-2|GLU^Glucose',
      'OBX|1|TX|NOTE^Comment||line1\\F\\line2\\S\\caret|mg|0-1|A|||F',
    ].join('\r'),
    version: '2.5.1',
    messageType: 'ORU^R01',
    controlId: 'B2',
    pid3FirstId: 'MRN-1',
    pid3Reps: 2,
    pid5Family: 'Doe',
    obxCount: 1,
    firstObxValue: 'line1|line2^caret',
    firstObx5Raw: 'line1\\F\\line2\\S\\caret',
  },
  {
    name: 'ADT^A01 2.5.1 (non-ORU trigger)',
    raw: [
      'MSH|^~\\&|EPIC|HOSP|HUB|FAC2|20260904100000||ADT^A01|ADT-9|P|2.5.1',
      'EVN|A01|20260904100000',
      'PID|1||MRN-88^^^HOSP^MR||Bello^Musa||19750505|M',
      'NK1|1|Bello^Amina|WIFE',
    ].join('\r'),
    version: '2.5.1',
    messageType: 'ADT^A01',
    controlId: 'ADT-9',
    pid3FirstId: 'MRN-88',
    pid3Reps: 1,
    pid5Family: 'Bello',
    obxCount: 0,
  },
];

function facts(msg: HL7Message, c: CorpusCase) {
  const pid = msg.getSegment('PID');
  const obx = msg.segments.filter((s) => s.segmentType === 'OBX');
  return {
    version: msg.version,
    messageType: msg.messageType,
    controlId: msg.controlId,
    pid3Reps: pid ? pid.field(3).repetitions.length : 0,
    pid3FirstId: pid ? (pid.field(3).repetition(0).getValue(1) as string) : undefined,
    pid5Family: pid ? (pid.field(5).getValue(1) as string) : undefined,
    obxCount: obx.length,
    firstObxValue: obx[0] ? (obx[0].field(5).getValue() as string) : undefined,
    firstObx5Raw: obx[0] ? obx[0].field(5).toHL7String() : undefined,
  };
}

test('golden corpus parses with the expected facts', () => {
  for (const c of CORPUS) {
    const f = facts(HL7Message.parse(c.raw), c);
    assert.equal(f.version, c.version, `${c.name}: version`);
    assert.equal(f.messageType, c.messageType, `${c.name}: messageType`);
    assert.equal(f.controlId, c.controlId, `${c.name}: controlId`);
    assert.equal(f.pid3FirstId, c.pid3FirstId, `${c.name}: PID-3 first id`);
    assert.equal(f.pid3Reps, c.pid3Reps, `${c.name}: PID-3 repetitions`);
    assert.equal(f.pid5Family, c.pid5Family, `${c.name}: PID-5 family`);
    assert.equal(f.obxCount, c.obxCount, `${c.name}: OBX count`);
    assert.equal(f.firstObxValue, c.firstObxValue, `${c.name}: first OBX-5 (unescaped)`);
    assert.equal(f.firstObx5Raw, c.firstObx5Raw, `${c.name}: first OBX-5 raw (escapes intact)`);
  }
});

test('parsed unescaped values agree with our raw-split + unescapeText', () => {
  for (const c of CORPUS) {
    if (!c.firstObx5Raw) continue;
    const ours = parseMessage(c.raw);
    const obx = ours.segments.find((s) => s.id === 'OBX');
    // Our model stores fields 0-indexed after the segment id: OBX-5 (1-based)
    // is index 4.
    const rawField5 = obx ? segmentField(obx, 4) : undefined;
    assert.equal(unescapeText(rawField5 ?? '', ours.encoding), c.firstObxValue, `${c.name}: raw-split unescape parity`);
  }
});

test('semantic round-trip survives toHL7String re-serialization', () => {
  // The serializer normalizes (a 14-digit DTM lost its seconds — documented
  // quirk), so byte equality is NOT asserted; the extracted facts must hold.
  for (const c of CORPUS) {
    const reparsed = HL7Message.parse(HL7Message.parse(c.raw).toHL7String());
    const f = facts(reparsed, c);
    assert.equal(f.controlId, c.controlId, `${c.name}: controlId survives`);
    assert.equal(f.messageType, c.messageType, `${c.name}: messageType survives`);
    assert.equal(f.pid3FirstId, c.pid3FirstId, `${c.name}: PID-3 id survives`);
    assert.equal(f.firstObxValue, c.firstObxValue, `${c.name}: OBX-5 value survives`);
  }
});

test('failure mode is a typed HL7Error, not a crash', () => {
  assert.throws(() => HL7Message.parse('this is not an hl7 message'), HL7Error);
  assert.throws(() => HL7Message.parse(''), HL7Error);
  // Truncated-but-MSH-leading input is tolerated (1 segment, no throw).
  const truncated = HL7Message.parse('MSH|^~\\&|SENDER');
  assert.equal(truncated.segments.length, 1);
  assert.equal(truncated.segments[0]!.segmentType, 'MSH');
});
