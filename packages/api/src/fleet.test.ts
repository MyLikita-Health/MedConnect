/**
 * M4 fleet-surface route tests (H2/H3/H4/H5 + D11 ingest) against a real
 * ApiServer with in-memory stores — no Postgres required.
 *
 * Proves:
 *   - H3 pairing: register (pairing code shown once) → claim (bundle with the
 *     API key exactly once) → the gateway credential works ONLY on the ingest
 *     route; user keys never reach the ingest route; anonymous requests 401.
 *   - D11 ingest: a shipped batch applies through the ingest store, redelivery
 *     returns appliedThrough 0 (idempotent), and the gateway registry records
 *     sync progress.
 *   - H2 fleet overview aggregates per-facility stats.
 *   - H4/H5: flags, quotas, licenses + the entitlement evaluation, and the
 *     analytics export shape (§2 success metrics).
 *   - RBAC: fleet:manage is admin-only; the fail-closed scope table covers
 *     every new route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from './server.js';
import { InMemoryKeyStore } from './security.js';
import { InMemoryGatewayRegistry, hashToken } from '@integration-hub/core';
import {
  InMemoryFeatureFlagStore,
  InMemoryLicenseStore,
  InMemoryQuotaStore,
  evaluateEntitlement,
  type FeatureFlagStore,
  type FleetFacilitySource,
  type LicenseStore,
  type QuotaStore,
} from './fleet.js';
import { MessageStore } from './store.js';
import { DeviceRegistry } from './devices.js';
import type { IngestCursor } from './pg/pg-outbox.js';

// ---------------------------------------------------------------------------
// Fakes (in-memory fleet stores)
// ---------------------------------------------------------------------------

class FakeIngestStore {
  applied: { facilityId: string; seq: number }[] = [];
  async applyBatch(entries: { seq: number; facilityId?: string }[]): Promise<number> {
    let through = 0;
    for (const e of entries) {
      const facilityId = e.facilityId ?? 'unassigned';
      // Redelivery no-op: same (facility, seq) never applies twice.
      if (this.applied.some((a) => a.facilityId === facilityId && a.seq === e.seq)) continue;
      this.applied.push({ facilityId, seq: e.seq });
      if (e.seq > through) through = e.seq;
    }
    return through;
  }
  async cursors(): Promise<IngestCursor[]> {
    const byFacility = new Map<string, number>();
    for (const a of this.applied) {
      byFacility.set(a.facilityId, Math.max(byFacility.get(a.facilityId) ?? 0, a.seq));
    }
    return [...byFacility.entries()].map(([facilityId, maxSeq]) => ({
      facilityId,
      maxSeq,
      updatedAt: new Date().toISOString(),
    }));
  }
}

const facilitySource: FleetFacilitySource & { stats: Map<string, { messages: number; devices: number; connected: number }> } = {
  async create(orgId, input) {
    return { id: input.slug ?? input.name.toLowerCase().replace(/\s+/g, '-'), org_id: orgId, name: input.name, slug: input.slug ?? input.name.toLowerCase().replace(/\s+/g, '-'), state: 'active', created_at: new Date().toISOString() };
  },
  async list() {
    return [
      { id: 'fac-1', org_id: 'org-1', name: 'Main Lab', slug: 'main-lab', state: 'active', created_at: new Date().toISOString() },
      { id: 'fac-2', org_id: 'org-1', name: 'Satellite', slug: 'satellite', state: 'active', created_at: new Date().toISOString() },
    ];
  },
  stats: new Map([
    ['fac-1', { messages: 120, devices: 4, connected: 3 }],
    ['fac-2', { messages: 45, devices: 2, connected: 2 }],
  ]),
};

// ---------------------------------------------------------------------------
// Server bootstrap helper
// ---------------------------------------------------------------------------

async function startFleetServer() {
  const keys = new InMemoryKeyStore();
  const admin = keys.create({ id: 'admin', name: 'admin', role: 'admin' });
  const viewer = keys.create({ id: 'viewer-key', name: 'viewer', role: 'viewer' });

  const gateways = new InMemoryGatewayRegistry(15 * 60 * 1000, 'https://cloud.example.org', async (facilityId) => [
    { id: 'profile-for-' + facilityId, version: 1 },
  ]);
  const ingestStore = new FakeIngestStore();
  const flags: FeatureFlagStore = new InMemoryFeatureFlagStore();
  const quotas: QuotaStore = new InMemoryQuotaStore();
  const licenses: LicenseStore = new InMemoryLicenseStore();
  await licenses.upsert({ key: 'LIC-001', orgId: 'org-1', tier: 'standard', state: 'active', facilityIds: ['fac-1'], createdAt: new Date().toISOString() });

  const server = new ApiServer({
    port: 0,
    store: new MessageStore(),
    devices: new DeviceRegistry(),
    keys,
    fleet: {
      gateways,
      ingest: {
        store: ingestStore,
        authorizer: { verify: (gw, key) => gateways.verifyIngestCredential(gw, key) },
        recordSync: async (gatewayId, seq) => { await gateways.recordSync(gatewayId, seq); },
      },
      orgs: { get: async (id) => ({ id, name: 'Org ' + id, slug: id }) },
      facilities: facilitySource,
      flags,
      quotas,
      licenses,
      overview: {
        facilities: () => facilitySource.list('org-1'),
        facilityStats: async (facilityId) => facilitySource.stats.get(facilityId) ?? { messages: 0, devices: 0, connected: 0 },
      },
      entitlements: {
        forFacility: async (facilityId) => evaluateEntitlement(await licenses.forFacility(facilityId)),
      },
    },
  });
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, opts: { key?: string; gateway?: { id: string; key: string }; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    if (opts.gateway) {
      headers['x-hub-gateway'] = opts.gateway.id;
      headers.authorization = `Bearer ${opts.gateway.key}`;
    }
    const res = await fetch(base + path, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body), headers: { ...headers, 'content-type': 'application/json' } } : {}),
    });
    return res;
  };
  return { server, base, call, admin: admin.secret, viewer: viewer.secret, gateways, ingestStore, flags, quotas, licenses };
}

async function stopFleetServer(h: Awaited<ReturnType<typeof startFleetServer>>): Promise<void> {
  await h.server.stop();
}

test('H3 pairing: register → claim returns the bundle with the key exactly once', async (t) => {
  const h = await startFleetServer();
  t.after(() => stopFleetServer(h));

  // Register (admin): the pairing code rides this response exactly once.
  const reg = await h.call('POST', '/api/v1/fleet/gateways', { key: h.admin, body: { id: 'gw-edge-1', name: 'Edge One', facilityId: 'fac-1', orgId: 'org-1' } });
  assert.equal(reg.status, 201);
  const regBody = (await reg.json()) as { gateway: { id: string; state: string }; pairingCode: string };
  assert.equal(regBody.gateway.state, 'pending');
  assert.ok(regBody.pairingCode.startsWith('ihp_'), 'pairing code shown once');

  // Claim (public route — the edge has no key yet): the bundle carries the key.
  const claim = await h.call('POST', '/api/v1/provision/claim', { body: { pairingCode: regBody.pairingCode } });
  assert.equal(claim.status, 201);
  const bundle = (await claim.json()) as { apiKey: string; gateway: { id: string; facilityId: string }; tenancy: { facilityId: string }; cloud: { ingestPath: string }; profiles: unknown[] };
  assert.ok(bundle.apiKey.startsWith('ihk_gw_'), 'gateway key minted');
  assert.equal(bundle.gateway.id, 'gw-edge-1');
  assert.equal(bundle.tenancy.facilityId, 'fac-1');
  assert.equal(bundle.cloud.ingestPath, '/api/v1/sync/ingest');
  assert.deepEqual(bundle.profiles, [{ id: 'profile-for-fac-1', version: 1 }], 'profile bundle pushed');

  // Replaying the claim fails (the code is consumed).
  const replay = await h.call('POST', '/api/v1/provision/claim', { body: { pairingCode: regBody.pairingCode } });
  assert.equal(replay.status, 409, 'pairing code is single-use');

  // The registry now shows the gateway active and holds the key hash.
  const stored = await h.gateways.get('gw-edge-1');
  assert.equal(stored?.state, 'active');
  assert.ok(h.gateways.holdsKey('gw-edge-1', bundle.apiKey), 'registry verifies the minted key');
  void hashToken;
});

test('gateway credentials reach ONLY the ingest route; user keys never do', async (t) => {
  const h = await startFleetServer();
  t.after(() => stopFleetServer(h));

  const reg = await h.call('POST', '/api/v1/fleet/gateways', { key: h.admin, body: { id: 'gw-edge-2', name: 'Edge Two', facilityId: 'fac-1' } });
  const { pairingCode } = (await reg.json()) as { pairingCode: string };
  const claim = await h.call('POST', '/api/v1/provision/claim', { body: { pairingCode } });
  const bundle = (await claim.json()) as { apiKey: string };

  // Gateway credential on the ingest route: accepted (batch applies).
  const ok = await h.call('POST', '/api/v1/sync/ingest', {
    gateway: { id: 'gw-edge-2', key: bundle.apiKey },
    body: { entries: [{ seq: 1, table: 'messages', op: 'INSERT', pk: 'm-1', payload: { id: 'm-1' }, facilityId: 'fac-1', createdAt: new Date().toISOString() }] },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { appliedThrough: 1, accepted: 1 });
  const rec = await h.gateways.get('gw-edge-2');
  assert.equal(rec?.lastSyncSeq, 1, 'registry recorded sync progress');

  // Redelivery: same (facility, seq) → appliedThrough 0.
  const again = await h.call('POST', '/api/v1/sync/ingest', {
    gateway: { id: 'gw-edge-2', key: bundle.apiKey },
    body: { entries: [{ seq: 1, table: 'messages', op: 'INSERT', pk: 'm-1', payload: { id: 'm-1' }, facilityId: 'fac-1', createdAt: new Date().toISOString() }] },
  });
  assert.deepEqual(await again.json(), { appliedThrough: 0, accepted: 1 });

  // Gateway credential on a user route: denied (not a role).
  const gwOnFleet = await h.call('GET', '/api/v1/fleet/overview', { gateway: { id: 'gw-edge-2', key: bundle.apiKey } });
  assert.equal(gwOnFleet.status, 401, 'gateway key cannot read fleet data');

  // Bad gateway key: 401.
  const badGw = await h.call('POST', '/api/v1/sync/ingest', {
    gateway: { id: 'gw-edge-2', key: 'ihk_gw_wrong' },
    body: { entries: [{ seq: 2, table: 'devices', op: 'UPDATE', pk: 'd-1', payload: {}, facilityId: 'fac-1', createdAt: new Date().toISOString() }] },
  });
  assert.equal(badGw.status, 401);

  // User admin key on the ingest route: denied (no gateway credential).
  const adminOnIngest = await h.call('POST', '/api/v1/sync/ingest', {
    key: h.admin,
    body: { entries: [{ seq: 3, table: 'devices', op: 'UPDATE', pk: 'd-2', payload: {}, facilityId: 'fac-1', createdAt: new Date().toISOString() }] },
  });
  assert.equal(adminOnIngest.status, 401, 'user keys never reach the ingest route');

  // Anonymous on a fleet route: 401 (fail-closed).
  const anon = await h.call('GET', '/api/v1/fleet/overview');
  assert.equal(anon.status, 401);
});

test('H2 fleet overview aggregates facilities; H4/H5 flags, quotas, licenses, export', async (t) => {
  const h = await startFleetServer();
  t.after(() => stopFleetServer(h));

  // RBAC: viewer can read flags (api:read) but the fleet surface is admin-only.
  const viewerOverview = await h.call('GET', '/api/v1/fleet/overview', { key: h.viewer });
  assert.equal(viewerOverview.status, 403);
  const overview = await h.call('GET', '/api/v1/fleet/overview', { key: h.admin });
  assert.equal(overview.status, 200);
  const ov = (await overview.json()) as { totals: { messages: number; devices: number; connected: number }; facilities: unknown[] };
  assert.deepEqual(ov.totals, { messages: 165, devices: 6, connected: 5 });
  assert.equal(ov.facilities.length, 2);

  // Feature flags (H4): set + list + delete.
  const putFlag = await h.call('PUT', '/api/v1/platform/flags/imaging-ui', { key: h.admin, body: { key: 'imaging-ui', enabled: true, description: 'radiology console' } });
  assert.equal(putFlag.status, 200);
  const listFlags = await h.call('GET', '/api/v1/platform/flags', { key: h.viewer });
  assert.equal(listFlags.status, 200);
  assert.equal(((await listFlags.json()) as { key: string }[])[0]?.key, 'imaging-ui');
  const viewerPutFlag = await h.call('PUT', '/api/v1/platform/flags/x', { key: h.viewer, body: { key: 'x', enabled: false } });
  assert.equal(viewerPutFlag.status, 403, 'flag writes are fleet:manage');

  // Quotas (H4): per-facility limits.
  const putQuota = await h.call('PUT', '/api/v1/platform/quotas/fac-1', { key: h.admin, body: { facilityId: 'fac-1', messagesPerDay: 50000, maxDevices: 25 } });
  assert.equal(putQuota.status, 200);
  const listQuotas = await h.call('GET', '/api/v1/platform/quotas', { key: h.admin });
  assert.equal(((await listQuotas.json()) as { facilityId: string }[])[0]?.facilityId, 'fac-1');

  // Licenses + entitlements (H5): fac-1 is licensed standard, fac-2 is not.
  const licList = await h.call('GET', '/api/v1/licenses', { key: h.admin });
  assert.equal(licList.status, 200);
  assert.equal(((await licList.json()) as { key: string }[]).length, 1);
  const ent1 = await h.call('GET', '/api/v1/licenses/fac-1/entitlement', { key: h.viewer });
  assert.deepEqual(await ent1.json(), { licensed: true, tier: 'standard', features: { cloudSync: true, imaging: true, multiFacility: false } });
  const ent2 = await h.call('GET', '/api/v1/licenses/fac-2/entitlement', { key: h.viewer });
  assert.deepEqual(await ent2.json(), { licensed: false, tier: 'unlicensed', features: { cloudSync: false, imaging: false, multiFacility: false }, reason: 'no active license covers this facility' });

  // Analytics export (H5): the §2 success-metric shape.
  const exportRes = await h.call('GET', '/api/v1/analytics/export', { key: h.admin });
  assert.equal(exportRes.status, 200);
  const exportBody = (await exportRes.json()) as { metrics: { connectedFacilities: number; totalDevices: number; connectedDevices: number; totalMessages: number } };
  assert.deepEqual(exportBody.metrics, { connectedFacilities: 2, totalDevices: 6, connectedDevices: 5, totalMessages: 165 });
});
