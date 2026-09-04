/**
 * Golden ↔ simulator lockstep (workstream K): the recorded B4 vendor-variant
 * transcripts in the golden library must be byte-reproducible by
 * `buildVariantMessage` under the file's frozen fixture parameters. When the
 * simulator's transcript shape changes (a bug fix, a new deviation), this
 * test fails and the corpus must be re-recorded — the golden file stays the
 * authoritative contract, the simulator stays its live echo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHl7Goldens } from '@integration-hub/hl7';
import { buildVariantMessage, type VariantKind, type VariantName } from './hl7-variant.js';

test('recorded vendor-variant goldens are reproducible by the simulator (no drift)', async () => {
  const files = await loadHl7Goldens();
  const golden = files.find((f) => f.golden.name.includes('vendor-variant'))?.golden;
  assert.ok(golden, 'expected the B4 vendor-variant golden file in the library');

  const fixtures = (golden as unknown as { fixtures: Record<string, { timestamp: string; controlId: string }> }).fixtures;
  assert.ok(fixtures, 'golden file must carry its frozen fixture parameters');
  const recordedWires = golden.goldens.map((g) => g.wire.join('\r'));

  for (const [key, fx] of Object.entries(fixtures)) {
    const [kind, variant] = key.split(':') as [VariantKind, VariantName];
    const rebuilt = buildVariantMessage(kind, variant, { deviceName: 'SIM-HL7', timestamp: fx.timestamp, controlId: fx.controlId });
    assert.ok(
      recordedWires.includes(rebuilt),
      `${key}: simulator output drifted from the recorded transcript — re-record the golden corpus`,
    );
  }
});