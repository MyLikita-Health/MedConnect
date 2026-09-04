/**
 * A4 profile version stamping (runtime version enforcement): every message
 * parsed through a device binding is stamped with the profile id + version
 * that produced it, and flagged when that version no longer matches the
 * version the profile's goldens were recorded under (certifiedVersion) —
 * i.e. the profile was edited after certification. Stamping is an annotation,
 * never a parse failure: results flow, but provenance + drift are visible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { AstmGateway, type DriftEvent, type ProfileResolver, type ProfileBinding } from './gateway.js';
import { AstmClient, type AstmRecord } from '@integration-hub/astm';
import type { CanonicalMessage, DeviceRecordLayout, MappingTable } from '@integration-hub/shared';

const ACME_LAYOUT: DeviceRecordLayout = {
  patient: { id: 3, name: 4, dateOfBirth: 6, sex: 7 },
  order: { sampleId: 3, accession: 2, test: 4 },
  result: { test: 2, value: 3, unit: 4, referenceRange: 5, flag: 6, status: 8 },
};
const ACME_MAPPINGS: MappingTable = { GLU: 'GLUCOSE' };

const ACME_RECORDS: AstmRecord[] = [
  { type: 'H', fields: ['\\^&', '', '', '', 'ACME-1^ACME-1', '', '', '', '', '', '', 'P', '1', '20260903143000'] },
  { type: 'P', fields: ['1', '', 'PID-9001', 'Doe^John', '', '19900101', 'M'] },
  { type: 'O', fields: ['1', 'ACC-991001', 'S-48291', '^GLU^Glucose'] },
  { type: 'R', fields: ['1', '^GLU^Glucose', '95', 'mg/dL', '70-110', 'N', '', 'F'] },
  { type: 'L', fields: ['1', 'N'] },
];

function acmeBinding(profile?: { id: string; version: number }, certifiedVersion?: number): ProfileBinding {
  return { layout: ACME_LAYOUT, mappings: ACME_MAPPINGS, profile, certifiedVersion };
}

async function runThroughGateway(
  t: any,
  resolver?: ProfileResolver,
  onDrift?: (event: DriftEvent) => void,
): Promise<CanonicalMessage> {
  const received: CanonicalMessage[] = [];
  const gateway = new AstmGateway({
    host: '127.0.0.1',
    port: 0,
    sink: { record: (m) => void received.push(m) },
    resolveProfile: resolver,
    onDrift,
  });
  const { port } = await gateway.start();
  t.after(() => gateway.stop());

  const socket = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const client = new AstmClient(socket, { timeoutMs: 3000 });
  const result = await client.run(ACME_RECORDS);
  await once(socket, 'close');
  assert.equal(result.nakCount, 0);
  await waitFor(() => received.length >= 1, 'message recorded');
  return received[0]!;
}

test('a message parsed under the certified version is stamped clean (no drift)', async (t) => {
  const resolver: ProfileResolver = async () => acmeBinding({ id: 'acme-chem-200', version: 1 }, 1);
  const message = await runThroughGateway(t, resolver);

  assert.deepEqual(message.profile, { id: 'acme-chem-200', version: 1, certifiedVersion: 1, drift: false });
  assert.ok(!message.timeline.some((e) => e.stage === 'FLAGGED'), 'certified config must not flag');
});

test('a profile edited AFTER certification (stored v2 vs certified v1) flags drift on the wire', async (t) => {
  const resolver: ProfileResolver = async () => acmeBinding({ id: 'acme-chem-200', version: 2 }, 1);
  const message = await runThroughGateway(t, resolver);

  assert.equal(message.profile?.id, 'acme-chem-200');
  assert.equal(message.profile?.version, 2);
  assert.equal(message.profile?.certifiedVersion, 1);
  assert.equal(message.profile?.drift, true);
  const flag = message.timeline.find((e) => e.stage === 'FLAGGED');
  assert.ok(flag, 'drift must be annotated on the timeline');
  assert.match(flag?.note ?? '', /v2 drifted from its certified v1/);
  // Results still flow — drift is an annotation, not a silent drop or a hard fail.
  assert.equal(message.status, 'MAPPED');
  assert.equal(message.payload?.results?.[0]?.testCode, 'GLUCOSE');
});

test('a rollback below the certified version also flags drift', async (t) => {
  const resolver: ProfileResolver = async () => acmeBinding({ id: 'acme-chem-200', version: 1 }, 2);
  const message = await runThroughGateway(t, resolver);
  assert.equal(message.profile?.drift, true);
});

test('a bound profile with no recorded goldens stamps identity without a drift claim', async (t) => {
  const resolver: ProfileResolver = async () => acmeBinding({ id: 'my-custom-analyzer', version: 1 });
  const message = await runThroughGateway(t, resolver);
  assert.deepEqual(message.profile, { id: 'my-custom-analyzer', version: 1 });
  assert.equal(message.profile?.drift, undefined, 'no baseline → no drift claim');
});

test('an unbound device carries no profile stamp', async (t) => {
  const message = await runThroughGateway(t); // no resolver → reference defaults
  assert.equal(message.profile, undefined);
});

test('drifted deliveries emit onDrift(drift:true) naming both versions; clean deliveries emit drift:false', async (t) => {
  // Drifted (stored v2 vs certified v1): one event with profile identity.
  const drifted: DriftEvent[] = [];
  const resolver: ProfileResolver = async () => acmeBinding({ id: 'acme-chem-200', version: 2 }, 1);
  await runThroughGateway(t, resolver, (e) => void drifted.push(e));
  assert.equal(drifted.length, 1);
  assert.deepEqual(drifted[0], {
    deviceId: 'ACME-1',
    drift: true,
    profileId: 'acme-chem-200',
    version: 2,
    certifiedVersion: 1,
  });

  // Clean certified delivery: resolves the drift condition for the device.
  const clean: DriftEvent[] = [];
  await runThroughGateway(t, async () => acmeBinding({ id: 'acme-chem-200', version: 1 }, 1), (e) => void clean.push(e));
  assert.deepEqual(clean, [{ deviceId: 'ACME-1', drift: false }]);
});

test('unbound and no-goldens deliveries also emit drift:false (nothing to flag)', async (t) => {
  const unbound: DriftEvent[] = [];
  await runThroughGateway(t, undefined, (e) => void unbound.push(e));
  assert.deepEqual(unbound, [{ deviceId: 'ACME-1', drift: false }]);

  const noGoldens: DriftEvent[] = [];
  await runThroughGateway(t, async () => acmeBinding({ id: 'my-custom-analyzer', version: 1 }), (e) => void noGoldens.push(e));
  assert.deepEqual(noGoldens, [{ deviceId: 'ACME-1', drift: false }]);
});

test('replay preserves the original profile provenance', async (t) => {
  const received: CanonicalMessage[] = [];
  const gateway = new AstmGateway({
    host: '127.0.0.1',
    port: 0,
    sink: { record: (m) => void received.push(m) },
    resolveProfile: async () => acmeBinding({ id: 'acme-chem-200', version: 2 }, 1),
  });
  const { port } = await gateway.start();
  t.after(() => gateway.stop());

  const socket = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const client = new AstmClient(socket, { timeoutMs: 3000 });
  await client.run(ACME_RECORDS);
  await once(socket, 'close');
  await waitFor(() => received.length >= 1, 'message recorded');

  const original = received[0]!;
  const replayed = await gateway.replay(original);
  assert.equal(replayed.profile?.id, original.profile?.id);
  assert.equal(replayed.profile?.version, original.profile?.version);
  assert.equal(replayed.profile?.drift, original.profile?.drift);
});

async function waitFor(pred: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
