/**
 * Live Orthanc demo (workstream M3.1): exercises DicomOrthancAdapter against
 * a REAL Orthanc container (docker compose service `orthanc`, REST at
 * http://127.0.0.1:8042, stock-image credentials orthanc/orthanc). Run:
 *
 *   docker compose up -d orthanc && npm run demo:dicom
 *
 * The demo creates a synthetic CT study from DICOM tags (no modality needed),
 * reads it back as canonical metadata, and round-trips a C-ECHO against a
 * self-registered modality — proving the adapter's REST contract live. The
 * created patient is deleted at the end, leaving Orthanc as it was.
 */
import { DicomOrthancAdapter } from '@integration-hub/dicom';

const BASE = process.env.ORTHANC_URL ?? 'http://127.0.0.1:8042';
const USER = process.env.ORTHANC_USER ?? 'orthanc';
const PASS = process.env.ORTHANC_PASSWORD ?? 'orthanc';

const adapter = new DicomOrthancAdapter({ baseUrl: BASE, username: USER, password: PASS });

async function main(): Promise<void> {
  const system = await adapter.ping();
  console.log(`[demo:dicom] Orthanc reachable — ${system.name ?? 'Orthanc'} v${system.version} @ ${BASE}`);

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

  // 6. Cleanup — remove the demo patient (and its study/instances).
  if (created.patientOrthancId) {
    await adapter.delete('patients', created.patientOrthancId);
    console.log('[demo:dicom] cleaned up the demo patient');
  }
  console.log('[demo:dicom] done — full REST round-trip against real Orthanc green');
}

main().catch((err) => {
  console.error(`[demo:dicom] failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});