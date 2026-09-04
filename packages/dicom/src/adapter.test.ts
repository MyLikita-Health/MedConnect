/**
 * DicomOrthancAdapter tests (M3.1) against a mock Orthanc HTTP server: the
 * REST contract (paths, JSON shapes, status handling) is pinned here so the
 * real integration in M3.2 starts from a verified client. No DICOM networking
 * anywhere — the adapter only speaks Orthanc's REST API (§3.2 decision).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DicomOrthancAdapter, OrthancError } from './adapter.js';

/** Canned Orthanc resources (mirror the documented REST JSON shapes). */
const PATIENT = {
  ID: 'pat-1',
  MainDicomTags: { PatientID: 'PID-1001', PatientName: 'Adeyemi^Tunde', PatientBirthDate: '19850312', PatientSex: 'M' },
  Studies: ['stu-1'],
};
const STUDY = {
  ID: 'stu-1',
  ParentPatient: 'pat-1',
  MainDicomTags: {
    AccessionNumber: 'ACC-424242',
    StudyDate: '20260904',
    StudyDescription: 'CT CHEST',
    StudyID: 'S-1',
    StudyInstanceUID: '1.2.840.113704.1.111.7016.1',
  },
  PatientMainDicomTags: { PatientID: 'PID-1001', PatientName: 'Adeyemi^Tunde' },
  Series: ['ser-1'],
};
const SERIES = {
  ID: 'ser-1',
  ParentStudy: 'stu-1',
  MainDicomTags: {
    Modality: 'CT',
    SeriesDescription: 'CHEST WO CONTRAST',
    SeriesInstanceUID: '1.2.840.113704.1.111.7016.2',
    ProtocolName: 'CHEST',
  },
  Instances: ['ins-1'],
  ExpectedNumberOfInstances: 1,
};
const INSTANCE = {
  ID: 'ins-1',
  ParentSeries: 'ser-1',
  FileSize: 70356,
  MainDicomTags: { SOPInstanceUID: '1.2.840.113704.1.111.7016.3' },
};

interface RequestLog {
  method: string;
  path: string;
  body?: unknown;
  auth?: string;
}

interface MockOrthanc {
  base: string;
  log: RequestLog[];
}

/** Handler sees (method, path, parsed body, log entry); answers via res. */
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, entry: RequestLog, body: string) => void;

