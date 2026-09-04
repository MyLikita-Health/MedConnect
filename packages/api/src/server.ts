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
import { DEFAULT_RETRY, InMemoryAlertStore, InMemoryOrderRegistry, InMemoryRouteStore, type AlertStore, type OrderRegistry, type RouteStore } from '@integration-hub/core';
import type { DeviceBackend, StoreBackend } from './backend.js';
import { renderUi } from './ui.js';

export interface ApiServerOptions {
  host?: string;
  port: number;
  store: StoreBackend;
  devices: DeviceBackend;
  /** Optional mapping table exposed read-only at /api/v1/mappings. */
  mappings?: MappingTable;
  /** Routing configuration (destinations + rules); defaults to an in-memory store. */
  routes?: RouteStore;
  /** Expected-order registry behind patient/order matching (PRD §27). */
  orders?: OrderRegistry;
  /** Alert rules + derived alerts (PRD §33); defaults to in-memory. */
  alerts?: AlertStore;
  /** Wired to the gateway so failed messages can be corrected + replayed. */
  replayHandler?: (message: CanonicalMessage) => CanonicalMessage | Promise<CanonicalMessage>;
  /** Wired to the dispatcher so held messages can be released into delivery. */
  releaseHandler?: (id: string) => boolean | Promise<boolean>;
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
  dlq: z.coerce.boolean().optional(),
  held: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const orderSchema = z.object({
  id: z.string().min(1),
  patientId: z.string().min(1),
  sampleId: z.string().optional(),
  tests: z.array(z.string()).default([]),
  status: z.enum(['active', 'completed', 'cancelled']).default('active'),
});

const alertRuleSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['device-offline', 'destination-down', 'dlq', 'held-backlog']),
  name: z.string().min(1),
  subject: z.string().optional(),
  threshold: z.number().int().min(1).max(10000).default(1),
  cooldownMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  channels: z.array(z.enum(['console', 'webhook'])).default(['console']),
  webhookUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
});

const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(DEFAULT_RETRY.maxAttempts),
  backoffMs: z.number().int().min(0).max(60000).default(DEFAULT_RETRY.backoffMs),
  backoffFactor: z.number().min(1).max(10).default(DEFAULT_RETRY.backoffFactor),
  jitter: z.boolean().default(DEFAULT_RETRY.jitter),
});

const destinationSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['console', 'http']).default('http'),
  name: z.string().min(1),
  url: z.string().url().optional(),
  enabled: z.boolean().default(true),
  retry: retrySchema.optional(),
});

const routeRuleSchema = z.object({
  id: z.string().min(1),
  destinationId: z.string().min(1),
  deviceId: z.string().optional(),
  status: z.string().optional(),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
});

export class ApiServer {
  private app?: FastifyInstance;
  private readonly routes: RouteStore;
  private readonly orders: OrderRegistry;
  private readonly alerts: AlertStore;

  constructor(private opts: ApiServerOptions) {
    this.routes = opts.routes ?? new InMemoryRouteStore();
    this.orders = opts.orders ?? new InMemoryOrderRegistry();
    this.alerts = opts.alerts ?? new InMemoryAlertStore();
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

    // Routing configuration (plan §5.1 Routing group, PRD §19).
    app.get('/api/v1/destinations', async () => this.routes.listDestinations());
    app.post('/api/v1/destinations', async (req, reply) => {
      const input = destinationSchema.parse(req.body);
      if (input.id === 'console') return reply.code(400).send({ error: 'the console destination is built-in' });
      const destination = { ...input, retry: input.retry ?? DEFAULT_RETRY };
      await this.routes.upsertDestination(destination);
      return reply.code(201).send(destination);
    });
    app.delete('/api/v1/destinations/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (id === 'console') return reply.code(400).send({ error: 'the console destination is built-in' });
      await this.routes.deleteDestination(id);
      return reply.code(204).send();
    });

    app.get('/api/v1/routes', async () => this.routes.listRules());
    app.post('/api/v1/routes', async (req, reply) => {
      const rule = routeRuleSchema.parse(req.body);
      await this.routes.upsertRule(rule);
      return reply.code(201).send(rule);
    });
    app.delete('/api/v1/routes/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      await this.routes.deleteRule(id);
      return reply.code(204).send();
    });

    // Dead-letter queue (plan §5.3 DLQ workflow, PRD §23).
    app.get('/api/v1/dlq', async () => this.opts.store.list({ status: 'FAILED', dlq: true }));
    app.post('/api/v1/messages/:id/discard', async (req, reply) => {
      const { id } = req.params as { id: string };
      const message = await this.opts.store.get(id);
      if (!message) return reply.code(404).send({ error: 'message not found' });
      await this.opts.store.mark(id, 'DISCARDED', 'discarded from DLQ');
      return reply.code(200).send({ ok: true, id });
    });

    // Exception queue (PRD §27–28): messages held for review that failed
    // patient/order matching or validation. Release re-enters delivery.
    app.get('/api/v1/held', async () => this.opts.store.list({ status: 'HELD' }));
    app.post('/api/v1/messages/:id/release', async (req, reply) => {
      if (!this.opts.releaseHandler) return reply.code(501).send({ error: 'release not wired' });
      const { id } = req.params as { id: string };
      const message = await this.opts.store.get(id);
      if (!message) return reply.code(404).send({ error: 'message not found' });
      const released = await this.opts.releaseHandler(id);
      if (!released) return reply.code(409).send({ error: 'message is not in the HELD queue' });
      return reply.code(200).send({ ok: true, id });
    });

    // Alert rules + alerts (plan workstream I, PRD §33).
    app.get('/api/v1/alert-rules', async () => this.alerts.listRules());
    app.post('/api/v1/alert-rules', async (req, reply) => {
      const rule = alertRuleSchema.parse(req.body);
      await this.alerts.upsertRule(rule);
      return reply.code(201).send(rule);
    });
    app.delete('/api/v1/alert-rules/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      await this.alerts.deleteRule(id);
      return reply.code(204).send();
    });
    app.get('/api/v1/alerts', async (req) => {
      const query = z.object({ firing: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
      return this.alerts.listAlerts(query);
    });

    // Expected-order registry (the LIS interface seam, PRD §27).
    app.get('/api/v1/orders', async () => this.orders.list());
    app.post('/api/v1/orders', async (req, reply) => {
      const order = orderSchema.parse(req.body);
      await this.orders.register({ ...order, receivedAt: new Date().toISOString() });
      return reply.code(201).send(order);
    });
    app.delete('/api/v1/orders/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      await this.orders.remove(id);
      return reply.code(204).send();
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