/**
 * Live M3.2/M3.3 proof through the REAL hub against a REAL Orthanc container:
 * the registry order arrives over MLLP (the B2c ORM^O01 LIS seam — no
 * programmatic registration), the MWL monitor syncs it onto the real Orthanc
 * worklist, the modality "performs" the study, and the next poll flows the
 * performed study BACK into the hub as a routed message (dedup → DB-driven
 * route rules → ROUTED in the same viewer as lab results). Run:
 *
 *   docker compose up -d --build orthanc && npm run demo:mwl
 *
 * Cleanup removes the performed patient + worklist item, leaving Orthanc as
 * it was.
 */
import net from 'node:net';
import { DicomOrthancAdapter } from '@integration-hub/dicom';
import { MllpDecoder, wrapMessage } from '@integration-hub/hl7';
import { startHub } from '../packages/server/src/index.js';

const BASE = process.env.ORTHANC_URL ?? 'http://127.0.0.1:8042';
const USER = process.env.ORTHANC_USER ?? 'orthanc';
const PASS = process.env.ORTHANC_PASSWORD ?? 'orthanc';

const adapter = new DicomOrthancAdapter({ baseUrl: BASE, username: USER, password: PASS });

/** Send one HL7 message over MLLP and await its application ACK. */
function send(socket: net.Socket, wire: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new MllpDecoder({ onMessage: (ack) => resolve(ack) });
    socket.on('data', (c: Buffer) => decoder.feed(c));
    socket.write(wrapMessage(wire));
    setTimeout(() => reject(new Error('no ACK within 5s')), 5000);
  });
}

async function main(): Promise<void> {
  const accession = `ACC-MWL-${Math.floor(100000 + Math.random() * 900000)}`;
  const patientId = 'PID-1001';

  // The hub: in-memory stores, inbound HL7 (MLLP) + the study monitor pointed
  // at the real Orthanc. The standing loop polls every MWL_POLL_MS (default
  // 60s) — the demo drives hub.mwl explicitly so each hop is visible.
  const hub = await startHub({
    authDisabled: true,
    devicePort: 0,
    hl7Port: 0,
    httpPort: 0,
    seedDefaultAlerts: false,
    orthanc: { baseUrl: BASE, username: USER, password: PASS, pollMs: Number(process.env.MWL_POLL_MS ?? '') || 60_000 },
  });
  const mwl = hub.mwl!;

  // The ADT admission (patient master context the monitor joins for the name).
  await hub.admissions.register({ patientId, name: 'Adeyemi^Tunde', status: 'admitted', receivedAt: new Date().toISOString() });

  // The LIS seam over the wire: an ORM^O01 registers the expected order
  // (its filler/accession doubles as the RIS order id for imaging).
  const orm = [
    'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORM^O01|ORD-9|P|2.3.1',
    `PID|1||${patientId}^^^FAC1^PI||Adeyemi^Tunde||19850312|M`,
    `ORC|NW|PL-77|${accession}|GLU^Glucose`,
    `OBR|1|PL-77|${accession}|GLU^Glucose`,
  ].join('\r');
  const socket = net.connect(hub.ports.hl7!, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const ack = await send(socket, orm);
  console.log(`[demo:mwl] ORM^O01 over MLLP → ${ack.match(/MSA\|(AA|AR|AE)\|/)?.[1] ?? '?'} — order ${accession} registered from the wire`);
  socket.destroy();

  // Poll #1 — the monitor syncs the registry order onto the real worklist.
  const first = await mwl.poll();
  const itemId = first?.entries[0]?.worklistId;
  console.log(`[demo:mwl] monitor poll #1 → ${first?.created.length ?? 0} created (worklist item ${itemId?.slice(0, 8)}…)`);

  const listed = await adapter.listWorklistIds();
  const item = await adapter.getWorklistItem(listed[0]!);
  const tags = item.Tags as Record<string, unknown>;
  console.log(`[demo:mwl]   Orthanc worklist holds: accession=${tags.AccessionNumber} patient=${tags.PatientName} (${tags.PatientID})`);

  // The modality performs the study (C-STORE equivalent into Orthanc) …
  const performed = await adapter.createDicom({
    PatientName: 'Adeyemi^Tunde',
    PatientID: patientId,
    AccessionNumber: accession,
    StudyDescription: 'CT CHEST — MWL demo (performed)',
    Modality: 'CT',
  });
  console.log(`[demo:mwl] modality stored performed study (${performed.studyOrthancId?.slice(0, 8)}…)`);

  // Poll #2 — the study flows BACK into the hub as a routed message. Delivery
  // is async through the dispatcher, so wait for the terminal status.
  const second = await mwl.poll();
  console.log(`[demo:mwl] monitor poll #2 → ${second?.performed.length ?? 0} performed — item retired`);
  let routed = (await hub.store.list({ deviceId: 'orthanc' }))[0];
  for (let i = 0; i < 50 && routed && (routed.status === 'QUEUED' || routed.status === 'DELIVERING'); i++) {
    await new Promise((r) => setTimeout(r, 50));
    routed = (await hub.store.list({ deviceId: 'orthanc' }))[0];
  }
  console.log(`[demo:mwl]   hub message ${routed?.id.slice(0, 8)}… ${routed?.status}: accession ${routed?.imaging?.accession} (storage URL in Orthanc: ${routed?.imaging?.study.storageUrl.slice(0, 60)}…)`);
  if (routed?.status !== 'ROUTED') throw new Error(`expected the imaging message ROUTED, got ${routed?.status}`);

  const status = mwl.status();
  console.log(`[demo:mwl] hub.mwl totals: created=${status.totals.created} queued=${status.totals.queued} · performed observed=${status.performed.length}`);

  // Cleanup — remove the performed patient; the registries go away with the hub.
  if (performed.patientOrthancId) await adapter.delete('patients', performed.patientOrthancId);
  await hub.stop();
  console.log('[demo:mwl] cleaned up — done, wire order → worklist → routed hub message green');
}

main().catch(async (err) => {
  console.error(`[demo:mwl] failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
