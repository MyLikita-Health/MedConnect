/**
 * HL7 golden-message conformance harness (plan §13.15 — the B4 layout-based
 * oracle, recorded). The ASTM golden library (`goldens/*.json` in the repo
 * root, `conformance.ts` in core) records device transcripts + the canonical
 * payload they MUST produce under a profile. HL7 goldens live in the same
 * library with a `protocol: "HL7"` marker and carry the frozen wire + the B4
 * `hl7` layout override + the expected canonical content:
 *
 *   kind 'oru' → hl7ToCanonical(wire, { layout }) vs expected patient/order/
 *                results (the results-up oracle)
 *   kind 'orm' → hl7ToOrder(wire, { layout }) vs expected registration
 *                (the LIS-seam order oracle)
 *
 * A case WITHOUT a layout pins that the GENERIC parse must produce the
 * expected payload (unprofiled devices parse identically); with a layout it
 * pins the vendor deviation decode. Executed under `npm test` by
 * `src/goldens.test.ts` — the CI gate. Real vendor field transcripts replace
 * the synthetic B4 corpus under risk R2.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hl7RecordLayout, LabPayload } from '@integration-hub/shared';
import { hl7ToCanonical } from './translate.js';
import { hl7ToOrder, type OrderRegistration } from './order.js';

/** Expected canonical content for an HL7 golden; partial comparison. */
export interface Hl7GoldenExpectation {
  patient?: Partial<LabPayload['patient']>;
  order?: {
    id?: string;
    sampleId?: string;
    tests?: Array<{ code?: string; name?: string }>;
  };
  results?: Array<{
    testCode?: string;
    originalTestCode?: string;
    testName?: string;
    value?: string;
    unit?: string;
    referenceRange?: string;
    flag?: string;
    status?: string;
  }>;
  /** kind 'orm' — the expected-order-registration shape. */
  registration?: {
    id?: string;
    patientId?: string;
    sampleId?: string;
    tests?: string[];
    status?: OrderRegistration['status'];
  };
  /** Golden must FAIL with at least these issues. */
  expectIssues?: string[];
}

export interface Hl7GoldenCase {
  name: string;
  kind: 'oru' | 'orm';
  /**
   * B4 vendor segment-level layout override. Absent = the generic parse must
   * yield `expected` (records the reference behavior).
   */
  layout?: Hl7RecordLayout;
  /**
   * The frozen transcript, one element per segment (joined with CR on the
   * wire). Self-contained: the recorded bytes ARE the contract.
   */
  wire: string[];
  expected: Hl7GoldenExpectation;
}

export interface Hl7GoldenFile {
  protocol: 'HL7';
  name: string;
  source?: string;
  goldens: Hl7GoldenCase[];
}

export interface Hl7ConformanceCaseResult {
  name: string;
  pass: boolean;
  failures: string[];
}

export interface Hl7ConformanceRunResult {
  file: string;
  ranAt: string;
  cases: Hl7ConformanceCaseResult[];
  passed: number;
  failed: number;
}

/** The shared golden library (same location core's goldensDir resolves). */
export function hl7GoldensDir(): string {
  return process.env.HUB_GOLDENS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'goldens');
}

/** Load every HL7 golden file in the library (files marked protocol HL7). */
export async function loadHl7Goldens(dir = hl7GoldensDir()): Promise<Array<{ file: string; golden: Hl7GoldenFile }>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const out: Array<{ file: string; golden: Hl7GoldenFile }> = [];
  for (const file of files.sort()) {
    let golden: Hl7GoldenFile | undefined;
    try {
      const parsed = JSON.parse(await readFile(join(dir, file), 'utf8')) as { protocol?: string };
      if (parsed.protocol === 'HL7') golden = parsed as Hl7GoldenFile;
    } catch {
      // unparseable or non-HL7 file: skip (ASTM goldens have no protocol field)
    }
    if (golden) out.push({ file, golden });
  }
  return out;
}

/**
 * Run every case of an HL7 golden file through the layout-based oracle and
 * report mismatches. A case passes only when every expectation holds.
 */
