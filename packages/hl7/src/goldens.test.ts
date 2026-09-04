/**
 * HL7 golden corpus — the layout-based conformance oracle as the CI gate
 * (plan §13.15; workstream K). Every `protocol: "HL7"` file in the shared
 * golden library is executed: each recorded transcript must produce its
 * expected canonical payload under its B4 layout (or fail with the expected
 * issues). npm test runs this file, so a drift in the translators or a bad
 * profile edit fails the build — the same gate the ASTM goldens give core.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHl7Goldens, runHl7Conformance } from './conformance.js';

test('HL7 golden corpus passes the layout-based conformance oracle', async () => {
  const files = await loadHl7Goldens();
  assert.ok(files.length >= 1, 'expected at least one HL7 golden file in the library');

  const runs = files.map(({ file, golden }) => runHl7Conformance(file, golden));
  const failures = runs.flatMap((r) =>
    r.cases.filter((c) => !c.pass).map((c) => `${r.file} → ${c.name}: ${c.failures.join('; ')}`),
  );
  assert.deepEqual(failures, [], `every HL7 golden must pass (${runs.reduce((n, r) => n + r.cases.length, 0)} case(s) run)`);
});