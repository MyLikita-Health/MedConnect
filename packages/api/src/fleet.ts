/**
 * M4 cloud surface (plan §7.H): fleet + provisioning + sync ingest + platform
 * ops, mounted under /api/v1 by ApiServer when the respective options are set.
 *
 * Route groups (each fails closed via ROUTE_SCOPES + dedicated scopes):
 *
 *   /api/v1/fleet/gateways        — H3 gateway registry (admin: fleet:manage)
 *   /api/v1/fleet/overview        — H2 fleet aggregation (admin: fleet:manage)
 *   /api/v1/facilities            — H2 facility list/create (admin: fleet:manage)
 *   /api/v1/provision/claim       — H3 pairing claim (PUBLIC: the edge has no
 *                                    key yet — the pairing code IS the secret)
 *   /api/v1/sync/ingest           — D11 ingest (gateway credential: sync:write)
 *   /api/v1/platform/flags        — H4 feature flags (admin: config:write)
 *   /api/v1/platform/quotas       — H4 quotas (admin: fleet:manage)
 *   /api/v1/licenses              — H5 licenses (admin: fleet:manage)
 *   /api/v1/analytics/export      — H5 metrics export (admin: fleet:manage)
 *
 * The ingest route is the ONLY route a gateway credential can touch; gateway
 * keys never see fleet data (they are not members of any role that grants it).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { InMemoryGatewayRegistry, GatewayRecord } from '@integration-hub/core';

// ---------------------------------------------------------------------------
// Option blocks (structural — the server package owns the real stores)
// ---------------------------------------------------------------------------

/** Facility row shape (pg-tenancy.ts). */
export interface FacilityDto {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  state: string;
  created_at: string;
}

export interface FleetFacilitySource {
  create(orgId: string, input: { name: string; slug?: string }): Promise<FacilityDto>;
  list(orgId: string): Promise<FacilityDto[]>;
}

export interface FleetOrgSource {
  get(idOrSlug: string): Promise<{ id: string; name: string; slug: string } | undefined>;
}

/** Gateway credential for the ingest route (verified against the registry). */
export interface IngestAuthorizer {
  verify(gatewayId: string, apiKey: string): Promise<boolean>;
}

/** Feature flag store (H4): flags are data, not code (§3.3 invariant 3). */
export interface FeatureFlag {
  key: string;
  enabled: boolean;
  /** Optional facility scoping — absent = global. */
  facilityId?: string;
  description?: string;
  updatedAt: string;
}

