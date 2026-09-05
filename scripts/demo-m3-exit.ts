/**
 * M3 exit drill (workstream K, plan §7.C / §13.16): the full imaging chain
 * over REAL DICOM networking. A pynetdicom fake modality (scripts/dicom-modality)
 * stands in for an actual CT scanner: it C-FINDs the Orthanc worklist for the
 * RIS order the hub pushed, performs the study, and C-STOREs it back into
 * Orthanc; the hub's MWL monitor sees the performed study, routes its
 * metadata through the dispatcher, and (with a peer) archives the pixels.
 *
 * Failure injection (the drill's point):
 *   A. modality goes offline  → Orthanc's C-ECHO fails → the hub's
 *      ModalityMonitor flips its device row to disconnected + fires
 *      device-offline; restarting the modality resolves both.
 *   B. broken routing rule    → the performed study routes to a dead `hl7`
 *      destination → FAILED → DLQ; the operator fixes the rule and retries
 *      (POST /api/v1/messages/:id/retry) → ROUTED.
 *
 * Prereqs: docker compose up -d --build orthanc && .venv/bin/pip install pynetdicom
 * Run:     .venv/bin/python scripts/dicom-modality/fake_modality.py serve &  (or use the drill's internal spawn)
 *          npm run demo:m3-exit
 *
 * Cleanup removes every artifact (modality config, patients, worklist items)
 * — Orthanc is left as it was.
 */
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { DicomOrthancAdapter } from '@integration-hub/dicom';
import { MllpDecoder, wrapMessage } from '@integration-hub/hl7';
import { startHub } from '../packages/server/src/index.js';

const BASE = process.env.ORTHANC_URL ?? 'http://127.0.0.1:8042';
const USER = process.env.ORTHANC_USER ?? 'orthanc';
const PASS = process.env.ORTHANC_PASSWORD ?? 'orthanc';
const MOD_AE = process.env.MODALITY_AET ?? 'FAKE-CT';
const MOD_PORT = Number(process.env.MODALITY_PORT ?? 11112);
const PY = process.env.MODALITY_PYTHON ?? '.venv/bin/python';
const MOD_SCRIPT = 'scripts/dicom-modality/fake_modality.py';

const adapter = new DicomOrthancAdapter({ baseUrl: BASE, username: USER, password: PASS });
let modality: ChildProcess | undefined;
let failures = 0;

function line(msg: string): void {
  console.log(`[drill] ${msg}`);
}

function check(cond: boolean, msg: string): void {
  console.log(`[drill] ${cond ? '✓' : '✗ FAIL'} ${msg}`);
  if (!cond) failures += 1;
}

/** Run a fake-modality CLI subcommand; returns its exit code. */
function mod(...args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [MOD_SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); process.stdout.write(c); });
    p.stderr.on('data', (c: Buffer) => { out += c.toString(); process.stderr.write(c); });
    p.on('close', (code) => (code === 0 ? resolve(code ?? 0) : reject(new Error(`${args[0]} exited ${code}: ${out.slice(-500)}`))));
    p.on('error', reject);
  });
}

function startModality(acceptStore = true): void {
  modality = spawn(PY, [MOD_SCRIPT, 'serve', '--host', '0.0.0.0', '--port', String(MOD_PORT), '--ae', MOD_AE, ...(acceptStore ? ['--accept-store'] : [])], { stdio: 'ignore' });
  modality.unref?.();
}

async function stopModality(): Promise<void> {
  if (modality) {
    modality.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
    modality = undefined;
  }
}

/** Send one HL7 message over MLLP and await its application ACK. */
function send(socket: net.Socket, wire: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new MllpDecoder({ onMessage: (ack) => resolve(ack) });
    socket.on('data', (c: Buffer) => decoder.feed(c));
    socket.write(wrapMessage(wire));
    setTimeout(() => reject(new Error('no ACK within 5s')), 5000);
  });
}

async function orm(hub: Awaited<ReturnType<typeof startHub>>, accession: string, patientId: string, name: string): Promise<string> {
  const ormMsg = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260905120000||ORM^O01|ORD-X|P|2.3.1',
    `PID|1||${patientId}^^^FAC1^PI||${name}||19850312|M`,
    `ORC|NW|PL-X|${accession}|GLU^Glucose`,
    `OBR|1|PL-X|${accession}|GLU^Glucose`,
  ].join('\r');
  const socket = net.connect(hub.ports.hl7!, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const ack = await send(socket, ormMsg);
  socket.destroy();
  return ack.match(/MSA\|(AA|AR|AE)\|/)?.[1] ?? '?';
}

/** Send one ADT^A01 admission over MLLP — the patient-side LIS feed that
 *  gives the MWL monitor the patient name for the worklist item. */
async function adt(hub: Awaited<ReturnType<typeof startHub>>, patientId: string, name: string): Promise<string> {
  const adtMsg = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260905120000||ADT^A01|ADT-X|P|2.3.1',
    `PID|1||${patientId}^^^FAC1^PI||${name}||19850312|M`,
    'PV1|1|I',
  ].join('\r');
  const socket = net.connect(hub.ports.hl7!, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const ack = await send(socket, adtMsg);
  socket.destroy();
  return ack.match(/MSA\|(AA|AR|AE)\|/)?.[1] ?? '?';
}