async function startMockOrthanc(t: any, handler: Handler): Promise<MockOrthanc> {
  const log: RequestLog[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const entry: RequestLog = { method: req.method ?? 'GET', path: req.url ?? '/', auth: req.headers.authorization };
      if (body) {
        try {
          entry.body = JSON.parse(body);
        } catch {
          entry.body = body;
        }
      }
      log.push(entry);
      handler(req, res, entry, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log };
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test('ping + listing hit the documented Orthanc routes', async (t) => {
  const { base, log } = await startMockOrthanc(t, (req, res, entry) => {
    if (entry.path === '/system') return json(res, 200, { Version: '1.12.6', Name: 'Orthanc' });
    if (entry.path === '/studies') return json(res, 200, ['stu-1', 'stu-2']);
    json(res, 404, {});
  });
  const adapter = new DicomOrthancAdapter({ baseUrl: base });

  const system = await adapter.ping();
  assert.equal(system.version, '1.12.6');
  assert.deepEqual(await adapter.list('studies'), ['stu-1', 'stu-2']);
  assert.deepEqual(log.map((l) => `${l.method} ${l.path}`), ['GET /system', 'GET /studies']);
});

test('getStudy maps MainDicomTags to canonical metadata with an Orthanc storage URL', async (t) => {
  const { base } = await startMockOrthanc(t, (req, res) => json(res, 200, STUDY));
  const adapter = new DicomOrthancAdapter({ baseUrl: base });

  const study = await adapter.getStudy('stu-1');
  assert.equal(study.orthancId, 'stu-1');
  assert.equal(study.accessionNumber, 'ACC-424242');
  assert.equal(study.studyInstanceUid, '1.2.840.113704.1.111.7016.1');
  assert.equal(study.patientOrthancId, 'pat-1');
  assert.deepEqual(study.series, ['ser-1']);
  assert.deepEqual(study.patient, { patientId: 'PID-1001', name: 'Adeyemi^Tunde' });
  assert.equal(study.storageUrl, `${base}/studies/stu-1/archive`);
  // Pixels never in the canonical shape: the URL points back at Orthanc.
  assert.ok(study.storageUrl.startsWith(base));
});

test('patient/series/instance reads map to canonical shapes', async (t) => {
  const routes: Record<string, unknown> = {
    '/patients/pat-1': PATIENT,
    '/series/ser-1': SERIES,
    '/instances/ins-1': INSTANCE,
  };
  const { base } = await startMockOrthanc(t, (req, res) => json(res, 200, routes[req.url ?? ''] ?? { error: 'not found' }));
  const adapter = new DicomOrthancAdapter({ baseUrl: base });

  const patient = await adapter.getPatient('pat-1');
  assert.equal(patient.patientId, 'PID-1001');
  assert.equal(patient.name, 'Adeyemi^Tunde');
  assert.equal(patient.sex, 'M');
  assert.deepEqual(patient.studies, ['stu-1']);

  const series = await adapter.getSeries('ser-1');
  assert.equal(series.modality, 'CT');
  assert.equal(series.protocolName, 'CHEST');
  assert.equal(series.studyOrthancId, 'stu-1');
  assert.equal(series.storageUrl, `${base}/series/ser-1/archive`);

  const instance = await adapter.getInstance('ins-1');
  assert.equal(instance.sopInstanceUid, '1.2.840.113704.1.111.7016.3');
  assert.equal(instance.fileSize, 70356);
  assert.equal(instance.fileUrl, `${base}/instances/ins-1/file`);
});

test('findStudies POSTs a study-level C-FIND shape and maps expanded answers', async (t) => {
  const { base, log } = await startMockOrthanc(t, (req, res) => json(res, 200, [STUDY]));
  const adapter = new DicomOrthancAdapter({ baseUrl: base });

  const found = await adapter.findStudies({ PatientID: 'PID-1001', Modality: 'CT' });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.accessionNumber, 'ACC-424242');
  const call = log.find((l) => l.path === '/tools/find');
  assert.ok(call);
  assert.deepEqual(call.body, { Level: 'Study', Query: { PatientID: 'PID-1001', Modality: 'CT' }, Expand: true });
});

test('store/echo/delete hit the forwarding + lifecycle routes', async (t) => {
  const { base, log } = await startMockOrthanc(t, (req, res, entry) => {
    if (entry.path.startsWith('/peers/') || entry.path.startsWith('/modalities/')) return json(res, 200, {});
    if (entry.method === 'DELETE') return json(res, 200, {});
    json(res, 404, {});
  });
  const adapter = new DicomOrthancAdapter({ baseUrl: base });
  const refs = [{ id: 'stu-1', type: 'Study' as const }];

  await adapter.storeToPeer('pacs', refs);
  await adapter.storeToModality('CT1', refs);
  await adapter.echoModality('CT1');
  await adapter.delete('studies', 'stu-1');

  const store = log.find((l) => l.path === '/peers/pacs/store');
  assert.ok(store);
  assert.deepEqual(store.body, { Resources: refs });
  assert.ok(log.some((l) => l.method === 'POST' && l.path === '/modalities/CT1/echo'));
  assert.ok(log.some((l) => l.method === 'DELETE' && l.path === '/studies/stu-1'));
});

test('modality/peer listing normalizes map and list responses', async (t) => {
  const { base } = await startMockOrthanc(t, (req, res) => {
    if (req.url === '/modalities') return json(res, 200, { CT1: { AET: 'CT1' }, MR1: { AET: 'MR1' } });
    if (req.url === '/peers') return json(res, 200, { pacs: { Url: 'http://pacs:8042/' } });
    json(res, 404, {});
  });
  const adapter = new DicomOrthancAdapter({ baseUrl: base });
  assert.deepEqual(await adapter.listModalities(), ['CT1', 'MR1']);
  assert.deepEqual(await adapter.listPeers(), [{ name: 'pacs', url: 'http://pacs:8042/' }]);
});

test('basic auth is sent when configured', async (t) => {
  const { base, log } = await startMockOrthanc(t, (req, res) => json(res, 200, []));
  const adapter = new DicomOrthancAdapter({ baseUrl: base, username: 'hub', password: 'secret' });
  await adapter.list('studies');
  const expected = `Basic ${Buffer.from('hub:secret').toString('base64')}`;
  assert.equal(log[0]!.auth, expected);
});

test('a non-2xx Orthanc answer throws a typed OrthancError with the status', async (t) => {
  const { base } = await startMockOrthanc(t, (req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'db locked' }));
  });
  const adapter = new DicomOrthancAdapter({ baseUrl: base });
  await assert.rejects(() => adapter.getStudy('stu-1'), (err: unknown) => {
    assert.ok(err instanceof OrthancError);
    assert.equal((err as OrthancError).status, 500);
    assert.match((err as OrthancError).body ?? '', /db locked/);
    return true;
  });
});

test('an unreachable Orthanc throws a typed OrthancError', async () => {
  const adapter = new DicomOrthancAdapter({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
  await assert.rejects(() => adapter.ping(), OrthancError);
});