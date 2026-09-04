/**
 * Live Orthanc demo (workstreams M3.1 + M3.2): exercises DicomOrthancAdapter +
 * WorklistService against a REAL Orthanc container (compose service `orthanc`,
 * REST at http://127.0.0.1:8042, stock-image credentials orthanc/orthanc). Run:
 *
 *   docker compose up -d --build orthanc && npm run demo:dicom
 *
 * (the derived medconnect-orthanc image bundles the REST-based Worklists
 * plugin — the folder-mode config worklists.json enables it, see docker/orthanc/)
 *
 * The demo creates a synthetic CT study from DICOM tags (no modality needed),
 * reads it back as canonical metadata, round-trips a C-ECHO against a
 * self-registered modality, then drives the full M3.2 MWL workflow live: a
 * registry-shaped order is synced into the Orthanc worklist (idempotently),
 * the "modality" stores the performed study, pollPerformed retires the item.
 * All created patients/worklist items are deleted at the end, leaving Orthanc
 * as it was.
 */
import { DicomOrthancAdapter, WorklistService, type MwlOrder } from '@integration-hub/dicom';

const BASE = process.env.ORTHANC_URL ?? 'http://127.0.0.1:8042';
const USER = process.env.ORTHANC_USER ?? 'orthanc';
const PASS = process.env.ORTHANC_PASSWORD ?? 'orthanc';

const adapter = new DicomOrthancAdapter({ baseUrl: BASE, username: USER, password: PASS });
const worklists = new WorklistService(adapter, { defaultModality: 'CT' });

/** The M3.2 REST worklist needs the Worklists plugin — fail with the fix. */
async function worklistAvailable(): Promise<boolean> {
  try {
    await adapter.listWorklistIds();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const system = await adapter.ping();
  console.log(`[demo:dicom] Orthanc reachable — v${system.version} @ ${BASE}`);

  // 1. Create a synthetic CT study from DICOM tags (the C1 primitive).
  const accession = `ACC-DEMO-${Math.floor(100000 + Math.random() * 900000)}`;
  const created = await adapter.createDicom({
    PatientName: 'Demo^Radiology',
    PatientID: 'PID-DEMO-1',
    AccessionNumber: accession,
    StudyDescription: 'CT CHEST — hub demo',
    Modality: 'CT',
  });
  console.log(`[demo:dicom] created instance ${created.instanceId.slice(0, 8)}…`);
  console.log(`[demo:dicom]   patient ${created.patientOrthancId?.slice(0, 8)}… · study ${created.studyOrthancId?.slice(0, 8)}…`);

  // 2. Find the study by accession (the M3.2 performed-study poll primitive).
  const [study] = await adapter.findStudies({ AccessionNumber: accession });
  if (!study) throw new Error(`study with accession ${accession} not found after create`);
  console.log(`[demo:dicom] findStudies(AccessionNumber=${accession}) → study ${study.orthancId.slice(0, 8)}…`);

  // 3. Canonical metadata read (metadata + storage URL — pixels stay in Orthanc).
  const meta = await adapter.getStudy(study.orthancId);
  console.log(`[demo:dicom] getStudy: accession=${meta.accessionNumber} desc="${meta.studyDescription}" patient=${meta.patient?.patientId}`);
  console.log(`[demo:dicom]   storage URL: ${meta.storageUrl} (pixels stay in Orthanc)`);

  // 4. Walk the resource tree down to the instance.
  const seriesId = (await adapter.getStudy(meta.orthancId)).series[0]!;
  const series = await adapter.getSeries(seriesId);
  console.log(`[demo:dicom] getSeries: modality=${series.modality} protocol="${series.protocolName}" instances=${series.instances.length}`);
  const instanceId = series.instances[0]!;
  const instance = await adapter.getInstance(instanceId);
  console.log(`[demo:dicom] getInstance: sop=${instance.sopInstanceUid?.slice(0, 20)}… bytes=${instance.fileSize}`);

  // 5. Modality discovery + live C-ECHO against a self-registered modality.
  const modalities = await adapter.listModalities();
  console.log(`[demo:dicom] configured modalities: ${modalities.length === 0 ? '(none)' : modalities.join(', ')}`);
  await adapter.configureModality('self-echo', { aet: 'ORTHANC', host: '127.0.0.1', port: 4242 });
  await adapter.echoModality('self-echo');
  console.log('[demo:dicom] C-ECHO self-echo → success (DICOM handshake through Orthanc)');

  // 6. M3.2 MWL workflow, live against the real Worklists plugin: an RIS order
  //    → Orthanc worklist (idempotent) → modality performs → poll retires it.
  if (!(await worklistAvailable())) {
    throw new Error(
      'the Orthanc Worklists plugin is not answering /worklists/ — rebuild the service:\n' +
        '  docker compose up -d --build orthanc\n' +
        '(the derived image docker/orthanc bundles libOrthancWorklists 0.9.2)',
    );
  }
  const wlAccession = `ACC-WL-${Math.floor(100000 + Math.random() * 900000)}`;
  const order: MwlOrder = {
    accession: wlAccession,
    patientId: 'PID-WL-1',
    patientName: 'Worklist^Demo',
    requestedProcedure: 'CT CHEST — MWL demo',
    modality: 'CT',
  };

  const first = await worklists.run([order]);
  const itemId = first.entries[0]?.worklistId;
  console.log(`[demo:dicom] worklist sync #1 → ${first.created.join(',') || '(none)'} created (id ${itemId?.slice(0, 8)}…)`);

  const second = await worklists.run([order]);
  console.log(`[demo:dicom] worklist sync #2 → ${second.queued.join(',') || '(none)'} queued (idempotent — no duplicate)`);

  const listed = await adapter.listWorklistIds();
  if (listed.length !== 1) throw new Error(`expected exactly 1 worklist item, found ${listed.length}`);
  const item = await adapter.getWorklistItem(listed[0]!);
  console.log(`[demo:dicom]   worklist now holds ${listed.length} item: accession ${(item.Tags as Record<string, unknown>).AccessionNumber}`);

  // The modality performs the study (C-STORE equivalent: synthetic instance
  // carrying the worklist's accession) …
  const performed = await adapter.createDicom({
    PatientName: 'Worklist^Demo',
    PatientID: order.patientId,
    AccessionNumber: wlAccession,
    StudyDescription: 'CT CHEST — MWL demo (performed)',
    Modality: 'CT',
  });
  console.log(`[demo:dicom] modality stored performed study (${performed.studyOrthancId?.slice(0, 8)}…) with accession ${wlAccession}`);

  // … and the next poll sees it: the item is retired and the study returned.
  const third = await worklists.run([order]);
  if (third.performed.length !== 1) throw new Error('expected the performed study on poll #3');
  console.log(`[demo:dicom] worklist poll #3 → study ${third.performed[0]!.study.orthancId.slice(0, 8)}… performed accession ${third.performed[0]!.order.accession} — item retired`);
  console.log(`[demo:dicom]   worklist after retirement: ${(await adapter.listWorklistIds()).length} item(s)`);

  // 7. Cleanup — remove the demo patients (and their studies/instances).
  const patients = (await adapter.list('patients')).length;
  if (created.patientOrthancId) await adapter.delete('patients', created.patientOrthancId);
  if (performed.patientOrthancId) await adapter.delete('patients', performed.patientOrthancId);
  console.log(`[demo:dicom] cleaned up the demo patients (${patients} → ${(await adapter.list('patients')).length} in Orthanc)`);
  console.log('[demo:dicom] done — REST + MWL round-trip against real Orthanc green');
}

main().catch((err) => {
  console.error(`[demo:dicom] failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
