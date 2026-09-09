/**
 * H3 — gateway provisioning contracts (plan §7.H H3; PRD §42).
 *
 * A cloud platform manages a fleet of edge gateways. Onboarding a facility's
 * gateway is the pairing flow:
 *
 *   1. Cloud admin registers a gateway (POST /api/v1/fleet/gateways) → the
 *      cloud returns a PAIRING CODE shown exactly once.
 *   2. The edge claims it (POST /api/v1/provision/claim) → the cloud marks the
 *      gateway `active`, mints an API key (shown exactly once — the API-key
 *      pattern), and returns the provisioning bundle: gateway identity, cloud
 *      URLs, tenant stamps (org/facility) and the facility's device profiles.
 *   3. The edge stores the bundle in its state dir (encrypted-at-rest per §4.3;
 *      file perms 0600 here) and syncs via the D11 outbox.
 *
 * Pairing codes are single-use and expire (HUB_GATEWAY_PAIRING_TTL_MS,
 * default 15 min). Claims are idempotent per gateway (re-claim returns the
 * SAME bundle when the stored key still hashes to the same secret — but the
 * plaintext secret is only ever returned on the FIRST claim).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type GatewayState = 'pending' | 'active' | 'revoked';

export interface GatewayRecord {
  id: string;
  name: string;
  /** Facility this gateway ships data for (the ingest routing key). */
  facilityId: string;
  orgId?: string;
  state: GatewayState;
  /** ISO instant the pairing code expires (pending state only). */
  pairingExpiresAt?: string;
  /** ISO instant of the successful claim (pending → active). */
  claimedAt?: string;
  /** Best-effort last sync visibility (D11 status surfacing, H4). */
  lastSyncSeq?: number;
  lastSyncAt?: string;
  createdAt: string;
}

/** The provisioning bundle returned by a successful claim (step 2). */
export interface ProvisionBundle {
  gateway: { id: string; name: string; facilityId: string; orgId?: string };
  /** Cloud sync + API endpoints (outbound only; PRD §42). */
  cloud: { baseUrl: string; ingestPath: string };
  /** API key secret — shown exactly once, on the FIRST claim only. */
  apiKey?: string;
  /** Tenant stamps the edge writes into every synced row. */
  tenancy: { orgId: string; facilityId: string };
  /** Certified device profiles to install on the edge (config-first, §6.3). */
  profiles: unknown[];
  claimedAt: string;
}

/** Input to register a gateway (cloud admin action). */
export interface RegisterGatewayInput {
  id?: string;
  name: string;
  facilityId: string;
  orgId?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GatewayProvisionError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'wrong-state' | 'expired' | 'invalid-code' | 'conflict',
  ) {
    super(message);
    this.name = 'GatewayProvisionError';
  }
}

// ---------------------------------------------------------------------------
// Registry (core, storage-agnostic)
// ---------------------------------------------------------------------------

export interface GatewayRegistry {
  register(input: RegisterGatewayInput): Promise<GatewayRecord>;
  get(id: string): Promise<GatewayRecord | undefined>;
  list(): Promise<GatewayRecord[]>;
  /** Consume the pairing code: returns the gateway when valid + unexpired. */
  claimByPairingCode(code: string): Promise<GatewayRecord>;
  /** Mark claimed + issue/store the key hash + return the updated record. */
  markClaimed(id: string, apiKeyHash: string): Promise<GatewayRecord>;
  /** Record sync progress (D11 status surfacing). */
  recordSync(id: string, seq: number): Promise<void>;
  /** Revoke (fleet offboarding; the edge's key stops working). */
  revoke(id: string): Promise<GatewayRecord | undefined>;
}

/** Cloud-side provisioning surface the REST layer drives (minted keys, the
 *  profile bundle, the cloud base URL for the bundle). The in-memory registry
 *  implements it; a PG registry would persist the key hashes. */
export interface GatewayProvisioner extends GatewayRegistry {
  /** Cloud base URL stamped into the provisioning bundle. */
  readonly cloudBaseUrl: string;
  /** Mint + store a gateway API key; returns the plaintext (shown once). */
  mintApiKey(gatewayId: string): string;
  /** Device profiles to install on the edge (config-first §6.3). */
  provisioningProfiles(facilityId: string): Promise<unknown[]>;
}

export interface GatewayPairing {
  /** Prefix form stored on the record for display (never the code itself). */
  code: string;
  record: GatewayRecord;
}

/** In-memory registry + provisioner (tests / single-node cloud). */
export class InMemoryGatewayRegistry implements GatewayProvisioner {
  private readonly byId = new Map<string, GatewayRecord>();
  /** pairing code hash → gateway id */
  private readonly codeHashes = new Map<string, string>();
  /** gateway id → minted API key hash (the claim mints; revoke clears) */
  private readonly keyHashes = new Map<string, string>();