async function waitFor(list: () => Promise<unknown[]>, what: string, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if ((await list()).length > 0) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function main(): Promise<void> {
  line('═══ M3 EXIT DRILL — real DICOM modality, order → MWL → store → route ═══');

  // 0. Boot the hub with imaging wiring (no PG — in-memory is fine for the drill).
  const hub = await startHub({
    authDisabled: true,
    devicePort: 0,
    hl7Port: 0,
    httpPort: 0,
    seedDefaultAlerts: true, // keeps the orthanc-down default rule; device-offline seeded too
    orthanc: { baseUrl: BASE, username: USER, password: PASS, pollMs: 1000, modalityPollMs: 1000 },
  });
  line(`hub up — HL7 MLLP :${hub.ports.hl7}, Orthanc ${BASE}`);

  // 1. Start the fake modality + register it with Orthanc (host.docker.internal
  //    reaches this machine from the compose container).
  startModality();
  await new Promise((r) => setTimeout(r, 1200));
  await adapter.configureModality(MOD_AE, { aet: MOD_AE, host: 'host.docker.internal', port: MOD_PORT });
  line(`fake modality ${MOD_AE} up on :${MOD_PORT} + registered in Orthanc`);

  // 2. The LIS seam: ADT^A01 (patient admission) then ORM^O01 (the order) over
  //    MLLP — the ADT gives the MWL monitor the patient name for the worklist.
  const accession = `ACC-DRILL-${Math.floor(100000 + Math.random() * 900000)}`;
  const patientId = 'PID-DRILL-1';
  const ackAdt = await adt(hub, patientId, 'Drill^Demo');
  line(`ADT^A01 over MLLP → ${ackAdt} — patient ${patientId} admitted`);
  check(ackAdt === 'AA', 'admission accepted (AA)');
  const ack = await orm(hub, accession, patientId, 'Drill^Demo');
  line(`ORM^O01 over MLLP → ${ack} — order ${accession} registered from the wire`);
  check(ack === 'AA', 'order accepted (AA)');

  // 3. The MWL monitor pushes the order onto the real Orthanc worklist. The
  //    standing poller (pollMs 1000) may have beaten this manual poll, so
  //    accept either created or queued.
  const first = await hub.mwl!.poll();
  line(`MWL poll #1 → created=${first?.created.length ?? 0} queued=${first?.queued.length ?? 0}`);
  check(((first?.created.length ?? 0) + (first?.queued.length ?? 0)) > 0, 'order synced onto the Orthanc worklist');

  // 4. THE MODALITY: C-FIND the worklist like a real scanner would.
  await mod('find-mwl', '--ae', MOD_AE, '--orthanc', '127.0.0.1', '--port', '4242', '--accession', accession, '--expect');
  line('C-FIND found the scheduled procedure (MWL)');

  // 5. THE MODALITY: perform the study — C-STORE it into Orthanc.
  await mod('store', '--ae', MOD_AE, '--orthanc', '127.0.0.1', '--port', '4242',
    '--accession', accession, '--patient-id', patientId, '--patient-name', 'Drill^Demo', '--modality', 'CT');
  line('C-STORE performed the study into Orthanc');

  // 6. The monitor's next poll sees the performed study and routes it.
  let routed: Awaited<ReturnType<typeof hub.store.list>>[number] | undefined;
  for (let i = 0; i < 30; i++) {
    const res = await hub.mwl!.poll();
    if (res?.performed.length) {
      routed = (await hub.store.list({ deviceId: 'orthanc' }))[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  for (let i = 0; i < 40 && routed && (routed.status === 'QUEUED' || routed.status === 'DELIVERING'); i++) {
    await new Promise((r) => setTimeout(r, 100));
    routed = (await hub.store.list({ deviceId: 'orthanc' }))[0];
  }
  check(!!routed, 'performed study became a hub message');
  check(routed?.status === 'ROUTED', `study routed through the dispatcher (status=${routed?.status})`);
  check(routed?.imaging?.accession === accession, 'routed message carries the study accession');
  line(`  message ${routed?.id.slice(0, 8)}… ${routed?.status} — accession ${routed?.imaging?.accession}`);

  // ── FAILURE INJECTION A: modality offline → device row disconnected + alert ──
  line('── failure injection A: modality goes offline');
  await stopModality();
  let deviceOffline = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const dev = await hub.devices.get(MOD_AE);
    const firing = (await hub.alertStore.listAlerts({ firing: true })).some((a) => a.kind === 'device-offline' && a.subject === MOD_AE);
    if (dev?.state === 'disconnected' && firing) { deviceOffline = true; break; }
  }
  const devAfter = await hub.devices.get(MOD_AE);
  const alertsAfter = await hub.alertStore.listAlerts({ firing: true });
  check(devAfter?.state === 'disconnected', `modality device row disconnected (state=${devAfter?.state})`);
  check(alertsAfter.some((a) => a.kind === 'device-offline' && a.subject === MOD_AE), 'device-offline alert FIRING for the modality');

  // Modality comes back → device row reconnects + alert resolves.
  startModality();
  await new Promise((r) => setTimeout(r, 1200));
  let recovered = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const dev = await hub.devices.get(MOD_AE);
    const stillFiring = (await hub.alertStore.listAlerts({ firing: true })).some((a) => a.kind === 'device-offline' && a.subject === MOD_AE);
    if (dev?.state === 'connected' && !stillFiring) { recovered = true; break; }
  }
  check(recovered, 'modality back online → device row connected + alert resolved');

  // ── FAILURE INJECTION B: broken routing rule → DLQ → operator retry ──
  line('── failure injection B: routing rule points at a dead HL7 destination');
  const deadPort = 17888;
  await hub.routes.upsertDestination({
    id: 'drill-dead-lis', kind: 'hl7', name: 'Dead LIS (drill)',
    hl7: { host: '127.0.0.1', port: deadPort, receivingApp: 'LIS' },
    enabled: true, retry: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitter: false },
  });
  await hub.routes.upsertRule({ id: 'drill-rule', destinationId: 'drill-dead-lis', priority: 1, enabled: true });

  // Second order + performed study → routes to the dead LIS → FAILED + DLQ.
  const acc2 = `ACC-DRILL-${Math.floor(100000 + Math.random() * 900000)}`;
  await orm(hub, acc2, patientId, 'Drill^Demo');
  await hub.mwl!.poll(); // sync order 2 onto the worklist
  await mod('store', '--ae', MOD_AE, '--orthanc', '127.0.0.1', '--port', '4242',
    '--accession', acc2, '--patient-id', patientId, '--patient-name', 'Drill^Demo', '--modality', 'CT');
  let dlqMsg: Awaited<ReturnType<typeof hub.store.list>>[number] | undefined;
  for (let i = 0; i < 40; i++) {
    const res = await hub.mwl!.poll();
    if (res?.performed.length) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  // Delivery is async (retry → DLQ): poll until the dead destination actually
  // FAILED the message onto the DLQ (never just once — a mid-delivery read
  // would see QUEUED/DELIVERING and skip the wait).
  for (let i = 0; i < 40 && !(dlqMsg && dlqMsg.status === 'FAILED' && dlqMsg.dlqAt); i++) {
    await new Promise((r) => setTimeout(r, 200));
    dlqMsg = (await hub.store.list({ deviceId: 'orthanc', dlq: true }))[0];
  }
  check(!!dlqMsg, 'second study DLQ\'d (dead destination, no silent drop)');
  check(dlqMsg?.status === 'FAILED' && !!dlqMsg?.dlqAt, `DLQ'd message FAILED + dlqAt (status=${dlqMsg?.status})`);

  // Operator fixes the rule → retry → ROUTED.
  await hub.routes.deleteRule('drill-rule');
  await hub.routes.deleteDestination('drill-dead-lis');
  await hub.dispatcher.retry(dlqMsg!.id);
  let retried: Awaited<ReturnType<typeof hub.store.list>>[number] | undefined = dlqMsg;
  for (let i = 0; i < 40 && retried && (retried.status === 'QUEUED' || retried.status === 'DELIVERING'); i++) {
    await new Promise((r) => setTimeout(r, 100));
    retried = (await hub.store.get(dlqMsg!.id)) ?? undefined;
    if (!retried) retried = dlqMsg;
  }
  check(retried?.status === 'ROUTED', `retry after rule fix → ROUTED (status=${retried?.status})`);
  check(!retried?.dlqAt, 'DLQ marker cleared on retry');

  line(`═══ DRILL COMPLETE — ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ═══`);

  // ── Cleanup: modality config, patients, worklists; registries go with the hub ──
  await stopModality();
  try { await (adapter as unknown as { request: (m: string, u: string) => Promise<unknown> }).request('DELETE', `/modalities/${MOD_AE}`); } catch { /* already gone */ }
  for (const pid of await adapter.list('patients')) {
    try { await adapter.delete('patients', pid); } catch { /* gone */ }
  }
  for (const wid of await adapter.listWorklistIds()) {
    try { await adapter.deleteWorklistItem(wid); } catch { /* gone */ }
  }
  await hub.stop();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`[drill] FAILED: ${err instanceof Error ? err.message : err}`);
  // best-effort cleanup
  try { await (adapter as unknown as { request: (m: string, u: string) => Promise<unknown> }).request('DELETE', `/modalities/${MOD_AE}`); } catch { /* noop */ }
  for (const pid of await adapter.list('patients')) {
    try { await adapter.delete('patients', pid); } catch { /* noop */ }
  }
  for (const wid of await adapter.listWorklistIds()) {
    try { await adapter.deleteWorklistItem(wid); } catch { /* noop */ }
  }
  process.exit(1);
});