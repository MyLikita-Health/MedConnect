/**
 * Live M3.2 proof — the startHub MWL study monitor pointed at REAL Orthanc:
 * a registry order (the LIS seam) is synced onto the real Orthanc worklist by
 * `hub.mwl`, the modality "performs" the study (a synthetic instance carrying
 * the accession), the next monitor poll sees it and retires the item. Run:
 *
 *   docker compose up -d --build orthanc && npm run demo:mwl
 *
 * The hub boots with in-memory stores + the monitor enabled against
 * ORTHANC_URL (default http://127.0.0.1:8042, credentials orthanc/orthanc —
 * the compose image's stock users). Every created worklist item/patient is
 * removed, leaving Orthanc as it was.
 */
import { DicomOrthancAdapter } from '@integration-hub/dicom';
import { startHub } from '../packages/server/src/index.js';

const BASE = process.env.ORTHANC_URL ?? 'http://127.0.0.1:8042';
const USER = process.env.ORTHANC_USER ?? 'orthanc';
const PASS = process.env.ORTHANC_PASSWORD ?? 'orthanc';

const adapter = new DicomOrthancAdapter({ baseUrl: BASE, username: USER, password: PASS });

async function main(): Promise<void> {
  // The hub: in-memory stores, monitor enabled against the real Orthanc. The
  // standing loop polls every MWL_POLL_MS (default 60s) — this demo drives it
  // explicitly so the order → worklist → performed → retired story is visible.
  const hub = await startHub({
    authDisabled: true,
    devicePort: 0,
    httpPort: 0,
    seedDefaultAlerts: false,
    orthanc: { baseUrl: BASE, username: USER, password: PASS, pollMs: Number(process.env.MWL_POLL_MS ?? '') || 60_000 },
  });
  const mwl = hub.mwl!;

  const accession = `ACC-MWL-${Math.floor(100000 + Math.random() * 900000)}`;
  const patientId = 'PID-MWL-1';

  // The LIS seam: an expected order + the patient's admission (the monitor
  // joins the admission so the worklist item carries the patient name).
  await hub.admissions.register({ patientId, name: 'Okafor^Amara', status: 'admitted', receivedAt: new Date().toISOString() });
  await hub.orders.register({ id: accession, patientId, tests: ['CT CHEST'], status: 'active', receivedAt: new Date().toISOString() });
  console.log(`[demo:mwl] registered order ${accession} (patient ${patientId}) — the LIS seam`);

  // Poll #1 — the monitor pushes the order onto the real Orthanc worklist.
  const first = await mwl.poll();
  const itemId = first?.entries[0]?.worklistId;
  console.log(`[demo:mwl] monitor poll #1 → ${first?.created.length ?? 0} created (worklist item ${itemId?.slice(0, 8)}…)`);

  // Show the item on the wire, exactly as a modality C-FIND would see it.
  const listed = await adapter.listWorklistIds();
  if (listed.length !== 1) throw new Error(`expected 1 worklist item, found ${listed.length}`);
  const item = await adapter.getWorklistItem(listed[0]!);
  const tags = item.Tags as Record<string, unknown>;
  console.log(`[demo:mwl]   Orthanc worklist holds: accession=${tags.AccessionNumber} patient=${tags.PatientName} (${tags.PatientID})`);

  // Poll #2 — idempotent re-sync: no duplicate item appears.
  await mwl.poll();
  if ((await adapter.listWorklistIds()).length !== 1) throw new Error('re-sync duplicated the worklist item');
  console.log('[demo:mwl] monitor poll #2 → queued (idempotent — no duplicate)');

  // The modality performs the study (C-STORE equivalent: a synthetic instance
  // with the worklist's accession lands in Orthanc) …
  const performed = await adapter.createDicom({
    PatientName: 'Okafor^Amara',
    PatientID: patientId,
    AccessionNumber: accession,
    StudyDescription: 'CT CHEST — MWL demo (performed)',
    Modality: 'CT',
  });
  console.log(`[demo:mwl] modality stored performed study (${performed.studyOrthancId?.slice(0, 8)}…)`);

  // Poll #3 — the monitor sees the study, reports it performed, retires the
  // item, and will never re-sync this accession.
  const third = await mwl.poll();
  console.log(`[demo:mwl] monitor poll #3 → ${third?.performed.length ?? 0} performed (${third?.performed[0]?.study.orthancId.slice(0, 8)}…) — item retired`);
  console.log(`[demo:mwl]   worklist after retirement: ${(await adapter.listWorklistIds()).length} item(s)`);

  const status = mwl.status();
  console.log(`[demo:mwl] hub.mwl status: totals created=${status.totals.created} queued=${status.totals.queued} · performed observed=${status.performed.length}`);

  // Cleanup — remove the performed patient; the hub's registries go away with it.
  if (performed.patientOrthancId) await adapter.delete('patients', performed.patientOrthancId);
  await hub.stop();
  console.log('[demo:mwl] cleaned up — done, full MWL loop through the real hub green');
}

main().catch(async (err) => {
  console.error(`[demo:mwl] failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
