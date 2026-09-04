/**
 * M3.2 — WorklistService tests against a mock Orthanc (full adapter→HTTP
 * stack): the worklist plugin REST contract for create/reconcile/delete, the
 * idempotent sync, and the performed-study poll that retires items once the
 * modality's study lands (C-STORE → /tools/find match).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DicomOrthancAdapter } from './adapter.js';
import { json, startMockOrthanc, type MockHandler } from './mock-orthanc.js';
import { orderToWorklistTags, WorklistService, type MwlOrder } from './worklist.js';

const ORDER: MwlOrder = {
  accession: 'ACC-1001',
  patientId: 'PID-1001',
  patientName: 'Adeyemi^Tunde',
  requestedProcedure: 'CT CHEST',
  modality: 'CT',
  scheduledDate: '20260905',
};

/** Mock worklist + study store; tests mutate it between service runs. */
interface MwlState {
  /** accession → worklist item id */
  items: Map<string, string>;
  /** accessions whose study has landed in Orthanc (C-STORE done) */
  performed: Set<string>;
  createCalls: number;
}

/** A stateful mock of the worklist plugin + /tools/find surfaces. */
function mockHandler(state: MwlState): MockHandler {
  let nextId = 1;
  return (req, res, entry) => {
    if (entry.method === 'GET' && entry.path === '/worklists/?format=Short') {
      return json(res, 200, [...state.items.values()].map((id) => ({ ID: id })));
    }
    if (entry.method === 'POST' && entry.path === '/worklists/create') {
      state.createCalls++;
      const tags = (entry.body as { Tags: { AccessionNumber: string } }).Tags;
      const id = `wl-${nextId++}`;
      state.items.set(tags.AccessionNumber, id);
      return json(res, 200, { ID: id, Path: `/worklists/${id}` });
    }
    const idMatch = /^\/worklists\/(wl-\d+)$/.exec(entry.path);
    if (idMatch && entry.method !== 'DELETE') {
      const accession = [...state.items.entries()].find(([, v]) => v === idMatch[1])?.[0];
      if (accession) return json(res, 200, { ID: idMatch[1], Tags: { AccessionNumber: accession } });
      return json(res, 404, {});
    }
    if (idMatch && entry.method === 'DELETE') {
      for (const [acc, wid] of state.items) if (wid === idMatch[1]) state.items.delete(acc);
      return json(res, 200, {});
    }
    if (entry.method === 'POST' && entry.path === '/tools/find') {
      const acc = (entry.body as { Query: { AccessionNumber: string } }).Query.AccessionNumber;
      if (state.performed.has(acc)) {
        return json(res, 200, [
          { ID: `stu-${acc}`, ParentPatient: 'pat-1', MainDicomTags: { AccessionNumber: acc }, Series: [] },
        ]);
      }
      return json(res, 200, []);
    }
    json(res, 404, {});
  };
}

async function makeService(t: any, state: MwlState): Promise<WorklistService> {
  const { base } = await startMockOrthanc(t, mockHandler(state));
  return new WorklistService(new DicomOrthancAdapter({ baseUrl: base }));
}

test('orderToWorklistTags builds the plugin DICOM keyword payload', () => {
  const tags = orderToWorklistTags(ORDER, 'MR');
  assert.equal(tags.PatientID, 'PID-1001');
  assert.equal(tags.AccessionNumber, 'ACC-1001');
  assert.equal(tags.RequestedProcedureDescription, 'CT CHEST');
  const step = (tags.ScheduledProcedureStepSequence as Array<Record<string, string>>)[0]!;
  assert.equal(step.Modality, 'CT'); // order modality wins over the default
  assert.equal(step.ScheduledProcedureStepStartDate, '20260905');
  assert.equal(step.ScheduledProcedureStepID, 'ACC-1001');

  // Default modality + today's date when omitted.
  const bare = orderToWorklistTags({ accession: 'A', patientId: 'P' });
  const bareStep = (bare.ScheduledProcedureStepSequence as Array<Record<string, string>>)[0]!;
  assert.equal(bareStep.Modality, 'CT');
  assert.match(bareStep.ScheduledProcedureStepStartDate ?? '', /^\d{8}$/);
});

test('sync places missing orders on the worklist; re-sync is idempotent', async (t) => {
  const state: MwlState = { items: new Map(), performed: new Set(), createCalls: 0 };
  const service = await makeService(t, state);

  const first = await service.sync([ORDER]);
  assert.deepEqual(first.created, ['ACC-1001']);
  assert.deepEqual(first.queued, []);
  assert.equal(state.createCalls, 1);

  const second = await service.sync([ORDER]);
  assert.deepEqual(second.queued, ['ACC-1001']);
  assert.deepEqual(second.created, []);
  assert.equal(state.createCalls, 1, 'no duplicate worklist item on re-sync');
});

test('run polls for the performed study and retires the worklist item', async (t) => {
  const state: MwlState = { items: new Map(), performed: new Set(), createCalls: 0 };
  const service = await makeService(t, state);

  const first = await service.run([ORDER]);
  assert.deepEqual(first.created, ['ACC-1001']);
  assert.deepEqual(first.performed, []);

  // The modality performed the study and C-STOREd it into Orthanc.
  state.performed.add('ACC-1001');

  const second = await service.run([ORDER]);
  assert.equal(second.performed.length, 1);
  assert.equal(second.performed[0]!.order.accession, 'ACC-1001');
  assert.equal(second.performed[0]!.study.orthancId, 'stu-ACC-1001');
  assert.equal(state.items.size, 0, 'performed order leaves the worklist');
});

test('a failing worklist create is reported, never thrown away silently', async (t) => {
  const { base } = await startMockOrthanc(t, (req, res, entry) => {
    if (entry.method === 'GET' && entry.path === '/worklists/?format=Short') return json(res, 200, []);
    if (entry.method === 'POST' && entry.path === '/worklists/create') return json(res, 500, { message: 'plugin database locked' });
    json(res, 404, {});
  });
  const service = new WorklistService(new DicomOrthancAdapter({ baseUrl: base }));
  const result = await service.sync([ORDER]);
  assert.deepEqual(result.failed, ['ACC-1001']);
  assert.ok(result.entries[0]!.error?.includes('500'));
});