/**
 * Mock Orthanc HTTP server (test helper) — pins the REST contract the
 * adapter/service rely on: request log + handler-answered JSON, so tests
 * assert both the exact calls made and the parsing of the responses.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RequestLog {
  method: string;
  path: string;
  body?: unknown;
  auth?: string;
}

export interface MockOrthanc {
  base: string;
  log: RequestLog[];
}

/** Handler sees (request, response, parsed body, log entry); answers via res. */
export type MockHandler = (req: http.IncomingMessage, res: http.ServerResponse, entry: RequestLog, body: string) => void;

export async function startMockOrthanc(t: any, handler: MockHandler): Promise<MockOrthanc> {
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

export function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}