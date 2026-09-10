/** @packageDocumentation
 * W4 — cloud-pairing readiness (docs/windows-desktop-installer.md §8.4).
 *
 * A local (SQLite) edge starts standalone; pairing to a cloud org/facility is
 * a CONTROLLED flow, not a re-install. The operator completes the H3 claim
 * from the edge console:
 *
 *   GET  /api/v1/pairing/status   public — state + identity, never secrets
 *   POST /api/v1/pairing/claim    public ONLY while unpaired (the W2
 *                                 setup-completion pattern): proxies the
 *                                 pairing code to the cloud's
 *                                 POST /api/v1/provision/claim and persists
 *                                 the returned bundle
 *   POST /api/v1/pairing/unpair   config:write (admin) — forgets the cloud
 *                                 binding (outbox rows are kept; data stays)
 *
 * Cloud contract (H3, fleet.ts): the bundle carries { gateway{id,facilityId,
 * orgId}, cloud{baseUrl,ingestPath}, apiKey, tenancy{orgId,facilityId} }.
 * The gateway API key (ihk_gw_…) is stored at rest in the SQLite file — the
 * same trust domain as the hub's other at-rest credentials — and is NEVER
 * echoed back over the API: it exists for the D11 syncer, not the operator.
 *
 * Storage keys (SqliteLocalSettingsStore): `pairing` (PairingState) and
 * `cloud` (CloudSyncSettings). startHub applies `cloud` on boot with the W3
 * precedence: opts > env > stored.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { SqliteLocalSettingsStore } from './sqlite/index.js';

/** Durable record of the pairing (settings key `pairing`). */
export interface PairingState {
  state: 'paired';
  gatewayId: string;
  gatewayName?: string;
  facilityId: string;
  orgId?: string;
  claimedAt: string;
}

/** The syncer's connection settings (settings key `cloud`), W3 precedence. */
export interface CloudSyncSettings {
  cloudBaseUrl: string;
  gatewayId: string;
  gatewayKey: string;
  /** Where the bundle said to POST sync batches (informational). */
  ingestPath?: string;
}

const claimSchema = z.object({
  /** The cloud base URL, e.g. https://cloud.example.com — handed to the
   *  operator together with the pairing code (no discovery step). */
  cloudBaseUrl: z.string().url().max(200),
  /** The operator's one-shot pairing code from the cloud admin (ihp_…). */
  pairingCode: z.string().min(8).max(200),
});

/** Normalizes a base URL (trailing slash off) and returns the claim URL. */
function claimUrlFor(cloudBaseUrl: string): string {
  return `${cloudBaseUrl.replace(/\/+$/, '')}/api/v1/provision/claim`;
}

export interface PairingRoutesOptions {
  settings: SqliteLocalSettingsStore;
  /** Factory for the claim proxy — injectable for tests (mock cloud). */
  fetchImpl?: typeof fetch;
  /** Claim request timeout in ms. */
  timeoutMs?: number;
}

