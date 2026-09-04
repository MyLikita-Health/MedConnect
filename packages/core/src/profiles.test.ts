import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayoutFor, type DeviceProfile } from '@integration-hub/shared';
import { ACME_CHEM_200_PROFILE, InMemoryProfileStore, REFERENCE_PROFILE, parseDeviceProfile } from './profiles.js';
import { runConformance } from './conformance.js';

const VALID: DeviceProfile = {
  id: 'test-analyzer',
  name: 'Test Analyzer',
  manufacturer: 'Acme',
  model: 'X1',
  protocol: 'ASTM',
  transport: 'tcp',
  version: 1,
  layout: {
    patient: { id: 3, name: 4, dateOfBirth: 6, sex: 7 },
    order: { sampleId: 2, accession: 3, test: 4 },
    result: { test: 2, value: 3, unit: 4, referenceRange: 5, flag: 6, status: 8 },
  },
  mappings: { GLU: 'GLUCOSE' },
  capabilities: ['results-up', 'host-query'],
  status: 'draft',
};

test('parseDeviceProfile accepts a valid profile and fills defaults', () => {
  const parsed = parseDeviceProfile({ ...VALID, version: 2 });
  assert.equal(parsed.id, 'test-analyzer');
  assert.equal(parsed.version, 2);
  assert.equal(parsed.protocol, 'ASTM');
  assert.equal(parsed.transport, 'tcp');
  assert.equal(parsed.status, 'draft');
});

test('parseDeviceProfile rejects invalid layouts and slugs', () => {
  assert.throws(() => parseDeviceProfile({ ...VALID, layout: { order: { accession: 0, test: 4 } } }));
  assert.throws(() => parseDeviceProfile({ ...VALID, id: 'Has Spaces' }));
  assert.throws(() => parseDeviceProfile({ ...VALID, transport: 'carrier-pigeon' }));
  assert.throws(() => parseDeviceProfile({ ...VALID, capabilities: ['results-up', 'bogus'] }));
  assert.throws(() => parseDeviceProfile({ ...VALID, session: { initiator: 'hub' } }));
});

test('shipped seed profiles are valid', () => {
  assert.doesNotThrow(() => parseDeviceProfile(REFERENCE_PROFILE));
  assert.doesNotThrow(() => parseDeviceProfile(ACME_CHEM_200_PROFILE));
  assert.equal(ACME_CHEM_200_PROFILE.status, 'certified');
});

test('InMemoryProfileStore validates on upsert and round-trips', async () => {
  const store = new InMemoryProfileStore();
  await store.upsert(VALID);
  const got = await store.get('test-analyzer');
  assert.equal(got?.manufacturer, 'Acme');
  assert.equal(got?.version, 1);
  await assert.rejects(() => store.upsert({ ...VALID, id: 'Bad id' } as DeviceProfile));
  assert.equal((await store.list()).length, 1);
  await store.remove('test-analyzer');
  assert.equal(await store.get('test-analyzer'), undefined);
});

test('defaultLayoutFor fills missing groups from the reference layout', () => {
  const layout = defaultLayoutFor({ layout: { result: { test: 2, value: 3 } } });
  assert.equal(layout.patient?.id, 3);
  assert.equal(layout.order?.accession, 3);
  assert.equal(layout.result?.value, 3);
});

test('runConformance reports pass/fail per golden case', () => {
  const run = runConformance(
    { ...VALID, mappings: { GLU: 'GLUCOSE' } },
    [
      {
        name: 'ok',
        records: [
          { type: 'P', fields: ['1', '', 'PID-1', 'Doe^Jane', '', '19900101', 'F'] },
          { type: 'O', fields: ['1', 'S-1', 'ACC-1', '^GLU^Glucose'] },
          { type: 'R', fields: ['1', '^GLU^Glucose', '95', 'mg/dL', '70-110', 'N', '', 'F'] },
        ],
        expected: {
          patient: { id: 'PID-1', name: 'Doe, Jane' },
          order: { id: 'ACC-1', sampleId: 'S-1' },
          results: [{ testCode: 'GLUCOSE', originalTestCode: 'GLU', value: '95' }],
        },
      },
      {
        name: 'wrong order id',
        records: [
          { type: 'P', fields: ['1', '', 'PID-1', 'Doe^Jane', '', '19900101', 'F'] },
          { type: 'O', fields: ['1', 'S-1', 'ACC-WRONG', '^GLU^Glucose'] },
          { type: 'R', fields: ['1', '^GLU^Glucose', '95', 'mg/dL', '70-110', 'N', '', 'F'] },
        ],
        expected: { order: { id: 'ACC-1' } },
      },
    ],
  );
  assert.equal(run.profileId, 'test-analyzer');
  assert.equal(run.passed, 1);
  assert.equal(run.failed, 1);
  assert.equal(run.cases[0]!.pass, true);
  assert.equal(run.cases[1]!.pass, false);
  assert.match(run.cases[1]!.failures[0]!, /order.id/);
});