/**
 * REST API + management console (PRD §36 API, §31 Monitoring, §24 Message Viewer).
 * Zero-dependency HTTP server on Node's http module for the MVP scaffold.
 */
import http from 'node:http';
import net from 'node:net';
import type { CanonicalMessage, MappingTable } from '@integration-hub/shared';
import { DeviceRegistry } from './devices.js';
import { MessageStore } from './store.js';
import { renderUi } from './ui.js';

export interface ApiServerOptions {
  host?: string;
  port: number;
  store: MessageStore;
  devices: DeviceRegistry;
  /** Optional mapping table exposed read-only at /api/v1/mappings. */
  mappings?: MappingTable;
  /** Wired to the gateway so failed messages can be corrected + replayed. */
  replayHandler?: (message: CanonicalMessage) => CanonicalMessage;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, body?: unknown) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export class ApiServer {
  private server?: http.Server;
  private readonly routes: Route[];

  constructor(private readonly opts: ApiServerOptions) {
    this.routes = [
      { method: 'GET', pattern: /^\/api\/v1\/health$/, handler: (_req, res) => this.json(res, 200, this.health()) },
      { method: 'GET', pattern: /^\/api\/v1\/stats$/, handler: (_req, res) => this.json(res, 200, this.opts.store.stats()) },
      { method: 'GET', pattern: /^\/api\/v1\/mappings$/, handler: (_req, res) => this.json(res, 200, this.opts.mappings ?? {}) },
      { method: 'GET', pattern: /^\/api\/v1\/devices$/, handler: (_req, res) => this.json(res, 200, this.opts.devices.list()) },
      {
        method: 'POST',
        pattern: /^\/api\/v1\/devices$/,
        handler: (_req, res, _p, body) => {
          const record = this.opts.devices.register(body as any);
          this.json(res, 201, record);
        },
      },
      {
        method: 'GET',
        pattern: /^\/api\/v1\/messages$/,
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const filter = {
            deviceId: url.searchParams.get('deviceId') ?? undefined,
            status: url.searchParams.get('status') ?? undefined,
            limit: Number(url.searchParams.get('limit') ?? 100),
          };
          this.json(res, 200, this.opts.store.list(filter));
        },
      },
      {
        method: 'GET',
        pattern: /^\/api\/v1\/messages\/([^/]+)$/,
        handler: (_req, res, params) => {
          const message = this.opts.store.get(params.id!);
          if (!message) return this.json(res, 404, { error: 'message not found' });
          this.json(res, 200, message);
        },
      },
      {
        method: 'POST',
        pattern: /^\/api\/v1\/messages\/([^/]+)\/replay$/,
        handler: (_req, res, params) => {
          if (!this.opts.replayHandler) return this.json(res, 501, { error: 'replay not wired' });
          const message = this.opts.store.get(params.id!);
          if (!message) return this.json(res, 404, { error: 'message not found' });
          this.json(res, 201, this.opts.replayHandler(message));
        },
      },
      {
        method: 'GET',
        pattern: /^\/api\/v1\/results$/,
        handler: (_req, res) => {
          const rows = this.opts.store
            .list({ limit: 500 })
            .filter((m) => m.payload)
            .flatMap((m) =>
              (m.payload!.results ?? []).map((r) => ({
                messageId: m.id,
                deviceId: m.deviceId,
                receivedAt: m.receivedAt,
                patient: m.payload!.patient,
                order: m.payload!.order,
                ...r,
              })),
            );
          this.json(res, 200, rows);
        },
      },
      {
        method: 'GET',
        pattern: /^\/$/,
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderUi());
        },
      },
    ];
  }

  async start(): Promise<{ port: number }> {
    const server = http.createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => resolve());
    });
    const port = (server.address() as net.AddressInfo).port;
    return { port };
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    for (const route of this.routes) {
      const match = route.pattern.exec(pathname);
      if (!match || route.method !== req.method) continue;
      const params: Record<string, string> = {};
      for (let i = 1; i < match.length; i++) params[String(i - 1)] = match[i]!;
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
      await route.handler(req, res, params, body);
      return;
    }
    this.json(res, 404, { error: `no route for ${req.method} ${pathname}` });
  }

  private health() {
    return { status: 'ok', uptime: process.uptime(), time: new Date().toISOString() };
  }

  private json(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
  }

  private cors(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}