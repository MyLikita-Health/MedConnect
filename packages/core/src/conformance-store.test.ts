/**
 * Stored-profile conformance (console certification view): loads the golden
 * file that records a profile (matched by the file's EMBEDDED profile id —
 * astm-reference lives in reference.json) and re-runs the profile's current
 * config against those recorded transcripts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStoredConformance, loadGoldenForProfile, REFERENCE_PROFILE, ACME_CHEM_200_PROFILE } from './index.js';
import type { DeviceProfile } from '@integration-hub/shared';

const goldensDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'goldens');
// Minimal draft profile with no recorded goldens.
const NO_GOLDENS_PROFILE: DeviceProfile = {
  id: 'my-analyzer',
  name: 'My Analyzer',
  manufacturer: 'X',
  model: 'Y',
  protocol: 'ASTM',
  transport: 'tcp',
  version: 1,
  layout: {},
  status: 'draft',
};

test('loadGoldenForProfile finds golden files by embedded profile id', async () => {
  // reference.json embeds profile id 'astm-reference' — filename differs.
  const found = await loadGoldenForProfile('astm-reference', goldensDir);
  assert.ok(found);
  assert.equal(found!.file, 'reference.json');
  assert.equal(found!.golden.profile.id, 'astm-reference');

  const acme = await loadGoldenForProfile('acme-chem-200', goldensDir);
  assert.equal(acme?.file, 'acme-chem-200.json');
  assert.equal(await loadGoldenForProfile('no-such-profile', goldensDir), undefined);
});

test('runStoredConformance passes certified profiles and reports drift', async () => {
  const ref = await runStoredConformance(REFERENCE_PROFILE, goldensDir);
  assert.equal(ref.available, true);
  assert.equal(ref.goldenFile, 'reference.json');
  assert.ok(ref.run && ref.run.failed === 0 && ref.run.cases.length >= 1, 'reference passes its goldens');

  const acme = await runStoredConformance(ACME_CHEM_200_PROFILE, goldensDir);
  assert.equal(acme.available, true);
  assert.ok(acme.run && acme.run.failed === 0, 'acme passes under its own profile');

  // A profile without recorded goldens reports unavailable (not a failure).
  const none = await runStoredConformance(NO_GOLDENS_PROFILE, goldensDir);
  assert.equal(none.available, false);
  assert.match(none.reason ?? '', /no recorded goldens/);
});

test('an edited profile that no longer matches its transcripts fails conformance', async () => {
  const edited = { ...ACME_CHEM_200_PROFILE, layout: { ...ACME_CHEM_200_PROFILE.layout } } as typeof ACME_CHEM_200_PROFILE;
  // Revert the Acme O record to the reference positions → its own transcripts
  // (recorded for the swapped layout) now mis-associate.
  edited.layout = {
    patient: ACME_CHEM_200_PROFILE.layout.patient,
    order: { sampleId: 2, accession: 3, test: 4 },
    result: ACME_CHEM_200_PROFILE.layout.result,
  };
  const run = await runStoredConformance(edited, goldensDir);
  assert.equal(run.available, true);
  assert.ok(run.run && run.run.failed > 0, 'an edited-away layout must fail its recorded transcripts');
});
