/**
 * Golden-message conformance harness (plan workstream K; PRD §26, §56).
 *
 * A golden is a recorded device transcript (protocol records) paired with the
 * canonical payload it MUST produce under a specific profile. A profile only
 * ships certified after its goldens pass — that is the recorded conformance
 * run behind the "certified device profile" claim. Goldens live in
 * `goldens/*.json` and are executed as a CI test suite (`goldens.test.ts`).
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { astmToCanonical } from '@integration-hub/gateway';
import type { DeviceProfile, LabPayload, ParsedRecord } from '@integration-hub/shared';
import { defaultLayoutFor } from '@integration-hub/shared';

/** Expected canonical content for a golden; partial comparison per record. */
export interface GoldenExpectation {
  patient?: { id?: string; name?: string; dateOfBirth?: string; gender?: string };
  order?: { id?: string; sampleId?: string; tests?: Array<{ code?: string; name?: string }> };
  results?: Array<{
    testCode?: string;
    originalTestCode?: string;
    testName?: string;
    value?: string;
    unit?: string;
    referenceRange?: string;
    flag?: string;
  }>;
  /** Golden must FAIL canonicalization with at least these issues. */
  expectIssues?: string[];
}

export interface GoldenCase {
  name: string;
  /** Protocol records exactly as parsed from the wire (H/P/O/R/L...). */
  records: ParsedRecord[];
  expected: GoldenExpectation;
}

export interface GoldenFile {
  /** The profile under test (embedded so each file is self-contained). */
  profile: DeviceProfile;
  goldens: GoldenCase[];
}

export interface ConformanceCaseResult {
  name: string;
  pass: boolean;
  failures: string[];
}

export interface ConformanceRunResult {
  profileId: string;
  profileVersion: number;
  /** ISO timestamp of the run. */
  ranAt: string;
  cases: ConformanceCaseResult[];
  passed: number;
  failed: number;
}

/**
 * Location of the recorded golden library: HUB_GOLDENS_DIR when set, else
 * the repo's `goldens/` directory (resolved from this module, so it works in
 * the Docker image too where goldens/ is copied alongside packages/).
 */
export function goldensDir(): string {
  return process.env.HUB_GOLDENS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'goldens');
}

export interface StoredConformanceResult {
  /** False when no golden file records this profile (nothing to run). */
  available: boolean;
  profileId: string;
  /** Golden library file the profile's record lives in (e.g. reference.json). */
  goldenFile?: string;
  run?: ConformanceRunResult;
  reason?: string;
}

/**
 * Load the golden file that records `profileId` (golden files embed the
 * profile, so the lookup matches embedded profile.id — the reference profile
 * lives in reference.json even though its id is astm-reference).
 */
export async function loadGoldenForProfile(
  profileId: string,
  dir = goldensDir(),
): Promise<{ file: string; golden: GoldenFile } | undefined> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  for (const file of files.sort()) {
    const golden = JSON.parse(await readFile(join(dir, file), 'utf8')) as GoldenFile;
    if (golden.profile.id === profileId) return { file, golden };
  }
  return undefined;
}

/**
 * Re-run a stored profile against its recorded goldens (the console's
 * per-profile certification view). Uses the profile's CURRENT config — an
 * edited profile that no longer passes its recorded transcript shows up as
 * failed here, which is exactly the drift a console should surface.
 */
export async function runStoredConformance(profile: DeviceProfile, dir = goldensDir()): Promise<StoredConformanceResult> {
  const found = await loadGoldenForProfile(profile.id, dir);
  if (!found) {
    return { available: false, profileId: profile.id, reason: 'no recorded goldens for this profile' };
  }
  const run = runConformance(profile, found.golden.goldens);
  return { available: true, profileId: profile.id, goldenFile: found.file, run };
}

/**
 * Run every golden for a profile through the canonicalization pipeline and
 * compare against the expected payload. Any mismatch or unexpected failure is
 * reported; `allPass` is true only when every case passes.
 */
export function runConformance(profile: DeviceProfile, goldens: GoldenCase[]): ConformanceRunResult {
  const layout = defaultLayoutFor(profile);
  const cases: ConformanceCaseResult[] = goldens.map((golden) => ({
    name: golden.name,
    pass: false,
    failures: checkGolden(profile, layout, golden),
  }));

  let passed = 0;
  for (const c of cases) {
    if (c.failures.length === 0) {
      c.pass = true;
      passed++;
    }
  }

  return {
    profileId: profile.id,
    profileVersion: profile.version,
    ranAt: new Date().toISOString(),
    cases,
    passed,
    failed: cases.length - passed,
  };
}

function checkGolden(
  profile: DeviceProfile,
  layout: DeviceProfile['layout'],
  golden: GoldenCase,
): string[] {
  const { payload, issues } = astmToCanonical(golden.records, { mappings: profile.mappings, layout });
  const failures: string[] = [];
  const expected = golden.expected;

  if (expected.expectIssues) {
    if (payload !== null) {
      failures.push('expected canonicalization to fail but it produced a payload');
    }
    for (const issue of expected.expectIssues) {
      if (!issues.some((i) => i.includes(issue))) {
        failures.push(`expected issue "${issue}" — got: ${issues.join('; ') || 'none'}`);
      }
    }
    return failures;
  }

  if (!payload) {
    failures.push(`canonicalization failed: ${issues.join('; ')}`);
    return failures;
  }

  if (expected.patient) checkPatient(failures, payload.patient, expected.patient);
  if (expected.order) checkOrder(failures, payload.order, expected.order);
  if (expected.results) checkResults(failures, payload.results, expected.results);
  return failures;
}

function checkPatient(failures: string[], actual: LabPayload['patient'], expected: NonNullable<GoldenExpectation['patient']>): void {
  for (const [key, want] of Object.entries(expected)) {
    if (want === undefined) continue;
    const got = actual[key as keyof typeof actual];
    if (got !== want) failures.push(`patient.${key}: expected "${want}", got "${got ?? ''}"`);
  }
}

function checkOrder(failures: string[], actual: LabPayload['order'], expected: NonNullable<GoldenExpectation['order']>): void {
  for (const [key, want] of Object.entries(expected)) {
    if (key === 'tests') continue;
    if (want === undefined) continue;
    const got = actual[key as keyof typeof actual];
    if (got !== want) failures.push(`order.${key}: expected "${want}", got "${got ?? ''}"`);
  }
  if (expected.tests && expected.tests.length > 0) {
    const expectedCodes = expected.tests.map((t) => t.code).filter((c) => c !== undefined);
    const actualCodes = actual.tests.map((t) => t.code);
    for (const code of expectedCodes) {
      if (!actualCodes.includes(code!)) {
        failures.push(`order.tests: expected code "${code}" — got [${actualCodes.join(', ')}]`);
      }
    }
  }
}

function checkResults(failures: string[], actual: LabPayload['results'], expected: NonNullable<GoldenExpectation['results']>): void {
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