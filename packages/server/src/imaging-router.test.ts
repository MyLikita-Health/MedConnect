/**
 * M3.3 storage routing — wired through the REAL startHub: when Orthanc is
 * configured the MWL monitor's performed studies are routed by a second,
 * gate-free Dispatcher (no lab matching/validation) over the same store +
 * route rules — dedup → DB-driven destinations → ROUTED, or retry → DLQ.
 * Pixels never enter the hub: the routed message carries the canonical study
 * metadata in its `imaging` field (storage URLs point back at Orthanc).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CanonicalMessage } from '@integration-hub/shared';
import { startHub } from './index.js';
import type { Hub } from './index.js';
import { buildStudyMessage } from './imaging-router.js';
import { startMockOrthanc } from './mock-orthanc.js';

const iso = (): string => new Date().toISOString();

async function startHubWithOrthanc(t: any, baseUrl: string): Promise<Hub> {
  const hub = await startHub({
    authDisabled: true,
    devicePort: 0,
    httpPort: 0,
    seedDefaultAlerts: false,
    orthanc: { baseUrl, pollMs: 60_000 },
  });
  t.after(() => hub.stop());
  return hub;
}

async function waitFor(pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** Put one order on the (mock) worklist and mark its study performed. */
async function performStudy(hub: Hub, orthanc: Awaited<ReturnType<typeof startMockOrthanc>>, accession: string): Promise<void> {
  await hub.orders.register({ id: accession, patientId: `P-${accession}`, tests: ['GLUCOSE'], status: 'active', receivedAt: iso() });
  const first = await hub.mwl!.poll();
  assert.equal(first?.created.length, 1, `order ${accession} synced`);
  orthanc.performed.add(accession);
  const poll = await hub.mwl!.poll();
  assert.equal(poll?.performed.length, 1, `study ${accession} performed`);
}

test('a performed study is routed as an imaging message and ROUTED via the built-in console', async (t) => {
  const orthanc = await startMockOrthanc();
  t.after(() => orthanc.close());
  const hub = await startHubWithOrthanc(t, orthanc.base);
  assert.ok(hub.imaging, 'hub.imaging present with Orthanc configured');

  await performStudy(hub, orthanc, 'ACC-401');

  const messages = await hub.store.list({ deviceId: 'orthanc' });
  assert.equal(messages.length, 1);
  const message = messages[0]!;
  assert.equal(message.imaging?.accession, 'ACC-401');
  assert.equal(message.imaging?.kind, 'imaging');
  assert.equal(message.imaging?.study.accessionNumber, 'ACC-401');
  // Metadata only — the pixel pointer stays in Orthanc.
  assert.match(message.imaging!.study.storageUrl, /\/studies\/study-ACC-401\/archive$/);
  await waitFor(async () => (await hub.store.list({ deviceId: 'orthanc' }))[0]?.status === 'ROUTED', 'imaging message ROUTED');
});

test('re-observing the same study dedups (stable raw) instead of double-routing', async (t) => {
  const orthanc = await startMockOrthanc();
  t.after(() => orthanc.close());
  const hub = await startHubWithOrthanc(t, orthanc.base);
  const performed = {
    order: { accession: 'ACC-402', patientId: 'P-1' },
    study: {
      orthancId: 'study-ACC-402',
      patientOrthancId: 'pat-1',
      accessionNumber: 'ACC-402',
      studyInstanceUid: '1.2.840.402',
      series: [],
      storageUrl: `${orthanc.base}/studies/study-ACC-402/archive`,
    },
  };
  const message = buildStudyMessage(performed);
  assert.equal(message.raw, `ORTHANC study 1.2.840.402 accession ACC-402 performed`, 'raw is stable per study');

  // The router + dispatcher: a repeated observation of the same study dedups.
  await hub.imaging!.routePerformed([performed]);
  await hub.imaging!.routePerformed([performed]);

  const messages = await hub.store.list({ deviceId: 'orthanc' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.status, 'DUPLICATE', 'second observation of the same study dedups');
  assert.equal(messages[0]!.duplicateOf, messages[1]!.id);
});

test('DB-driven route rules deliver imaging messages to an http destination', async (t) => {
  const orthanc = await startMockOrthanc();
  t.after(() => orthanc.close());
  const hub = await startHubWithOrthanc(t, orthanc.base);

  // The archive webhook: any rule matching imaging messages (device orthanc).
  const received: CanonicalMessage[] = [];
  const webhook = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as CanonicalMessage);
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => webhook.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => webhook.close(() => resolve())));

  await hub.routes.upsertDestination({
    id: 'archive-webhook',
    kind: 'http',
    name: 'Archive webhook',
    url: `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/studies`,
    enabled: true,
    retry: { maxAttempts: 2, backoffMs: 10, backoffFactor: 1, jitter: false },
  });
  await hub.routes.upsertRule({ id: 'imaging-archive', destinationId: 'archive-webhook', deviceId: 'orthanc', priority: 1, enabled: true });

  await performStudy(hub, orthanc, 'ACC-403');
  await waitFor(() => received.length === 1, 'webhook received the imaging message');
  assert.equal(received[0]!.imaging?.accession, 'ACC-403');
  assert.equal(received[0]!.imaging?.study.studyDescription, 'CT CHEST — performed');
  await waitFor(async () => (await hub.store.list({ deviceId: 'orthanc' }))[0]?.status === 'ROUTED', 'ROUTED after webhook 200');
});

test('an hl7 destination on an imaging message fails into the DLQ (no HL7 v2 form)', async (t) => {
  const orthanc = await startMockOrthanc();
  t.after(() => orthanc.close());
  const hub = await startHubWithOrthanc(t, orthanc.base);

  await hub.routes.upsertDestination({
    id: 'lis',
    kind: 'hl7',
    name: 'LIS over MLLP',
    hl7: { host: '127.0.0.1', port: 1 },
    enabled: true,
    retry: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitter: false },
  });
  await hub.routes.upsertRule({ id: 'img-to-lis', destinationId: 'lis', deviceId: 'orthanc', priority: 1, enabled: true });

  await performStudy(hub, orthanc, 'ACC-404');
  await waitFor(async () => (await hub.store.list({ deviceId: 'orthanc' }))[0]?.status === 'FAILED', 'imaging → hl7 DLQs');
  const failed = (await hub.store.list({ deviceId: 'orthanc' }))[0]!;
  assert.ok(failed.dlqAt, 'message entered the dead-letter queue');
  assert.match(failed.errors.join(' ') + failed.timeline.map((e) => e.note ?? '').join(' '), /unknown destination kind|hl7/i);
});
