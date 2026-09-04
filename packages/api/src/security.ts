/**
 * API-key authentication + per-role authorization (PRD §34 Administration,
 * plan F2/F4 + J security workstream; M2 "security review" item).
 *
 * Model: each API key maps to ONE role, and each role grants a fixed set of
 * scopes (the per-role scope table below). This keeps authorization
 * reviewable in one place instead of scattered boolean checks. Roles map the
 * PRD §34 persona set onto the scaffold: Super/Facility/IT Admin → `admin`,
 * Integration Engineer → `engineer`, lab bench operators → `operator`,
 * read-only monitoring → `viewer`.
 *
 * Keys are presented as `Authorization: Bearer <secret>`. Only a SHA-256 hash
 * of the secret is stored (plus a short prefix for display); the plaintext is
 * returned exactly once, at creation. `AUTH_DISABLED=1` / omitting `keys` on
 * the ApiServer disables auth entirely (library default; the hub process is
 * secured by default — see packages/server).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Fastify request augmentation: the auth hook stamps the identified key +
// granted scope onto the request so handlers/hooks can attribute actions.
declare module 'fastify' {
  interface FastifyRequest {
    auth?: { key: ApiKey; scope?: ApiScope };
  }
}

// ---------------------------------------------------------------------------
// Roles + scopes
// ---------------------------------------------------------------------------

export type ApiKeyRole = 'admin' | 'engineer' | 'operator' | 'viewer';

export type ApiScope =
  | 'api:read' // any read endpoint (messages, devices, config, alerts…)
  | 'messages:write' // replay, DLQ discard, HELD release
  | 'devices:write' // register devices
  | 'config:write' // destinations/routes, profiles, alert rules, expected orders
  | 'keys:manage' // create/list/delete API keys
  | 'audit:read' // view the audit log
  | 'updates:manage'; // check/apply/rollback hub releases (signed)

export const API_KEY_ROLES: readonly ApiKeyRole[] = ['admin', 'engineer', 'operator', 'viewer'];

/** Per-role scope grants (PRD §34 RBAC). `admin` gets everything. */
export const ROLE_SCOPES: Record<ApiKeyRole, readonly ApiScope[]> = {
  admin: ['api:read', 'messages:write', 'devices:write', 'config:write', 'keys:manage', 'audit:read', 'updates:manage'],
  engineer: ['api:read', 'messages:write', 'devices:write', 'config:write'],
  operator: ['api:read', 'messages:write'],
  viewer: ['api:read'],
};

export function roleHasScope(role: ApiKeyRole | undefined, scope: ApiScope): boolean {
  if (!role) return false;
  return (ROLE_SCOPES[role] as readonly ApiScope[]).includes(scope);
}

/**
 * Method + route-pattern → required scope. The pattern is Fastify's registered
 * URL (placeholders intact, e.g. `/api/v1/messages/:id/replay`), matched via
 * `request.routeOptions`. Anything under /api/v1 NOT listed here is denied
 * (fail closed): a new route must be added to this table when it lands.
 * `/api/v1/health` and the console UI (`/`) are deliberately public.
 */
export const ROUTE_SCOPES: Record<string, ApiScope> = {
  // Data reads (viewer and up)
  'GET /api/v1/stats': 'api:read',
  'GET /api/v1/mappings': 'api:read',
  'GET /api/v1/devices': 'api:read',
  'GET /api/v1/messages': 'api:read',
  'GET /api/v1/messages/:id': 'api:read',
  'GET /api/v1/dlq': 'api:read',
  'GET /api/v1/held': 'api:read',
  'GET /api/v1/results': 'api:read',
  'GET /api/v1/destinations': 'api:read',
  'GET /api/v1/routes': 'api:read',
  'GET /api/v1/profiles': 'api:read',
  'GET /api/v1/profiles/:id': 'api:read',
  'GET /api/v1/profiles/:id/conformance': 'api:read',
  'GET /api/v1/alert-rules': 'api:read',
  'GET /api/v1/alerts': 'api:read',
  'GET /api/v1/orders': 'api:read',
  'GET /api/v1/me': 'api:read',
  // Management reads (admin)
  'GET /api/v1/keys': 'keys:manage',
  'GET /api/v1/audit': 'audit:read',
  // Message lifecycle actions (operator and up)
  'POST /api/v1/messages/:id/replay': 'messages:write',
  'POST /api/v1/messages/:id/discard': 'messages:write',
  'POST /api/v1/messages/:id/release': 'messages:write',
  // Device + integration configuration (engineer and up)
  'POST /api/v1/devices': 'devices:write',
  'POST /api/v1/destinations': 'config:write',
  'DELETE /api/v1/destinations/:id': 'config:write',
  'POST /api/v1/routes': 'config:write',
  'DELETE /api/v1/routes/:id': 'config:write',
  'POST /api/v1/profiles': 'config:write',
  'DELETE /api/v1/profiles/:id': 'config:write',
  'POST /api/v1/alert-rules': 'config:write',
  'DELETE /api/v1/alert-rules/:id': 'config:write',
  'POST /api/v1/orders': 'config:write',
  'DELETE /api/v1/orders/:id': 'config:write',
  // Key management (admin)
  'POST /api/v1/keys': 'keys:manage',
  'DELETE /api/v1/keys/:id': 'keys:manage',
  // Release info (read) + signed updates (admin)
  'GET /api/v1/version': 'api:read',
  'GET /api/v1/updates/status': 'api:read',
  'POST /api/v1/updates/check': 'updates:manage',
  'POST /api/v1/updates/apply': 'updates:manage',
  'POST /api/v1/updates/rollback': 'updates:manage',
};

