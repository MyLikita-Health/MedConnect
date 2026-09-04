/**
 * Live M3.3 proof — storage routing through the REAL hub against TWO real
 * Orthanc containers (compose services `orthanc` + `pacs`, the archive):
 * the hub's MWL monitor sees a performed study and (a) routes the study
 * METADATA through the dispatcher — dedup → the DB-driven route rule (an
 * http webhook) → ROUTED, and (b) forwards the PIXELS to the PACS peer
 * (Orthanc→Orthanc, triggered by the hub). Run:
 *
 *   docker compose up -d --build orthanc && docker compose up -d pacs \
 *     && npm run demo:routing
 *
 * Cleanup removes the studies from both Orthancs + the worklist item, leaving
 * everything as it was.
 */
import http from 'node:http';
import { DicomOrthancAdapter } from '@integration-hub/dicom';
import { startHub } from '../packages/server/src/index.js';

const SRC = process.env.ORTHANC_URL ?? 'http://127.0.0.1:8042';
const SRC_USER = process.env.ORTHANC_USER ?? 'orthanc';
const SRC_PASS = process.env.ORTHANC_PASSWORD ?? 'orthanc';
// From inside the main orthanc container, the archive is the compose service
// name `pacs` (the demo/verification hits it on host port 8043).
const PACS_INTERNAL = 'http://pacs:8042';
const PACS = process.env.PACS_URL ?? 'http://127.0.0.1:8043';

const source = new DicomOrthancAdapter({ baseUrl: SRC, username: SRC_USER, password: SRC_PASS });
const archive = new DicomOrthancAdapter({ baseUrl: PACS, username: SRC_USER, password: SRC_PASS });

async function main(): Promise<void> {
  // 1. The archive webhook the route rule will deliver to (the "PACS event
  //    feed" — study metadata, not pixels).
  const webhook: { body?: unknown } = {};
  const hookServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      webhook.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
  const hookPort = (hookServer.address() as { port: number }).port;

  // 2. Boot the real hub with the monitor + storage router enabled, the PACS
  //    peer to forward to, and the DB-driven rule (device orthanc → webhook).
  const hub = await startHub({
    authDisabled: true,
    devicePort: 0,
    httpPort: 0,
    seedDefaultAlerts: false,
    orthanc: { baseUrl: SRC, username: SRC_USER, password: SRC_PASS, forwardPeer: 'pacs' },
  });
  await hub.routes.upsertDestination({
    id: 'archive-webhook',
    kind: 'http',
    name: 'Archive webhook',
    url: `http://127.0.0.1:${hookPort}/studies`,
    enabled: true,
    retry: { maxAttempts: 2, backoffMs: 50, backoffFactor: 1, jitter: false },
  });
  await hub.routes.upsertRule({ id: 'imaging-archive', destinationId: 'archive-webhook', deviceId: 'orthanc', priority: 1, enabled: true });

  // 3. Register the PACS as an Orthanc forwarding peer on the SOURCE Orthanc
  //    (the hub's C3 configurePeer primitive; URL resolvable inside compose).
  await source.configurePeer('pacs', { url: PACS_INTERNAL, username: 'orthanc', password: 'orthanc' });
  console.log(`[demo:routing] source Orthanc peer 'pacs' → ${PACS_INTERNAL} (the archive)`);

  // 4. The LIS seam: an expected imaging order → the worklist.
  const accession = `ACC-RT-${Math.floor(100000 + Math.random() * 900000)}`;
  const patientId = 'PID-RT-1';
  await hub.admissions.register({ patientId, name: 'Bello^Chiamaka', status: 'admitted', receivedAt: new Date().toISOString() });
  await hub.orders.register({ id: accession, patientId, tests: ['CT CHEST'], status: 'active', receivedAt: new Date().toISOString() });
  const first = await hub.mwl!.poll();
  console.log(`[demo:routing] order ${accession} → worklist (item ${first?.entries[0]?.worklistId?.slice(0, 8)}…)`);

  // 5. The modality performs the study (C-STORE equivalent into the source).
  const performed = await source.createDicom({
    PatientName: 'Bello^Chiamaka',
    PatientID: patientId,
    AccessionNumber: accession,
    StudyDescription: 'CT CHEST — routing demo (performed)',
    Modality: 'CT',
  });
  console.log(`[demo:routing] modality stored study ${performed.studyOrthancId?.slice(0, 8)}… in the source Orthanc`);

  // 6. The monitor poll: metadata routes (webhook + ROUTED) and the pixels
  //    are forwarded to the archive peer.
  const poll = await hub.mwl!.poll();
  const studyId = poll?.performed[0]?.study.orthancId;
  console.log(`[demo:routing] monitor poll → performed study ${studyId?.slice(0, 8)}…`);

  const routed = (await hub.store.list({ deviceId: 'orthanc' }))[0];
  if (!routed || routed.status !== 'ROUTED') throw new Error(`imaging message not ROUTED: ${routed?.status}`);
  const event = routed.imaging!;
  console.log(`[demo:routing]   metadata ROUTED through the dispatcher → webhook delivered accession ${event.accession} (storage URL stays in the source: ${event.study.storageUrl.slice(0, 60)}…)`);
  console.log(`[demo:routing]   pixels forwarded to the archive peer 'pacs'`);

  // 7. Verify the archive actually received the study (two real Orthancs).
  let archived = (await archive.list('studies')).length;
  if (archived !== 1) throw new Error(`expected 1 study in the archive, found ${archived}`);
  console.log(`[demo:routing]   archive Orthanc now holds ${archived} study — storage routing verified`);

  // 8. Cleanup: remove the study from the archive + source, the worklist item
  //    is already retired, and shut the hub down.
  if (performed.patientOrthancId) {
    // Source patient id from the archived copy: find it via the source first.
    const sourcePatient = performed.patientOrthancId;
    await source.delete('patients', sourcePatient);
    const archivedPatients = await archive.list('patients');
    for (const pid of archivedPatients) await archive.delete('patients', pid);
  }
  console.log(`[demo:routing] cleaned up: source patients ${(await source.list('patients')).length}, archive ${(await archive.list('patients')).length}, worklist ${(await source.listWorklistIds()).length}`);
  await hub.stop();
  hookServer.close();
  console.log('[demo:routing] done — metadata routed + pixels archived against real Orthanc/PACS');
}

main().catch(async (err) => {
  console.error(`[demo:routing] failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
