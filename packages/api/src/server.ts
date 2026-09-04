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
import { hubVersionInfo, type CanonicalMessage, type MappingTable } from '@integration-hub/shared';
import {
  DEFAULT_RETRY,
  InMemoryAdmissionRegistry,
  InMemoryAlertStore,
  InMemoryOrderRegistry,
  InMemoryProfileStore,
  InMemoryRouteStore,
  parseDeviceProfile,
  runStoredConformance,
  type AdmissionRegistry,
  type AlertStore,
  type OrderRegistry,
  type ProfileStore,
  type RouteStore,
  type UpdateAgent,
} from '@integration-hub/core';
import type { DeviceBackend, StoreBackend } from './backend.js';
import type { AuditStore, KeyStore } from './security.js';
import { InMemoryAuditStore, ROUTE_SCOPES, roleHasScope, secretNeverSeen, type ApiScope } from './security.js';
import { renderUi } from './ui.js';

/** PEM key + cert; when present the API listens on HTTPS (PRD §42 TLS). */
export interface ApiTls {
  key: string;
  cert: string;
}

// ---------------------------------------------------------------------------
// MWL study-monitor surface (M3.2/M3.3) — the JSON GET /api/v1/mwl returns.
// Structural DTOs: the server package owns the real MwlMonitor; this package
// only needs the shape (status snapshot + live worklist items from Orthanc).
// ---------------------------------------------------------------------------

/** One performed study the monitor observed (performed-studies view). */
export interface MwlPerformedDto {
  order: { accession: string; patientId?: string };
  study: {
    orthancId: string;
    accessionNumber?: string;
    studyDescription?: string;
    studyDate?: string;
    storageUrl: string;
  };
  at: string;
}

/** Monitor status snapshot (poll loop health + cumulative totals). */
export interface MwlStatusDto {
  enabled: boolean;
  baseUrl?: string;
  pollMs?: number;
  lastRunAt?: string;
  lastError?: string;
  totals: { created: number; queued: number; failed: number };
  performed: MwlPerformedDto[];
}

/** One live worklist item as Orthanc reports it (the worklist view). */
export interface MwlWorklistItemDto {
  worklistId: string;
  accession?: string;
  patientId?: string;
  patientName?: string;
  modality?: string;
  scheduledDate?: string;
}

/** The `hub.mwl` surface this package consumes (structural). */
export interface MwlStatusSource {
  status(): MwlStatusDto;
  worklist(): Promise<MwlWorklistItemDto[]>;
}

export interface ApiServerOptions {
  host?: string;
  port: number;
  /** PEM key + cert → HTTPS API + console. The console UI is served over TLS too. */
  tls?: ApiTls;
  store: StoreBackend;
  devices: DeviceBackend;
  /** Optional mapping table exposed read-only at /api/v1/mappings. */
  mappings?: MappingTable;
  /** Routing configuration (destinations + rules); defaults to an in-memory store. */
  routes?: RouteStore;
  /** Expected-order registry behind patient/order matching (PRD §27). */
  orders?: OrderRegistry;
  /**
   * Patient-admission registry behind the ADT^A01 feed (B2c extension);
   * read at GET /api/v1/admissions. Defaults to an in-memory registry.
   */
  admissions?: AdmissionRegistry;
  /**
   * MWL study monitor (M3.2/M3.3, `hub.mwl`): when wired, its status +
   * the live Orthanc worklist are read at GET /api/v1/mwl. Structural — the
   * server package owns the actual MwlMonitor.
   */
  mwl?: MwlStatusSource;
  /**
   * Imaging routing enabled (M3.3, `hub.imaging`): when true, the
   * performed-study messages in the store are surfaced at GET /api/v1/imaging
   * (study-status view — routed/duplicate/failed counts + recent messages).
   */
  imaging?: boolean;
  /** Alert rules + derived alerts (PRD §33); defaults to in-memory. */
  alerts?: AlertStore;
  /** Config-first device profiles (PRD §39–40); defaults to in-memory. */
  profiles?: ProfileStore;
  /** Wired to the gateway so failed messages can be corrected + replayed. */
  replayHandler?: (message: CanonicalMessage) => CanonicalMessage | Promise<CanonicalMessage>;
  /** Wired to the dispatcher so held messages can be released into delivery. */
  releaseHandler?: (id: string) => boolean | Promise<boolean>;
  /**
   * Wired to the dispatcher( s) so dead-lettered messages can be retried:
   * requeued under the current route rules (M3.4 imaging failure handling;
   * lab messages too). Returns false when the message is not DLQ'd.
   */
  retryHandler?: (id: string) => boolean | Promise<boolean>;
  /**
   * API-key store. When provided, every /api/v1 route (except health) is
   * behind key auth + per-role scopes (ROUTE_SCOPES) and every mutating
   * action is written to the audit store. When omitted, auth is disabled
   * (library default; the hub process enables it — see packages/server).
   */
  keys?: KeyStore;
  /** Audit log (PRD §30); defaults to an in-memory store when `keys` is set. */
  audit?: AuditStore;
  /**
   * Signed-update agent (plan G3 / §4.3). When wired, exposes
   * /api/v1/updates/* backed by the agent's state dir. When absent the
   * endpoints report the agent as not configured.
   */
  updates?: UpdateAgent;
}

const createKeySchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  name: z.string().min(1),
  role: z.enum(['admin', 'engineer', 'operator', 'viewer']),
  /** Optional ISO expiry — the key refuses authn past this instant. */
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

const updateKeySchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  /** ISO expiry to set, or null to clear an existing expiry. */
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

const listAuditSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  result: z.enum(['ok', 'error', 'denied']).optional(),
});

const registerDeviceSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  protocol: z.enum(['ASTM', 'HL7', 'FHIR', 'DICOM']).optional(),
  transport: z.enum(['tcp', 'serial', 'api']).optional(),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  /** A4 binding: certified DeviceProfile whose layout/mappings drive parsing. */
  profileId: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
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

const admissionSchema = z.object({
  patientId: z.string().min(1),
  name: z.string().optional(),
  dateOfBirth: z.string().optional(),
  gender: z.string().optional(),
  /** Visit / encounter number (PV1-19 on the wire). */
  visitId: z.string().optional(),
  status: z.enum(['admitted', 'discharged']).default('admitted'),
});

const alertRuleSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['device-offline', 'destination-down', 'dlq', 'held-backlog', 'profile-drift', 'orthanc-down']),
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

const destinationSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['console', 'http', 'hl7']).default('http'),
    name: z.string().min(1),
    url: z.string().url().optional(),
    /** MLLP endpoint for kind 'hl7' (workstream B3): host/port + MSH header fields. */
    hl7: z
      .object({
        host: z.string().min(1),
        port: z.number().int().positive().max(65535),
        sendingApp: z.string().optional(),
        sendingFacility: z.string().optional(),
        receivingApp: z.string().optional(),
        receivingFacility: z.string().optional(),
        version: z.string().optional(),
      })
      .optional(),
    enabled: z.boolean().default(true),
    retry: retrySchema.optional(),
  })
  .superRefine((d, ctx) => {
    if (d.kind === 'hl7' && !d.hl7) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hl7'], message: 'an hl7 destination requires an hl7 config (host + port)' });
    }
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
  private readonly admissions: AdmissionRegistry;
  private readonly alerts: AlertStore;
  private readonly profiles: ProfileStore;
  private readonly keys: KeyStore | undefined;
  private readonly audit: AuditStore | undefined;

  constructor(private opts: ApiServerOptions) {
    this.routes = opts.routes ?? new InMemoryRouteStore();
    this.orders = opts.orders ?? new InMemoryOrderRegistry();
    this.admissions = opts.admissions ?? new InMemoryAdmissionRegistry();
    this.alerts = opts.alerts ?? new InMemoryAlertStore();
    this.profiles = opts.profiles ?? new InMemoryProfileStore();
    this.keys = opts.keys;
    this.audit = opts.audit ?? (opts.keys ? new InMemoryAuditStore() : undefined);
    const app = Fastify({
      logger: false,
      bodyLimit: 1024 * 1024,
      ...(this.opts.tls ? { https: { key: this.opts.tls.key, cert: this.opts.tls.cert } } : {}),
    });
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

    // Security (M2, plan F2 + J; PRD §34): API-key authn + per-role scopes on
    // every /api/v1 route, and an audit trail for every mutating action
    // (PRD §30). Enabled when a KeyStore is provided; the route→scope table
    // (ROUTE_SCOPES in security.ts) is centralized + fail-closed: an
    // /api/v1 route with no declared scope is denied, not silently open.
    if (this.keys) {
      app.addHook('preHandler', async (req, reply) => {
        // Console UI + health probes stay public (no data exposure).
        const pattern: string | undefined = req.routeOptions.url;
        if (!req.url.startsWith('/api/v1/') || pattern === '/api/v1/health') return;

        const header = req.headers.authorization;
        const secret = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
        const key = secret ? await this.keys!.findBySecret(secret) : undefined;
        if (!key) {
          // 401 for everything under /api/v1 — unknown paths included, so the
          // surface is not enumerable without a valid key.
          return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid API key — send Authorization: Bearer <key>' });
        }
        // No matching route (routeOptions.url is undefined): not found — but
        // only for authenticated callers.
        if (pattern === undefined) {
          return reply.code(404).send({ error: 'not found' });
        }

        const route = `${req.method} ${pattern}`;
        const scope: ApiScope | undefined = ROUTE_SCOPES[route];
        req.auth = { key, scope };
        // Last-use stamp. Awaited so the next request observes it (rotation's
        // never-seen warning depends on ordering); failures never block auth.
        try {
          await this.keys!.touch(key.id);
        } catch {
          // best-effort: a failed stamp must not break the request
        }
        if (!scope) {
          // A registered route missing from ROUTE_SCOPES: config gap — deny loudly.
          return reply.code(403).send({ error: 'forbidden', reason: 'route has no declared scope (ROUTE_SCOPES)' });
        }
        if (!roleHasScope(key.role, scope)) {
          return reply.code(403).send({ error: 'forbidden', required: scope, role: key.role });
        }
      });

      // Audit every mutating action by an identified key (who/what/when/where/
      // result — PRD §30). Unauthenticated attempts are not attributable, so
      // they are not recorded; denied-but-identified attempts are.
      app.addHook('onResponse', async (req, reply) => {
        if (!this.audit) return;
        const route = `${req.method} ${req.routeOptions.url}`;
        const scope = ROUTE_SCOPES[route];
        if (!scope || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
        if (!req.auth) return;
        const params = req.params as Record<string, unknown>;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const statusCode = reply.statusCode;
        const result: 'ok' | 'error' | 'denied' = statusCode < 400 ? 'ok' : statusCode === 403 ? 'denied' : 'error';
        try {
          await this.audit.append({
            actorKey: req.auth.key.id,
            actorName: req.auth.key.name,
            actorRole: req.auth.key.role,
            action: route,
            target: typeof params.id === 'string' ? params.id : typeof body.id === 'string' ? body.id : undefined,
            result,
            statusCode,
            ip: req.ip,
            detail: {
              body: Object.keys(body).length > 0 ? body : undefined,
              params: Object.keys(params).length > 0 ? params : undefined,
            },
          });
        } catch (err) {
          // Never corrupt a response, but say so loudly: the action is NOT audited.
          console.error(`[audit] FAILED to record ${route} (${req.auth.key.id}): ${(err as Error).message}`);
        }
      });
    }

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
      // A4 seam: the profile must exist (and be reachable at parse time).
      if (input.profileId && !(await this.profiles.get(input.profileId))) {
        return reply.code(400).send({ error: `unknown device profile: ${input.profileId}` });
      }
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

    // Dead-letter retry (M3.4): requeue a FAILED message under the CURRENT
    // route rules — an operator fixed the destination, so delivery now routes.
    app.post('/api/v1/messages/:id/retry', async (req, reply) => {
      if (!this.opts.retryHandler) return reply.code(501).send({ error: 'retry not wired' });
      const { id } = req.params as { id: string };
      const message = await this.opts.store.get(id);
      if (!message) return reply.code(404).send({ error: 'message not found' });
      const retried = await this.opts.retryHandler(id);
      if (!retried) return reply.code(409).send({ error: 'message is not a dead-lettered failure' });
      return reply.code(200).send({ ok: true, id });
    });

    // Config-first device profiles (plan §6.3, workstream A2; PRD §39–40).
    app.get('/api/v1/profiles', async () => this.profiles.list());
    app.post('/api/v1/profiles', async (req, reply) => {
      const profile = parseDeviceProfile(req.body); // zod: 400 on invalid input
      await this.profiles.upsert(profile);
      return reply.code(201).send(profile);
    });
    app.get('/api/v1/profiles/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const profile = await this.profiles.get(id);
      if (!profile) return reply.code(404).send({ error: 'profile not found' });
      return profile;
    });

    // Golden conformance for a stored profile (workstream K): re-runs the
    // profile's CURRENT config against its recorded golden transcripts.
    app.get('/api/v1/profiles/:id/conformance', async (req, reply) => {
      const { id } = req.params as { id: string };
      const profile = await this.profiles.get(id);
      if (!profile) return reply.code(404).send({ error: 'profile not found' });
      return runStoredConformance(profile);
    });
    app.delete('/api/v1/profiles/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      await this.profiles.remove(id);
      return reply.code(204).send();
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

    // Patient-admission registry (the ADT feed, B2c extension). The wire
    // (ADT^A01 over MLLP) is the primary source; POST exists for hubs without
    // the HL7 port, exactly like POST /api/v1/orders.
    app.get('/api/v1/admissions', async () => this.admissions.list());
    app.post('/api/v1/admissions', async (req, reply) => {
      const admission = admissionSchema.parse(req.body);
      await this.admissions.register({ ...admission, receivedAt: new Date().toISOString() });
      return reply.code(201).send(admission);
    });

    // MWL study monitor (M3.2/M3.3): the monitor's status + the live Orthanc
    // worklist — performed studies and queued imaging orders become visible.
    // The worklist query hits Orthanc per request; when it fails (e.g. Orthanc
    // down) the status is still returned with a worklistError explaining why.
    app.get('/api/v1/mwl', async (req, reply) => {
      if (!this.opts.mwl) {
        return reply.code(404).send({ error: 'MWL study monitor not configured (set ORTHANC_URL)' });
      }
      const status = this.opts.mwl.status();
      try {
        return { status, worklist: await this.opts.mwl.worklist() };
      } catch (err) {
        return { status, worklist: [], worklistError: err instanceof Error ? err.message : String(err) };
      }
    });

    // Imaging study-status view (M3.3): the performed-study messages the
    // storage router pushed through the dispatcher, with per-status counts.
    // Store-backed — imaging events land in the same store as lab messages,
    // so the operator sees how studies are routing (ROUTED / DUPLICATE /
    // FAILED-DLQ) without the console logs.
    app.get('/api/v1/imaging', async (req, reply) => {
      if (!this.opts.imaging) {
        return reply.code(404).send({ error: 'imaging routing not configured (set ORTHANC_URL)' });
      }
      const messages = (await this.opts.store.list({ limit: 500 })).filter((m) => m.imaging !== undefined);
      const byStatus: Record<string, number> = {};
      for (const m of messages) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
      return { total: messages.length, byStatus, messages: messages.slice(0, 100) };
    });

    // Release identity (M2 installer/update: version is the update axis).
    app.get('/api/v1/version', async () => hubVersionInfo());

    // Signed remote updates (plan G3, M2 gate item). Reads work for anyone;
    // check/apply/rollback are admin-only (updates:manage scope).
    app.get('/api/v1/updates/status', async () => {
      if (!this.opts.updates) {
        return { enabled: false, reason: 'update agent not configured (set HUB_STATE_DIR / UPDATE_SOURCE / UPDATE_PUBLIC_KEY)' };
      }
      return this.opts.updates.status();
    });
    app.post('/api/v1/updates/check', async (req, reply) => {
      if (!this.opts.updates) return reply.code(501).send({ error: 'update agent not configured' });
      return this.opts.updates.check();
    });
    app.post('/api/v1/updates/apply', async (req, reply) => {
      if (!this.opts.updates) return reply.code(501).send({ error: 'update agent not configured' });
      const actor = req.auth?.key?.id;
      const result = await this.opts.updates.apply(actor);
      if (!result.staged) return reply.code(409).send({ error: result.reason ?? 'update not staged' });
      return reply.code(202).send(result);
    });
    app.post('/api/v1/updates/rollback', async (req, reply) => {
      if (!this.opts.updates) return reply.code(501).send({ error: 'update agent not configured' });
      const actor = req.auth?.key?.id;
      const result = await this.opts.updates.rollback(actor);
      if (!result.staged) return reply.code(409).send({ error: result.reason ?? 'rollback not staged' });
      return reply.code(202).send(result);
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

    // Security endpoints (only meaningful with auth enabled): identify the
    // calling key, manage API keys, and query the audit log.
    if (this.keys) {
      app.get('/api/v1/me', async (req) => {
        const { key } = req.auth!;
        return { id: key.id, name: key.name, role: key.role, prefix: key.prefix, enabled: key.enabled, createdAt: key.createdAt, expiresAt: key.expiresAt };
      });

      app.get('/api/v1/keys', async () => this.keys!.list());

      app.post('/api/v1/keys', async (req, reply) => {
        const input = createKeySchema.parse(req.body);
        if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
          return reply.code(400).send({ error: 'expiresAt must be in the future' });
        }
        const created = await this.keys!.create({ ...input, createdBy: req.auth!.key.id });
        // The plaintext secret is returned exactly once, here.
        return reply.code(201).send(created);
      });

      // Key lifecycle (rotation ergonomics): rename, disable (keep the record
      // + audit trail), expiry dates — plus re-issue via POST …/rotate, which
      // warns when the outgoing secret was never presented. Mutations land in
      // the audit log through the generic onResponse hook (target = key id).
      app.patch('/api/v1/keys/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const patch = updateKeySchema.parse(req.body);
        const key = await this.keys!.get(id);
        if (!key) return reply.code(404).send({ error: 'key not found' });
        // Expiry dates are future-only: a past date means "already expired",
        // which disables by accident — clear it instead.
        if (patch.expiresAt && Date.parse(patch.expiresAt) <= Date.now()) {
          return reply.code(400).send({ error: 'expiresAt must be in the future' });
        }
        // Lockout guard: never let the acting key disable itself (its request
        // would be the last thing it ever authenticates). Deleting self is
        // already blocked; disabling self is the same trap.
        if (id === req.auth!.key.id && patch.enabled === false) {
          return reply.code(400).send({ error: 'cannot disable the API key in use — use another admin key' });
        }
        const updated = await this.keys!.update(id, patch);
        return reply.code(200).send(updated);
      });

      app.post('/api/v1/keys/:id/rotate', async (req, reply) => {
        const { id } = req.params as { id: string };
        const before = await this.keys!.get(id);
        if (!before) return reply.code(404).send({ error: 'key not found' });
        // Audit-friendly re-issue: when the outgoing secret was never seen
        // (issued but never authenticated), say so — rotating may strand the
        // person who holds it, or retire a key nobody ever used. Computed from
        // the pre-rotation snapshot (stores may mutate in place on rotate).
        const warnNeverSeen = secretNeverSeen(before);
        const rotated = await this.keys!.rotateSecret(id);
        if (!rotated) return reply.code(404).send({ error: 'key not found' });
        const { key, secret } = rotated;
        const response: Record<string, unknown> = { key, secret };
        if (warnNeverSeen) {
          response.warning = 'the outgoing secret was never used since it was issued — confirm this key is actually in service before distributing the new one';
        }
        return reply.code(200).send(response);
      });

      app.delete('/api/v1/keys/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        if (id === req.auth!.key.id) {
          return reply.code(400).send({ error: 'cannot delete the API key in use' });
        }
        await this.keys!.remove(id);
        return reply.code(204).send();
      });

      app.get('/api/v1/audit', async (req) => {
        const query = listAuditSchema.parse(req.query);
        return this.audit!.list(query);
      });
    }

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
      ...hubVersionInfo(),
    };
  }
}

function reqLogger(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api] ${message}`);
}