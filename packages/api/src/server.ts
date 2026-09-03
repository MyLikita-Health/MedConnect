/**
 * REST API + management console (PRD §36 API, §31 Monitoring, §24 Message Viewer).
 *
 * M0: moved from the hand-rolled node:http router onto Fastify with zod
 * validation (plan §13.1.3). The v1 route surface is preserved as the contract
 * baseline (plan §13): /api/v1/{health,stats,mappings,devices,messages,results}
 * plus replay, and the console UI at /.
 */
import net from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CanonicalMessage, MappingTable } from '@integration-hub/shared';
import type { DeviceBackend, StoreBackend } from './backend.js';
import { renderUi } from './ui.js';

export interface ApiServerOptions {
  host?: string;
  port: number;
  store: StoreBackend;
  devices: DeviceBackend;
  /** Optional mapping table exposed read-only at /api/v1/mappings. */
  mappings?: MappingTable;
  /** Wired to the gateway so failed messages can be corrected + replayed. */
  replayHandler?: (message: CanonicalMessage) => CanonicalMessage | Promise<CanonicalMessage>;
}

const registerDeviceSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  protocol: z.enum(['ASTM', 'HL7', 'FHIR']).optional(),
  transport: z.enum(['tcp', 'serial', 'api']).optional(),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
});

const listMessagesSchema = z.object({
  deviceId: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export class ApiServer {
  private app?: FastifyInstance;

  constructor(private readonly opts: ApiServerOptions) {
    const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
    this.app = app;

    // CORS for the console and integrations (same policy as the scaffold).
    app.addHook('onSend', async (_req, reply) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
    });
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS') {
        reply.code(204).send();
      }
    });

    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'validation error', issues: err.issues.map((i) => i.message) });
      }
      reqLogger(err);
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/api/v1/health', async () => this.health());
    app.get('/api/v1/stats', async () => this.opts.store.stats());
    app.get('/api/v1/mappings', async () => this.opts.mappings ?? {});
    app.get('/api/v1/devices', async () => this.opts.devices.list());
    app.post('/api/v1/devices', async (req, reply) => {
      const input = registerDeviceSchema.parse(req.body);
      const record = await this.opts.devices.register(input);
      return reply.code(201).send(record);
    });

    app.get('/api/v1/messages', async (req) => {
      const query = listMessagesSchema.parse(req.query);
      return this.opts.store.list(query);
    });

    app.get('/api/v1/messages/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const message = await this.opts.store.get(id);
      if (!message) return reply.code(404).send({ error: 'message not found' });
      return message;
    });

    app.post('/api/v1/messages/:id/replay', async (req, reply) => {
      if (!this.opts.replayHandler) return reply.code(501).send({ error: 'replay not wired' });
      const { id } = req.params as { id: string };
      const message = await this.opts.store.get(id);
      if (!message) return reply.code(404).send({ error: 'message not found' });
      return reply.code(201).send(await this.opts.replayHandler(message));
    });

    app.get('/api/v1/results', async () => {
      const messages = await this.opts.store.list({ limit: 500 });
      return messages
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
    });

    app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(renderUi()));
  }

  async start(): Promise<{ port: number }> {
    const app = this.app!;
    await app.listen({ port: this.opts.port, host: this.opts.host ?? '0.0.0.0' });
    const port = (app.server.address() as net.AddressInfo).port;
    return { port };
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.close();
      this.app = undefined;
    }
  }

  private health() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      time: new Date().toISOString(),
      storage: this.opts.store.kind,
    };
  }
}

function reqLogger(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api] ${message}`);
}