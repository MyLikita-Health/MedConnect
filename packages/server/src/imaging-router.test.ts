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
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { CanonicalMessage } from '@integration-hub/shared';
import { MllpDecoder, wrapMessage } from '@integration-hub/hl7';
import { startHub } from './index.js';
import type { Hub } from './index.js';
import { buildStudyMessage } from './imaging-router.js';
import { startMockOrthanc } from './mock-orthanc.js';

// Server integration tests are designed for in-memory stores. Explicitly
// unset DATABASE_URL so startHub() never silently flips into PG mode.
delete process.env.DATABASE_URL;

const iso = (): string => new Date().toISOString();

async function startHubWithOrthanc(t: any, baseUrl: string, extra: Partial<Parameters<typeof startHub>[0]> = {}): Promise<Hub> {
  const hub = await startHub({
    authDisabled: true,
    devicePort: 0,
    httpPort: 0,
    seedDefaultAlerts: false,
    orthanc: { baseUrl, pollMs: 60_000 },
    ...extra,
  });
  t.after(() => hub.stop());
  return hub;
}

/** The ORM^O01 order feed (B2c LIS seam) — its order id doubles as the accession. */
const ORM = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORM^O01|ORD-9|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'ORC|NW|PL-77|ACC-500|GLU^Glucose',
  'OBR|1|PL-77|ACC-500|GLU^Glucose',
].join('\r');

function connect(port: number): Promise<{ socket: net.Socket; acks: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const acks: string[] = [];
      const decoder = new MllpDecoder({ onMessage: (p) => void acks.push(p) });
      socket.on('data', (c: Buffer) => decoder.feed(c));
      resolve({ socket, acks });
    });
    socket.once('error', reject);
  });
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

test('M3.4 replay: a dead-lettered study retries through the API and routes once the rule is fixed', async (t) => {
  const orthanc = await startMockOrthanc();
  t.after(() => orthanc.close());
  const hub = await startHubWithOrthanc(t, orthanc.base);

  // A misconfigured rule DLQs the study (hl7 has no imaging form)…
  await hub.routes.upsertDestination({
    id: 'lis',
    kind: 'hl7',
    name: 'LIS over MLLP',
    hl7: { host: '127.0.0.1', port: 1 },
    enabled: true,
    retry: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitter: false },
  });
  await hub.routes.upsertRule({ id: 'img-to-lis', destinationId: 'lis', deviceId: 'orthanc', priority: 1, enabled: true });

  await performStudy(hub, orthanc, 'ACC-405');
  await waitFor(async () => (await hub.store.list({ deviceId: 'orthanc' }))[0]?.status === 'FAILED', 'study DLQs');
  const failed = (await hub.store.list({ deviceId: 'orthanc' }))[0]!;
  assert.ok(failed.dlqAt);

  // … the operator fixes routing (webhook now receives imaging events)…
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
  await hub.routes.deleteRule('img-to-lis');
  await hub.routes.upsertDestination({
    id: 'archive-webhook',
    kind: 'http',
    name: 'Archive webhook',
    url: `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/studies`,
    enabled: true,
    retry: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitter: false },
  });
  await hub.routes.upsertRule({ id: 'img-archive', destinationId: 'archive-webhook', deviceId: 'orthanc', priority: 1, enabled: true });

  // … and replays the failed study through the API — it routes under the
  // CURRENT rules (no dedup wall, no re-canonicalization needed).
  const res = await fetch(`http://127.0.0.1:${hub.ports.http}/api/v1/messages/${failed.id}/retry`, { method: 'POST' });
  assert.equal(res.status, 200, `retry accepted (${await res.text()})`);
  await waitFor(() => received.length === 1, 'the retried study reaches the webhook');
  assert.equal(received[0]!.imaging?.accession, 'ACC-405');
  await waitFor(async () => (await hub.store.list({ deviceId: 'orthanc' }))[0]?.status === 'ROUTED', 'retried study ROUTED');
  const routed = (await hub.store.list({ deviceId: 'orthanc' }))[0]!;
  assert.equal(routed.dlqAt, undefined, 'the DLQ marker is cleared');
  assert.ok(routed.timeline.some((e) => e.note?.includes('retried from the DLQ')));

  // Retrying a message that is not dead-lettered is a 409, unknown id a 404.
  const notDlq = await fetch(`http://127.0.0.1:${hub.ports.http}/api/v1/messages/${routed.id}/retry`, { method: 'POST' });
  assert.equal(notDlq.status, 409);
  const missing = await fetch(`http://127.0.0.1:${hub.ports.http}/api/v1/messages/ghost/retry`, { method: 'POST' });
  assert.equal(missing.status, 404);
});

test('full chain: an ORM order over MLLP syncs to the worklist; the performed study flows back as a routed hub message', async (t) => {
  // Real startHub: MLLP gateway (B2c orders feed) + the MWL monitor + the
  // imaging dispatcher. Nothing is registered programmatically — the LIS
  // order arrives over the wire and everything downstream is the wiring.
  const orthanc = await startMockOrthanc();
  t.after(() => orthanc.close());
  const hub = await startHubWithOrthanc(t, orthanc.base, { hl7Port: 0 });

  const { socket, acks } = await connect(hub.ports.hl7!);
  t.after(() => socket.destroy());
  socket.write(wrapMessage(ORM));
  await waitFor(() => acks.length >= 1, 'ORM AA ack');
  await waitFor(async () => (await hub.orders.list()).length === 1, 'ORM registered the expected order');
  const [order] = await hub.orders.list();
  assert.equal(order!.id, 'ACC-500');

  // The monitor's sync sees the registry order (no manual registration).
  const sync = await hub.mwl!.poll();
  assert.equal(sync?.created.length, 1);
  assert.equal(orthanc.creates, 1);
  assert.equal([...orthanc.items.values()][0]!.AccessionNumber, 'ACC-500');

  // The modality performs the study → the next poll flows it back into the
  // hub as a routed message.
  orthanc.performed.add('ACC-500');
  await hub.mwl!.poll();
  await waitFor(async () => (await hub.store.list({ deviceId: 'orthanc' }))[0]?.status === 'ROUTED', 'imaging message ROUTED');
  const messages = await hub.store.list({ deviceId: 'orthanc' });
  assert.equal(messages[0]!.imaging?.accession, 'ACC-500');
  assert.equal(messages[0]!.imaging?.study.accessionNumber, 'ACC-500');
  assert.equal(messages[0]!.protocol, 'REST');
});
