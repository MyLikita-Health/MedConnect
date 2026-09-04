/**
 * Golden-message conformance in CI (plan workstream K; PRD §26, §56).
 *
 * Loads every `goldens/*.json` file, validates the embedded profile, and runs
 * the golden cases through canonicalization. A certified profile claim is only
 * as good as its recorded conformance run — this suite is that run, and it
 * executes on every `npm test` / `npm run test:db`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviceProfile, runConformance, type GoldenFile } from './index.js';
import type { DeviceProfile } from '@integration-hub/shared';

const goldensDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'goldens');

test('every golden file passes conformance for its profile (certification gate)', async () => {
  const files = (await readdir(goldensDir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 1, 'goldens directory must not be empty');

  for (const file of files.sort()) {
    const parsed = JSON.parse(await readFile(join(goldensDir, file), 'utf8')) as { profile?: unknown };
    // The library is protocol-mixed: HL7 golden files (protocol: "HL7") carry
    // no ASTM profile and run through the HL7 conformance suite instead.
    if (!parsed.profile) continue;
    const profile: DeviceProfile = parseDeviceProfile(parsed.profile);
    const run = runConformance(profile, (parsed as GoldenFile).goldens);
    assert.equal(run.failed, 0, `${file}: ${describeFailures(run)}`);
    // A file with goldens must claim at least draft; certified is the goal.
    assert.ok(['draft', 'certified'].includes(profile.status), `${file}: invalid status`);
  }
});

test('a golden transcript does NOT pass under the wrong profile (profiles matter)', async () => {
  const acme = JSON.parse(await readFile(join(goldensDir, 'acme-chem-200.json'), 'utf8')) as GoldenFile;
  const reference = JSON.parse(await readFile(join(goldensDir, 'reference.json'), 'utf8')) as GoldenFile;
  const wrongProfile = parseDeviceProfile(reference.profile);
  const run = runConformance(wrongProfile, acme.goldens);
  assert.ok(run.failed > 0, 'acme transcripts must fail under the generic reference profile');
  // The accession/sample-id swap is exactly what must be caught.
  const message = JSON.stringify(run.cases.map((c) => c.failures));
  assert.match(message, /order\.(id|sampleId)/);
});

function describeFailures(run: ReturnType<typeof runConformance>): string {
  return run.cases
    .filter((c) => !c.pass)
    .map((c) => `${c.name}: ${c.failures.join('; ')}`)
    .join(' | ');
}