/** Mount /api/v1/pairing/* on the API. */
export function registerPairingRoutes(app: FastifyInstance, opts: PairingRoutesOptions): void {
  const { settings } = opts;
  const doFetch = opts.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const pairState = () => settings.get<PairingState>('pairing');
  const cloud = () => settings.get<CloudSyncSettings>('cloud');

  app.get('/api/v1/pairing/status', async () => {
    const paired = pairState();
    if (!paired) return { paired: false as const };
    return {
      paired: true as const,
      gatewayId: paired.gatewayId,
      ...(paired.gatewayName ? { gatewayName: paired.gatewayName } : {}),
      facilityId: paired.facilityId,
      ...(paired.orgId ? { orgId: paired.orgId } : {}),
      claimedAt: paired.claimedAt,
      // The syncer's view (never the key itself).
      syncConfigured: Boolean(cloud()?.gatewayKey),
      syncEndpoint: cloud()?.cloudBaseUrl,
    };
  });

  app.post('/api/v1/pairing/claim', async (req, reply) => {
    // Public only while unpaired — checked HERE (fail-closed even if
    // PUBLIC_ROUTES changes) and mirrored in the auth hook (server.ts).
    if (pairState()) {
      return reply.code(409).send({ error: 'already-paired', message: 'this hub is already paired — unpair first (admin)' });
    }
    const input = claimSchema.parse(req.body);

    // Proxy the claim to the cloud (H3 contract). The pairing code IS the
    // credential; all cloud error codes map to their HTTP status.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let bundle: {
      gateway: { id: string; name?: string; facilityId: string; orgId?: string };
      cloud: { baseUrl: string; ingestPath?: string };
      apiKey: string;
      tenancy: { orgId?: string; facilityId: string };
      claimedAt?: string;
    };
    try {
      const res = await doFetch(claimUrlFor(input.cloudBaseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: input.pairingCode }),
        signal: controller.signal,
      });
      const body: unknown = await res.json().catch(() => undefined);
      if (res.status === 410) return reply.code(410).send({ error: 'code-expired', message: 'the pairing code expired — issue a new one in the cloud console' });
      if (res.status === 401) return reply.code(401).send({ error: 'invalid-code', message: 'the pairing code is not valid' });
      if (res.status === 409) return reply.code(409).send({ error: 'code-consumed', message: 'the pairing code was already used' });
      if (res.status === 501) return reply.code(502).send({ error: 'cloud-unconfigured', message: 'the cloud instance has no gateway registry configured' });
      if (!res.ok || typeof body !== 'object' || body === null || !('apiKey' in body)) {
        return reply.code(502).send({ error: 'claim-failed', message: `unexpected cloud response (HTTP ${res.status})` });
      }
      bundle = body as typeof bundle;
      // Defense in depth: the cloud must hand back a complete bundle.
      if (!bundle.gateway?.id || !bundle.tenancy?.facilityId || !bundle.apiKey) {
        return reply.code(502).send({ error: 'claim-failed', message: 'cloud returned an incomplete provisioning bundle' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = msg.includes('abort') || msg.includes('AbortError');
      return reply.code(aborted ? 504 : 502).send({
        error: aborted ? 'cloud-timeout' : 'cloud-unreachable',
        message: aborted ? `the cloud did not answer within ${Math.round(timeoutMs / 1000)}s` : `cannot reach the cloud: ${msg}`,
      });
    } finally {
      clearTimeout(timer);
    }

    // Persist identity + credentials, then flip the flag (same ordered pair
    // discipline as the W2 setup completion).
    const claimedAt = bundle.claimedAt ?? new Date().toISOString();
    settings.set('pairing', {
      state: 'paired',
      gatewayId: bundle.gateway.id,
      ...(bundle.gateway.name ? { gatewayName: bundle.gateway.name } : {}),
      facilityId: bundle.tenancy.facilityId,
      ...(bundle.tenancy.orgId ? { orgId: bundle.tenancy.orgId } : {}),
      claimedAt,
    } satisfies PairingState);
    settings.set('cloud', {
      // The bundle's cloud.baseUrl wins normalization; the operator's input
      // is the fallback (a cloud may report its own externally-visible URL).
      cloudBaseUrl: (bundle.cloud?.baseUrl || input.cloudBaseUrl).replace(/\/+$/, ''),
      gatewayId: bundle.gateway.id,
      gatewayKey: bundle.apiKey,
      ...(bundle.cloud?.ingestPath ? { ingestPath: bundle.cloud.ingestPath } : {}),
    } satisfies CloudSyncSettings);

    // The gateway API key NEVER echoes back (it rides the bundle exactly
    // once, cloud-side — here it goes straight to the syncer's config).
    return reply.code(201).send({
      paired: true,
      gatewayId: bundle.gateway.id,
      ...(bundle.gateway.name ? { gatewayName: bundle.gateway.name } : {}),
      facilityId: bundle.tenancy.facilityId,
      ...(bundle.tenancy.orgId ? { orgId: bundle.tenancy.orgId } : {}),
      claimedAt,
      syncEndpoint: (bundle.cloud?.baseUrl || input.cloudBaseUrl).replace(/\/+$/, ''),
    });
  });

  app.post('/api/v1/pairing/unpair', async () => {
    // config:write (admin) — enforced by ROUTE_SCOPES via the auth hook.
    settings.delete('pairing');
    settings.delete('cloud');
    return { paired: false };
  });
}
