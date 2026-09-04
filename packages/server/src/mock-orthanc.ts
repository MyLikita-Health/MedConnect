/**
 * Mock Orthanc HTTP server (server-package test helper) — answers the
 * Worklists-plugin REST surface + /tools/find the way the M3.2/M3.3 wiring
 * (MwlMonitor over WorklistService) calls it, and records every call. Tests
 * assert both the exact calls and the resulting hub state.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockOrthanc {
  base: string;
  /** Worklist items by id — Tags in the keyword form GET /worklists/{id} returns. */
  items: Map<string, Record<string, unknown>>;
  /** Accessions with a study landed in Orthanc (POST /tools/find answers them). */
  performed: Set<string>;
  /** When true every request answers 500 — simulates an unreachable Orthanc. */
  down: boolean;
  /** DICOM modality config names (GET /modalities answers these). */
  modalities: string[];
  /** Modalities whose C-ECHO fails (POST /modalities/{name}/echo → 500). */
  echoFail: Set<string>;
  creates: number;
  deletes: string[];
  close(): Promise<void>;
}

export function startMockOrthanc(): Promise<MockOrthanc> {
  return new Promise((resolve) => {
    const items = new Map<string, Record<string, unknown>>();
    const performed = new Set<string>();
    const mock: MockOrthanc = {
      base: '',
      items,
      performed,
      down: false,
      modalities: [],
      echoFail: new Set<string>(),
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

        if (mock.down) {
          json(500, { message: 'mock Orthanc down' });
          return;
        }
        if (req.method === 'GET' && path === '/modalities') {
          json(200, Object.fromEntries(mock.modalities.map((name) => [name, {}])));
          return;
        }
        const echoName = path.match(/^\/modalities\/([^/]+)\/echo$/)?.[1];
        if (req.method === 'POST' && echoName) {
          if (mock.echoFail.has(echoName)) {
            json(500, { message: `C-ECHO to ${echoName} failed` });
          } else {
            json(200, {});
          }
          return;
        }
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
                    ParentPatient: `pat-${accession}`,
                    MainDicomTags: {
                      AccessionNumber: accession,
                      StudyDescription: 'CT CHEST — performed',
                      StudyInstanceUID: `1.2.840.${accession}`,
                    },
                    Series: ['ser-1'],
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