  constructor(
    private readonly pairingTtlMs = 15 * 60 * 1000,
    readonly cloudBaseUrl = '',
    private readonly profilesFor: (facilityId: string) => Promise<unknown[]> = async () => [],
  ) {}

  async register(input: RegisterGatewayInput): Promise<GatewayRecord> {
    const id = input.id ?? `gw-${randomBytes(4).toString('hex')}`;
    if (this.byId.has(id)) throw new GatewayProvisionError(`gateway ${id} exists`, 'conflict');
    const now = new Date();
    const record: GatewayRecord = {
      id,
      name: input.name,
      facilityId: input.facilityId,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      state: 'pending',
      pairingExpiresAt: new Date(now.getTime() + this.pairingTtlMs).toISOString(),
      createdAt: now.toISOString(),
    };
    const code = `ihp_${randomBytes(18).toString('hex')}`;
    this.byId.set(id, record);
    this.codeHashes.set(hashToken(code), id);
    return { ...record, pairingExpiresAt: record.pairingExpiresAt! };
  }

  /** The pairing code cannot be recovered later; tests mint one via this hook. */
  issuePairingCode(id: string): string {
    const record = this.byId.get(id);
    if (!record) throw new GatewayProvisionError(`gateway ${id} not found`, 'not-found');
    const code = `ihp_${randomBytes(18).toString('hex')}`;
    this.codeHashes.set(hashToken(code), id);
    return code;
  }

  /** Mint + store a gateway API key; returns the plaintext (shown exactly once). */
  mintApiKey(gatewayId: string): string {
    if (!this.byId.has(gatewayId)) throw new GatewayProvisionError(`gateway ${gatewayId} not found`, 'not-found');
    const secret = generateGatewayApiKey();
    this.keyHashes.set(gatewayId, hashToken(secret));
    return secret;
  }

  async provisioningProfiles(facilityId: string): Promise<unknown[]> {
    return this.profilesFor(facilityId);
  }

  async get(id: string): Promise<GatewayRecord | undefined> {
    return this.byId.get(id);
  }

  async list(): Promise<GatewayRecord[]> {
    return [...this.byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async claimByPairingCode(code: string): Promise<GatewayRecord> {
    const id = this.codeHashes.get(hashToken(code));
    if (!id) throw new GatewayProvisionError('unknown pairing code', 'invalid-code');
    const record = this.byId.get(id);
    if (!record) throw new GatewayProvisionError('unknown pairing code', 'invalid-code');
    if (record.state === 'active') throw new GatewayProvisionError(`gateway ${id} already claimed`, 'wrong-state');
    if (record.state === 'revoked') throw new GatewayProvisionError(`gateway ${id} revoked`, 'wrong-state');
    if (record.pairingExpiresAt && Date.parse(record.pairingExpiresAt) <= Date.now()) {
      throw new GatewayProvisionError(`pairing code for ${id} expired`, 'expired');
    }
    return record;
  }

  async markClaimed(id: string, apiKeyHash: string): Promise<GatewayRecord> {
    const record = this.byId.get(id);
    if (!record) throw new GatewayProvisionError(`gateway ${id} not found`, 'not-found');
    record.state = 'active';
    record.claimedAt = new Date().toISOString();
    delete record.pairingExpiresAt;
    this.keyHashes.set(id, apiKeyHash);
    return { ...record };
  }

  /** Verify an ingest credential: gateway id + its API key secret. */
  async verifyIngestCredential(gatewayId: string, apiKey: string): Promise<boolean> {
    const hash = this.keyHashes.get(gatewayId);
    if (!hash) return false;
    return timingSafeEqual(Buffer.from(hash), Buffer.from(hashToken(apiKey)));
  }

  async recordSync(id: string, seq: number): Promise<void> {
    const record = this.byId.get(id);
    if (record) {
      record.lastSyncSeq = seq;
      record.lastSyncAt = new Date().toISOString();
    }
  }

  async revoke(id: string): Promise<GatewayRecord | undefined> {
    const record = this.byId.get(id);
    if (!record) return undefined;
    record.state = 'revoked';
    this.keyHashes.delete(id);
    return { ...record };
  }

  /** Test hook: does this gateway hold this key? */
  holdsKey(id: string, apiKey: string): boolean {
    return this.keyHashes.get(id) === hashToken(apiKey);
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generatePairingCode(): string {
  return `ihp_${randomBytes(18).toString('hex')}`;
}

export function generateGatewayApiKey(): string {
  return `ihk_gw_${randomBytes(24).toString('hex')}`;
}