export interface FeatureFlagStore {
  list(): Promise<FeatureFlag[]>;
  set(flag: FeatureFlag): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory flag store (default). */
export class InMemoryFeatureFlagStore implements FeatureFlagStore {
  private readonly flags = new Map<string, FeatureFlag>();
  async list(): Promise<FeatureFlag[]> {
    return [...this.flags.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
  async set(flag: FeatureFlag): Promise<void> {
    this.flags.set(flag.key, flag);
  }
  async remove(key: string): Promise<void> {
    this.flags.delete(key);
  }
}

/** Per-facility quota (H4). Limits are per rolling day. */
export interface FacilityQuota {
  facilityId: string;
  /** Max messages/day (0 = unlimited). */
  messagesPerDay: number;
  /** Max registered devices. */
  maxDevices: number;
  updatedAt: string;
}

export interface QuotaStore {
  list(): Promise<FacilityQuota[]>;
  set(quota: FacilityQuota): Promise<void>;
  remove(facilityId: string): Promise<void>;
}

export class InMemoryQuotaStore implements QuotaStore {
  private readonly quotas = new Map<string, FacilityQuota>();
  async list(): Promise<FacilityQuota[]> {
    return [...this.quotas.values()].sort((a, b) => a.facilityId.localeCompare(b.facilityId));
  }
  async set(quota: FacilityQuota): Promise<void> {
    this.quotas.set(quota.facilityId, quota);
  }
  async remove(facilityId: string): Promise<void> {
    this.quotas.delete(facilityId);
  }
}

/** License record (H5, PRD §61). Entitlement checks read these. */
export interface LicenseRecord {
  key: string;
  orgId: string;
  /** Entitlement tier: gates features at the gateway + API. */
  tier: 'trial' | 'standard' | 'enterprise';
  state: 'active' | 'expired' | 'revoked';
  expiresAt?: string;
  /** Facilities covered (absent = whole org). */
  facilityIds?: string[];
  createdAt: string;
}

export interface LicenseStore {
  list(): Promise<LicenseRecord[]>;
  upsert(license: LicenseRecord): Promise<void>;
  remove(key: string): Promise<void>;
  /** Resolve the license covering one facility (active + not expired). */
  forFacility(facilityId: string): Promise<LicenseRecord | undefined>;
}

export class InMemoryLicenseStore implements LicenseStore {
  private readonly byKey = new Map<string, LicenseRecord>();
  async list(): Promise<LicenseRecord[]> {
    return [...this.byKey.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async upsert(license: LicenseRecord): Promise<void> {
    this.byKey.set(license.key, license);
  }
  async remove(key: string): Promise<void> {
    this.byKey.delete(key);
  }
  async forFacility(facilityId: string): Promise<LicenseRecord | undefined> {
    for (const license of this.byKey.values()) {
      if (license.state !== 'active') continue;
      if (license.expiresAt && Date.parse(license.expiresAt) <= Date.now()) continue;
      if (license.facilityIds && !license.facilityIds.includes(facilityId)) continue;
      return license;
    }
    return undefined;
  }
}

/** Entitlement evaluation (H5): the API-side gate mirroring the edge's. */
export interface Entitlement {
  licensed: boolean;
  tier: 'trial' | 'standard' | 'enterprise' | 'unlicensed';
  /** Feature gates the tier unlocks (mirrored at the gateway). */
  features: { cloudSync: boolean; imaging: boolean; multiFacility: boolean };
  reason?: string;
}

export function evaluateEntitlement(license: LicenseRecord | undefined, now = Date.now()): Entitlement {
  if (!license) {
    return { licensed: false, tier: 'unlicensed', features: { cloudSync: false, imaging: false, multiFacility: false }, reason: 'no active license covers this facility' };
  }
  if (license.state === 'revoked') {
    return { licensed: false, tier: 'unlicensed', features: { cloudSync: false, imaging: false, multiFacility: false }, reason: 'license revoked' };
  }
  if (license.expiresAt && Date.parse(license.expiresAt) <= now) {
    return { licensed: false, tier: 'unlicensed', features: { cloudSync: false, imaging: false, multiFacility: false }, reason: 'license expired' };
  }
  const features =
    license.tier === 'enterprise'
      ? { cloudSync: true, imaging: true, multiFacility: true }
      : license.tier === 'standard'
        ? { cloudSync: true, imaging: true, multiFacility: false }
        : { cloudSync: true, imaging: false, multiFacility: false };
  return { licensed: true, tier: license.tier, features };
}

// ---------------------------------------------------------------------------
// Ingest schema (D11): the shipped entry shape, zod-validated at the boundary.
// ---------------------------------------------------------------------------

const outboxEntrySchema = z.object({
  seq: z.number().int().positive(),
  table: z.enum(['messages', 'devices']),
  op: z.enum(['INSERT', 'UPDATE']),
  pk: z.string().min(1),
  payload: z.unknown(),
  orgId: z.string().optional(),
  facilityId: z.string().optional(),
  createdAt: z.string(),
});

export const ingestSchema = z.object({
  entries: z.array(outboxEntrySchema).min(1).max(1000),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface FleetRoutesOptions {
  gateways?: InMemoryGatewayRegistry;
  ingest?: {
    store: { applyBatch(entries: unknown[]): Promise<number>; cursors(): Promise<{ facilityId: string; maxSeq: number; updatedAt: string }[]> };
    authorizer: IngestAuthorizer;
    /** Record sync progress on the gateway registry after each accepted batch. */
    recordSync?: (gatewayId: string, seq: number) => Promise<void>;
  };
  orgs?: FleetOrgSource;
  facilities?: FleetFacilitySource;
  flags?: FeatureFlagStore;
  quotas?: QuotaStore;
  licenses?: LicenseStore;
  /** Aggregation source for the fleet overview (facility-scoped stats). */
  overview?: {
    facilities(): Promise<FacilityDto[]>;
    facilityStats(facilityId: string): Promise<{ messages: number; devices: number; connected: number }>;
  };
  /** Feature-flag evaluation for the entitlement surface (H4+H5). */
  entitlements?: { forFacility(facilityId: string): Promise<Entitlement> };
}

export function registerFleetRoutes(app: FastifyInstance, opts: FleetRoutesOptions): void {
  // -------------------------------------------------------------------------
  // H3 — gateway registry (admin)
  // -------------------------------------------------------------------------
  const registerGatewaySchema = z.object({
    id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
    name: z.string().min(1),
    facilityId: z.string().min(1),
    orgId: z.string().optional(),
  });

  app.post('/api/v1/fleet/gateways', async (req, reply) => {
    if (!opts.gateways) return reply.code(501).send({ error: 'gateway registry not configured' });
    const input = registerGatewaySchema.parse(req.body);
    // The pairing code rides the response exactly once (API-key pattern).
    const record = await opts.gateways.register(input);
    const code = await opts.gateways.issuePairingCode(record.id);
    return reply.code(201).send({ gateway: record, pairingCode: code });
  });

  app.get('/api/v1/fleet/gateways', async (req, reply) => {
    if (!opts.gateways) return reply.code(501).send({ error: 'gateway registry not configured' });
    void req;
    const gateways = await opts.gateways.list();
    // Pairing codes are never listed — only their state + expiry.
    return gateways.map((g) => ({
      ...g,
      pairingCode: undefined,
      ...(g.pairingExpiresAt ? { pairingPending: true } : { pairingPending: false }),
    }));
  });

  app.get('/api/v1/fleet/gateways/:id', async (req, reply) => {
    if (!opts.gateways) return reply.code(501).send({ error: 'gateway registry not configured' });
    const { id } = req.params as { id: string };
    const gateway = await opts.gateways.get(id);
    if (!gateway) return reply.code(404).send({ error: 'gateway not found' });
    return gateway;
  });

  app.post('/api/v1/fleet/gateways/:id/revoke', async (req, reply) => {
    if (!opts.gateways) return reply.code(501).send({ error: 'gateway registry not configured' });
    const { id } = req.params as { id: string };
    const revoked = await opts.gateways.revoke(id);
    if (!revoked) return reply.code(404).send({ error: 'gateway not found' });
    return revoked;
  });

  // -------------------------------------------------------------------------
  // H3 — pairing claim (PUBLIC; the pairing code is the credential).
  // Registered OUTSIDE the auth preHandler path by the server (public route).
  // Returns the bundle with the API key exactly once.
  // -------------------------------------------------------------------------
  const claimSchema = z.object({
    pairingCode: z.string().min(8),
    /** The edge identifies its version (fleet diagnostics, H2). */
    edgeVersion: z.string().optional(),
  });

  app.post('/api/v1/provision/claim', async (req, reply) => {
    if (!opts.gateways) return reply.code(501).send({ error: 'gateway registry not configured' });
    const input = claimSchema.parse(req.body);
    let gateway: GatewayRecord;
    try {
      gateway = await opts.gateways.claimByPairingCode(input.pairingCode);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const status = code === 'expired' ? 410 : code === 'invalid-code' ? 401 : 409;
      return reply.code(status).send({ error: (err as Error).message, code });
    }
    // Mint the gateway API key (shown exactly once) + flip to active.
    const apiKey = opts.gateways.mintApiKey(gateway.id);
    const claimed = await opts.gateways.markClaimed(gateway.id, hashOf(apiKey));
    const profiles = await opts.gateways.provisioningProfiles(gateway.facilityId);
    const bundle = {
      gateway: { id: claimed.id, name: claimed.name, facilityId: claimed.facilityId, ...(claimed.orgId ? { orgId: claimed.orgId } : {}) },
      cloud: { baseUrl: opts.gateways.cloudBaseUrl ?? '', ingestPath: '/api/v1/sync/ingest' },
      apiKey,
      tenancy: { orgId: claimed.orgId ?? '', facilityId: claimed.facilityId },
      profiles,
      claimedAt: claimed.claimedAt ?? new Date().toISOString(),
    };
    return reply.code(201).send(bundle);
  });

  // -------------------------------------------------------------------------
  // D11 — sync ingest (gateway credential, x-hub-gateway + Bearer).
  // Auth is enforced by the server's preHandler override (see server.ts):
  // this route requires a VALID gateway credential, not a user role.
  // -------------------------------------------------------------------------
  app.post('/api/v1/sync/ingest', async (req, reply) => {
    if (!opts.ingest) return reply.code(501).send({ error: 'sync ingest not configured' });
    const body = ingestSchema.parse(req.body);
    const appliedThrough = await opts.ingest.store.applyBatch(body.entries);
    const gatewayId = (req.headers['x-hub-gateway'] as string) ?? '';
    if (opts.ingest.recordSync) await opts.ingest.recordSync(gatewayId, appliedThrough);
    return reply.code(200).send({ appliedThrough, accepted: body.entries.length });
  });

  app.get('/api/v1/sync/cursors', async (_req, reply) => {
    if (!opts.ingest) return reply.code(501).send({ error: 'sync ingest not configured' });
    return opts.ingest.store.cursors();
  });

  // -------------------------------------------------------------------------
  // H2 — facilities + fleet overview (admin)
  // -------------------------------------------------------------------------
  const facilitySchema = z.object({ name: z.string().min(1), slug: z.string().optional() });

  app.get('/api/v1/facilities', async (req) => {
    const orgId = (req.query as { orgId?: string }).orgId ?? (opts.orgs ? (await opts.orgs.get('self'))?.id : undefined);
    if (!orgId || !opts.facilities) return [];
    return opts.facilities.list(orgId);
  });

  app.post('/api/v1/facilities', async (req, reply) => {
    if (!opts.facilities || !opts.orgs) return reply.code(501).send({ error: 'facility stores not configured' });
    const org = (req.query as { orgId?: string }).orgId ? await opts.orgs.get((req.query as { orgId: string }).orgId!) : undefined;
    const input = facilitySchema.parse(req.body);
    const orgId = org?.id ?? (await opts.orgs.get('self'))?.id;
    if (!orgId) return reply.code(400).send({ error: 'no org available — bootstrap the cloud org first' });
    const facility = await opts.facilities.create(orgId, input);
    return reply.code(201).send(facility);
  });

  app.get('/api/v1/fleet/overview', async (_req, reply) => {
    if (!opts.overview) return reply.code(501).send({ error: 'fleet overview not configured' });
    const facilities = await opts.overview.facilities();
    const rows = await Promise.all(
      facilities.map(async (f) => ({
        facility: f,
        ...(await opts.overview!.facilityStats(f.id)),
      })),
    );
    return {
      generatedAt: new Date().toISOString(),
      facilities: rows,
      totals: rows.reduce(
        (acc, r) => ({
          messages: acc.messages + r.messages,
          devices: acc.devices + r.devices,
          connected: acc.connected + r.connected,
        }),
        { messages: 0, devices: 0, connected: 0 },
      ),
    };
  });

  // -------------------------------------------------------------------------
  // H4 — feature flags + quotas (admin)
  // -------------------------------------------------------------------------
  const flagSchema = z.object({
    key: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/),
    enabled: z.boolean(),
    facilityId: z.string().optional(),
    description: z.string().optional(),
  });

  app.get('/api/v1/platform/flags', async () => opts.flags ? opts.flags.list() : []);
  app.put('/api/v1/platform/flags/:key', async (req, reply) => {
    if (!opts.flags) return reply.code(501).send({ error: 'flag store not configured' });
    const { key } = req.params as { key: string };
    const input = flagSchema.parse(req.body);
    if (input.key !== key) return reply.code(400).send({ error: 'key in body must match the URL' });
    await opts.flags.set({ ...input, updatedAt: new Date().toISOString() });
    return reply.code(200).send({ key, enabled: input.enabled });
  });
  app.delete('/api/v1/platform/flags/:key', async (req, reply) => {
    if (!opts.flags) return reply.code(501).send({ error: 'flag store not configured' });
    const { key } = req.params as { key: string };
    await opts.flags.remove(key);
    return reply.code(204).send();
  });

  const quotaSchema = z.object({
    facilityId: z.string().min(1),
    messagesPerDay: z.number().int().min(0).max(10_000_000),
    maxDevices: z.number().int().min(0).max(100_000),
  });

  app.get('/api/v1/platform/quotas', async () => opts.quotas ? opts.quotas.list() : []);
  app.put('/api/v1/platform/quotas/:facilityId', async (req, reply) => {
    if (!opts.quotas) return reply.code(501).send({ error: 'quota store not configured' });
    const { facilityId } = req.params as { facilityId: string };
    const input = quotaSchema.parse(req.body);
    if (input.facilityId !== facilityId) return reply.code(400).send({ error: 'facilityId in body must match the URL' });
    await opts.quotas.set({ ...input, updatedAt: new Date().toISOString() });
    return reply.code(200).send(input);
  });
  app.delete('/api/v1/platform/quotas/:facilityId', async (req, reply) => {
    if (!opts.quotas) return reply.code(501).send({ error: 'quota store not configured' });
    const { facilityId } = req.params as { facilityId: string };
    await opts.quotas.remove(facilityId);
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // H5 — licenses + entitlements + analytics export (admin)
  // -------------------------------------------------------------------------
  const licenseSchema = z.object({
    key: z.string().min(6).max(128),
    orgId: z.string().min(1),
    tier: z.enum(['trial', 'standard', 'enterprise']),
    state: z.enum(['active', 'expired', 'revoked']).default('active'),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    facilityIds: z.array(z.string()).optional(),
  });

  app.get('/api/v1/licenses', async () => opts.licenses ? opts.licenses.list() : []);
  app.put('/api/v1/licenses/:key', async (req, reply) => {
    if (!opts.licenses) return reply.code(501).send({ error: 'license store not configured' });
    const { key } = req.params as { key: string };
    const input = licenseSchema.parse(req.body);
    if (input.key !== key) return reply.code(400).send({ error: 'key in body must match the URL' });
    const license = { ...input, createdAt: new Date().toISOString() };
    await opts.licenses.upsert(license);
    return reply.code(200).send(license);
  });
  app.delete('/api/v1/licenses/:key', async (req, reply) => {
    if (!opts.licenses) return reply.code(501).send({ error: 'license store not configured' });
    const { key } = req.params as { key: string };
    await opts.licenses.remove(key);
    return reply.code(204).send();
  });

  app.get('/api/v1/licenses/:facilityId/entitlement', async (req, reply) => {
    const { facilityId } = req.params as { facilityId: string };
    if (opts.entitlements) return opts.entitlements.forFacility(facilityId);
    if (opts.licenses) {
      const license = await opts.licenses.forFacility(facilityId);
      return evaluateEntitlement(license);
    }
    return reply.code(501).send({ error: 'license store not configured' });
  });

  app.get('/api/v1/analytics/export', async (_req, reply) => {
    if (!opts.overview) return reply.code(501).send({ error: 'analytics export not configured' });
    const facilities = await opts.overview.facilities();
    const rows = await Promise.all(
      facilities.map(async (f) => ({
        facilityId: f.id,
        facilityName: f.name,
        ...(await opts.overview!.facilityStats(f.id)),
      })),
    );
    return reply
      .header('content-disposition', `attachment; filename="hub-analytics-${new Date().toISOString().slice(0, 10)}.json"`)
      .send({
        generatedAt: new Date().toISOString(),
        // §2 success metrics: connected facilities · devices · messages.
        metrics: {
          connectedFacilities: rows.length,
          totalDevices: rows.reduce((a, r) => a + r.devices, 0),
          connectedDevices: rows.reduce((a, r) => a + r.connected, 0),
          totalMessages: rows.reduce((a, r) => a + r.messages, 0),
        },
        facilities: rows,
      });
  });
}

/** SHA-256 hash helper. */
function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
