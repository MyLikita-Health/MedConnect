/**
 * M3 C6 modality health — wired through the REAL startHub: when an orthanc
 * config is present the hub exposes `hub.modalities`, whose standing C-ECHO
 * loop mirrors the modalities Orthanc has configured into the device registry
 * (one DICOM row per modality) and the device-offline alerting. A mock
 * Orthanc HTTP server answers GET /modalities and POST /modalities/{name}/echo
 * so tests assert both the exact health transitions and the registry state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from './index.js';
import type { Hub } from './index.js';
import { startMockOrthanc } from './mock-orthanc.js';

async function startHubWithOrthanc(t: any, baseUrl: string): Promise<Hub> {
  const hub = await startHub({
    authDisabled: true,
    devicePort: 0,
    httpPort: 0,
    seedDefaultAlerts: false,
    orthanc: { baseUrl, pollMs: 60_000, modalityPollMs: 60_000 },
  });
  t.after(() => hub.stop());
  return hub;
}

test('no orthanc config → the hub has no modality monitor', async (t) => {
  const hub = await startHub({ authDisabled: true, devicePort: 0, httpPort: 0, seedDefaultAlerts: false });
  t.after(() => hub.stop());
  assert.equal(hub.modalities, undefined);
});

test('configured modalities surface as DICOM devices; failures fire device-offline; config removal drops the row', async (t) => {
  const orthanc = await startMockOrthanc();
  t.after(() => orthanc.close());
  const hub = await startHubWithOrthanc(t, orthanc.base);
  assert.ok(hub.modalities, 'orthanc config wires the modality monitor');
  // startHubWithOrthanc skips the default seeds — bring the device-offline rule.
  await hub.alertStore.upsertRule({ id: 'dev-off', kind: 'device-offline', name: 'Device offline', threshold: 1, channels: ['console'], enabled: true });

  orthanc.modalities = ['CT1', 'MR1'];
  let states = await hub.modalities!.poll(); // settle boot tick + echo both
  assert.equal(states?.length, 2);
  assert.ok(states!.every((s) => s.state === 'connected'));

  let list = await hub.devices.list();
  const ct1 = list.find((d) => d.id === 'CT1');
  assert.ok(ct1, 'each configured modality is auto-registered as a device');
  assert.equal(ct1!.name, 'CT1');
  assert.equal(ct1!.protocol, 'DICOM');
  assert.equal(ct1!.transport, 'tcp');
  assert.equal(ct1!.state, 'connected');
  assert.ok(ct1!.autoRegistered);
  assert.ok(ct1!.lastSeen);
  assert.ok(list.find((d) => d.id === 'MR1'), 'second modality row present too');

  // MR1's C-ECHO starts failing → disconnected row + a device-offline alert
  // (subject = the modality name, exactly like a wire device going offline).
  orthanc.echoFail.add('MR1');
  states = await hub.modalities!.poll();
  assert.equal(states?.find((s) => s.name === 'CT1')?.state, 'connected');
  assert.equal(states?.find((s) => s.name === 'MR1')?.state, 'disconnected');
  assert.equal((await hub.devices.list()).find((d) => d.id === 'MR1')?.state, 'disconnected');
  let firing = await hub.alertStore.listAlerts({ firing: true });
  assert.equal(firing.length, 1);
  assert.equal(firing[0]!.kind, 'device-offline');
  assert.equal(firing[0]!.subject, 'MR1');

  // A still-failing tick does not duplicate the open alert.
  await hub.modalities!.poll();
  assert.equal((await hub.alertStore.listAlerts({ firing: true })).length, 1);

  // Recovery → connected again and the alert resolves.
  orthanc.echoFail.delete('MR1');
  states = await hub.modalities!.poll();
  assert.equal(states?.find((s) => s.name === 'MR1')?.state, 'connected');
  assert.equal((await hub.devices.list()).find((d) => d.id === 'MR1')?.state, 'connected');
  assert.equal((await hub.alertStore.listAlerts({ firing: true })).length, 0);

  // The modality is removed from Orthanc's config → its row is dropped while
  // still-configured rows (and the orthanc row itself) stay.
  orthanc.modalities = ['CT1'];
  await hub.modalities!.poll();
  list = await hub.devices.list();
  assert.ok(list.find((d) => d.id === 'CT1'));
  assert.equal(list.find((d) => d.id === 'MR1'), undefined);
});

test('an unreachable Orthanc leaves last-known modality rows untouched and records lastError', async (t) => {
  const orthanc = await startMockOrthanc();
  t.after(() => orthanc.close());
  orthanc.modalities = ['CT1'];
  const hub = await startHubWithOrthanc(t, orthanc.base);

  await hub.modalities!.poll(); // CT1 up
  assert.equal((await hub.devices.list()).find((d) => d.id === 'CT1')?.state, 'connected');

  orthanc.down = true; // the list call itself fails — nothing is reported
  const states = await hub.modalities!.poll();
  assert.equal(states, undefined);
  assert.match(hub.modalities!.status().lastError ?? '', /500|failed/i);
  assert.equal((await hub.devices.list()).find((d) => d.id === 'CT1')?.state, 'connected', 'last-known state is preserved');
});
