/**
 * M3.2 MWL study monitor — wired through the REAL startHub: when an orthanc
 * config is present the hub exposes `hub.mwl`, whose poll pushes active
 * registry orders onto the Orthanc worklist (idempotently), picks up studies
 * the modality performed (accession match), retires the worklist item, and
 * never re-creates it. A mock Orthanc HTTP server (inline, mirroring the
 * Worklists-plugin + /tools/find REST contract) records the calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHub } from './index.js';
import type { Hub } from './index.js';

interface MockOrthanc {
  base: string;
  /** Worklist items by id — Tags in the keyword form GET /worklists/{id} returns. */
  items: Map<string, Record<string, unknown>>;
  /** Accessions with a study landed in Orthanc (POST /tools/find answers them). */
  performed: Set<string>;
  creates: number;
  deletes: string[];
  close(): Promise<void>;
}

function startMockOrthanc(): Promise<MockOrthanc> {
  return new Promise((resolve) => {
    const items = new Map<string, Record<string, unknown>>();
    const performed = new Set<string>();
    const mock: MockOrthanc = {
      base: '',
      items,
      performed,
      creates: 0,
      deletes: [],
      close: () => new Promise((r) => server.close(() => r())),
    };
    let seq = 0;

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://mock');
        const path = url.pathname;
        const body = Buffer.concat(chunks).toString('utf8');
        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (req.method === 'GET' && path === '/worklists/' && url.searchParams.get('format') === 'Short') {
          json(200, [...items.keys()].map((id) => ({ ID: id })));
          return;
        }
        if (req.method === 'POST' && path === '/worklists/create') {
          const { Tags } = JSON.parse(body) as { Tags: Record<string, unknown> };
          const id = `wl-${++seq}`;
          items.set(id, Tags);
          mock.creates += 1;
          json(200, { ID: id });
          return;
        }
        const itemId = path.match(/^\/worklists\/([^/]+)$/)?.[1];
        if (req.method === 'GET' && itemId) {
          const tags = items.get(itemId);
          if (!tags) {
            res.writeHead(404);
            res.end();
            return;
          }
          json(200, { ID: itemId, Tags: tags });
          return;
        }
        if (req.method === 'DELETE' && itemId) {
          items.delete(itemId);
          mock.deletes.push(itemId);
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === 'POST' && path === '/tools/find') {
          const { Query } = JSON.parse(body) as { Query: Record<string, string> };
          const accession = Query.AccessionNumber ?? '';
          json(
            200,
            performed.has(accession)
              ? [
                  {
                    ID: `study-${accession}`,
                    MainDicomTags: { AccessionNumber: accession, StudyDescription: 'CT CHEST — performed' },
                    Series: [],
                  },
                ]
              : [],
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    server.listen(0, '127.0.0.1', () => {
      mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve(mock);
    });
  });
}

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

const iso = (): string => new Date().toISOString();

test('no orthanc config → the hub has no MWL monitor', async (t) => {
  const hub = await startHub({ authDisabled: true, devicePort: 0, httpPort: 0, seedDefaultAlerts: false });
  t.after(() => hub.stop());
  assert.equal(hub.mwl, undefined);
});

test('monitor syncs active registry orders onto the Orthanc worklist idempotently', async (t) => {
  const orthanc = await startMockOrthanc();
  t.after(() => orthanc.close());
  const hub = await startHubWithOrthanc(t, orthanc.base);

  // The admission registry supplies the patient name the worklist item carries.
  await hub.admissions.register({ patientId: 'P-1', name: 'Adeyemi^Tunde', status: 'admitted', receivedAt: iso() });
  await hub.orders.register({ id: 'ACC-101', patientId: 'P-1', tests: ['GLUCOSE'], status: 'active', receivedAt: iso() });

  const first = await hub.mwl!.poll();
  assert.equal(first?.created.length, 1);
  assert.equal(orthanc.creates, 1);
  assert.equal(orthanc.items.size, 1);

  // The created item carries the accession + the admission's patient name.
  const tags = [...orthanc.items.values()][0]!;
  assert.equal(tags.AccessionNumber, 'ACC-101');
  assert.equal(tags.PatientName, 'Adeyemi^Tunde');

  // A second poll is a no-op: the accession is already on the worklist.
  const second = await hub.mwl!.poll();
  assert.equal(second?.queued.length, 1);
  assert.equal(orthanc.creates, 1, 'idempotent — no duplicate create');
});

test('a study matching a synced accession is reported performed and the item retired — never re-created', async (t) => {
  const orthanc = await startMockOrthanc();
  t.after(() => orthanc.close());
  const hub = await startHubWithOrthanc(t, orthanc.base);
  await hub.orders.register({ id: 'ACC-202', patientId: 'P-2', tests: ['CREATININE'], status: 'active', receivedAt: iso() });

  const first = await hub.mwl!.poll();
  assert.equal(first?.created.length, 1);
  const itemId = [...orthanc.items.keys()][0]!;

  // The modality performs the study (its C-STORE lands in Orthanc) …
  orthanc.performed.add('ACC-202');
  const poll = await hub.mwl!.poll();
  assert.equal(poll?.performed.length, 1);
  assert.equal(poll.performed[0]!.study.accessionNumber, 'ACC-202');
  assert.deepEqual(orthanc.deletes, [itemId], 'the worklist item is retired');
  assert.equal(orthanc.items.size, 0);

  // … and the monitor surfaces it + never re-syncs the retired accession.
  const status = hub.mwl!.status();
  assert.equal(status.performed.length, 1);
  assert.equal(status.totals.created, 1);
  await hub.mwl!.poll();
  const after = await hub.mwl!.poll();
  assert.equal(after?.queued.length, 0);
  assert.equal(after?.performed.length, 0);
  assert.equal(orthanc.creates, 1, 'performed accession is not re-created');
  assert.equal(orthanc.items.size, 0);
});

test('ORTHANC_URL env alone enables the monitor', async (t) => {
  const prev = process.env.ORTHANC_URL;
  process.env.ORTHANC_URL = 'http://127.0.0.1:1';
  t.after(() => {
    if (prev === undefined) delete process.env.ORTHANC_URL;
    else process.env.ORTHANC_URL = prev;
  });
  const hub = await startHub({ authDisabled: true, devicePort: 0, httpPort: 0, seedDefaultAlerts: false });
  t.after(() => hub.stop());
  assert.ok(hub.mwl, 'ORTHANC_URL wires the monitor');
});

test('a failed poll records lastError instead of throwing', async (t) => {
  // Port 1 refuses connections — the adapter's request fails fast.
  const hub = await startHubWithOrthanc(t, 'http://127.0.0.1:1');
  await hub.orders.register({ id: 'ACC-303', patientId: 'P-3', tests: ['SODIUM'], status: 'active', receivedAt: iso() });

  const result = await hub.mwl!.poll();
  assert.equal(result, undefined);
  assert.match(hub.mwl!.status().lastError ?? '', /failed/i);
});