// ---------------------------------------------------------------------------
// Key model + stores
// ---------------------------------------------------------------------------

export interface ApiKey {
  /** Stable slug identifying the key in logs/audit. */
  id: string;
  /** Human label, e.g. "demo admin key". */
  name: string;
  role: ApiKeyRole;
  /** Display prefix of the secret (never the secret itself). */
  prefix: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt?: string;
  /** Key id of whoever created it (audit/attribution; bootstrap keys have none). */
  createdBy?: string;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function generateSecret(): string {
  return `ihk_${randomBytes(24).toString('hex')}`;
}

export interface CreateKeyInput {
  /** Optional stable id (defaults to a generated one). */
  id?: string;
  name: string;
  role: ApiKeyRole;
  /** Optional caller-supplied secret (bootstrap from HUB_ADMIN_KEY; tests). */
  secret?: string;
  createdBy?: string;
}

export interface KeyStore {
  list(): ApiKey[] | Promise<ApiKey[]>;
  get(id: string): ApiKey | undefined | Promise<ApiKey | undefined>;
  /** Look up by presented secret (hashes it; never stores plaintext). */
  findBySecret(secret: string): ApiKey | undefined | Promise<ApiKey | undefined>;
  /** Create a key; returns the record plus the plaintext secret ONCE. */
  create(input: CreateKeyInput): { key: ApiKey; secret: string } | Promise<{ key: ApiKey; secret: string }>;
  remove(id: string): void | Promise<void>;
  /** Record successful use (for key lifecycle/rotation review). */
  touch(id: string): void | Promise<void>;
}

export class InMemoryKeyStore implements KeyStore {
  private readonly byId = new Map<string, ApiKey>();
  private readonly byHash = new Map<string, string>();

  list(): ApiKey[] {
    return [...this.byId.values()];
  }

  get(id: string): ApiKey | undefined {
    return this.byId.get(id);
  }

  findBySecret(secret: string): ApiKey | undefined {
    const id = this.byHash.get(hashSecret(secret));
    const key = id !== undefined ? this.byId.get(id) : undefined;
    return key?.enabled === false ? undefined : key;
  }

  create(input: CreateKeyInput): { key: ApiKey; secret: string } {
    const secret = input.secret ?? generateSecret();
    const key: ApiKey = {
      id: input.id ?? `key_${randomBytes(4).toString('hex')}`,
      name: input.name,
      role: input.role,
      prefix: secret.slice(0, 12),
      enabled: true,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
    };
    this.byId.set(key.id, key);
    this.byHash.set(hashSecret(secret), key.id);
    return { key, secret };
  }

  remove(id: string): void {
    const key = this.byId.get(id);
    if (key) {
      this.byId.delete(id);
      for (const [hash, keyId] of this.byHash) {
        if (keyId === id) this.byHash.delete(hash);
      }
    }
  }

  touch(id: string): void {
    const key = this.byId.get(id);
    if (key) key.lastUsedAt = new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Audit log (PRD §30: who/what/when/where/result)
// ---------------------------------------------------------------------------

export type AuditResult = 'ok' | 'error' | 'denied';

export interface AuditEntry {
  id: string;
  at: string;
  /** Present when a valid API key was identified. */
  actorKey?: string;
  actorName?: string;
  actorRole?: ApiKeyRole;
  /** e.g. 'POST /api/v1/messages/:id/release' (pattern, not concrete path). */
  action: string;
  /** e.g. message id, profile slug, destination id. */
  target?: string;
  result: AuditResult;
  statusCode?: number;
  /** Source address. */
  ip?: string;
  /** Before/after context (config bodies, params); JSON-safe. */
  detail?: Record<string, unknown>;
}

export interface AuditFilter {
  limit?: number;
  result?: AuditResult;
}

export interface AuditStore {
  append(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry | Promise<AuditEntry>;
  list(filter?: AuditFilter): AuditEntry[] | Promise<AuditEntry[]>;
}

export class InMemoryAuditStore implements AuditStore {
  private readonly entries: AuditEntry[] = [];

  constructor(private readonly maxEntries = 5000) {}

  append(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const full: AuditEntry = { ...entry, id: randomUUID(), at: new Date().toISOString() };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    return full;
  }

  /** Newest first. */
  list(filter: AuditFilter = {}): AuditEntry[] {
    let out = this.entries;
    if (filter.result) out = out.filter((e) => e.result === filter.result);
    const limit = Math.min(filter.limit ?? 100, 500);
    return [...out].reverse().slice(0, limit);
  }
}