export function runHl7Conformance(file: string, golden: Hl7GoldenFile): Hl7ConformanceRunResult {
  const cases: Hl7ConformanceCaseResult[] = golden.goldens.map((g) => ({
    name: g.name,
    pass: false,
    failures: checkGolden(g),
  }));
  let passed = 0;
  for (const c of cases) {
    if (c.failures.length === 0) {
      c.pass = true;
      passed++;
    }
  }
  return { file, ranAt: new Date().toISOString(), cases, passed, failed: cases.length - passed };
}

function checkGolden(golden: Hl7GoldenCase): string[] {
  const wire = golden.wire.join('\r');
  const failures: string[] = [];
  const expected = golden.expected;
  const opts = golden.layout ? { layout: golden.layout } : {};

  // Translate; `value` is true when a payload/order came out of the oracle.
  let value: boolean;
  let issues: string[];
  if (golden.kind === 'orm') {
    const { order, issues: is } = hl7ToOrder(wire, opts);
    issues = is;
    value = order !== null;
    if (order && expected.registration) checkRegistration(failures, order, expected.registration);
  } else {
    const { payload, issues: is } = hl7ToCanonical(wire, opts);
    issues = is;
    value = payload !== null;
    if (payload) checkPayload(failures, payload, expected);
  }

  if (!value) {
    // Failure case expected, or a real regression to report.
    if (expected.expectIssues) {
      for (const issue of expected.expectIssues) {
        if (!issues.some((i) => i.includes(issue))) {
          failures.push(`expected issue "${issue}" — got: ${issues.join('; ') || 'none'}`);
        }
      }
    } else {
      failures.push(`translation failed: ${issues.join('; ')}`);
    }
    return failures;
  }
  if (expected.expectIssues) failures.push('expected translation to fail but it produced output');
  return failures;
}

function checkPayload(failures: string[], payload: NonNullable<ReturnType<typeof hl7ToCanonical>['payload']>, expected: Hl7GoldenExpectation): void {
  if (expected.patient) {
    for (const [key, want] of Object.entries(expected.patient)) {
      if (want === undefined) continue;
      const got = payload.patient[key as keyof typeof payload.patient];
      if (got !== want) failures.push(`patient.${key}: expected "${want}", got "${got ?? ''}"`);
    }
  }
  if (expected.order) {
    for (const [key, want] of Object.entries(expected.order)) {
      if (key === 'tests' || want === undefined) continue;
      const got = payload.order[key as keyof typeof payload.order];
      if (got !== want) failures.push(`order.${key}: expected "${want}", got "${got ?? ''}"`);
    }
    const wantCodes = (expected.order.tests ?? []).map((t) => t.code).filter((c) => c !== undefined);
    const gotCodes = payload.order.tests.map((t) => t.code);
    for (const code of wantCodes) {
      if (!gotCodes.includes(code!)) failures.push(`order.tests: expected code "${code}" — got [${gotCodes.join(', ')}]`);
    }
  }
  if (expected.results) checkResults(failures, payload.results, expected.results);
}

function checkRegistration(failures: string[], order: OrderRegistration, expected: NonNullable<Hl7GoldenExpectation['registration']>): void {
  for (const [key, want] of Object.entries(expected)) {
    if (key === 'tests' || want === undefined) continue;
    const got = order[key as keyof OrderRegistration];
    if (got !== want) failures.push(`registration.${key}: expected "${want}", got "${got ?? ''}"`);
  }
  for (const code of expected.tests ?? []) {
    if (!order.tests.includes(code)) failures.push(`registration.tests: expected code "${code}" — got [${order.tests.join(', ')}]`);
  }
}

function checkResults(failures: string[], actual: LabPayload['results'], expected: NonNullable<Hl7GoldenExpectation['results']>): void {
  if (actual.length !== expected.length) {
    failures.push(`results: expected ${expected.length} result(s), got ${actual.length}`);
    return;
  }
  expected.forEach((want, i) => {
    const got = actual[i];
    if (!got) {
      failures.push(`results[${i}]: missing`);
      return;
    }
    for (const [key, value] of Object.entries(want)) {
      if (value === undefined) continue;
      const gotValue = got[key as keyof typeof got];
      if (gotValue !== value) {
        failures.push(`results[${i}].${key}: expected "${value}", got "${gotValue ?? ''}"`);
      }
    }
  });
}