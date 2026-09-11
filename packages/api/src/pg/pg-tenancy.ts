/** @packageDocumentation
 * H1 — Org → Facility hierarchy + Postgres RLS enforcement (plan §7.H H1,
 * decision D5 resolved: shared-schema + RLS, org-centric; one cloud
 * installation = one org, many facilities; facility is the RBAC + resource
 * isolation boundary).
 *
 * Tables (migration 0014_tenancy_orgs.sql):
 *   orgs        (id, name, slug, created_at)                       — cloud instance = one org
 *   facilities  (id, org_id FK → orgs, name, slug, state, created_at) — facility is the tenant-level isolation key
 *
 * The edge already carries org_id/facility_id scaffolding on devices + messages
 * (migration 0001_init.sql); those columns stay nullable on a single-facility
 * edge. In cloud mode they are ALWAYS populated: every device + message written
 * through the PG stores is stamped with the current org_id + facility_id (H1
 * write-through). Reads are scoped to the requesting facility unless the caller
 * is an org admin (list methods accept the requested facilityId).
 *
 * RLS (slice 2): enabled when the cloud org bootstrap has run (a "cloud context"
 * exists). The enablement is conservative: RLS is OFF on the raw tables during the
 * migration (so the bootstrap + single-tenant edge mode both keep working), and
 * only turned on + pointed at the current org when the cloud context is active.
 * This is the same reasoning already in §13.2: default-deny policies would break
 * single-tenant edge mode, so policies arrive with the cloud tenancy mechanism.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { slugify } from '../devices.js';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

interface FacilityRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  state: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Org + facility PG stores
// ---------------------------------------------------------------------------

export class PostgresOrgStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly pool: Pool) {}

  async create(input: { name: string; slug?: string }): Promise<OrgRow> {
    // The schema (0014) has no id default — generate it here so any database
    // state works (same pattern as the key store in pg-security.ts).
    const id = randomUUID();
    const slug = input.slug ?? slugify(input.name);
    const { rows } = await this.pool.query<OrgRow>(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, slug, created_at`,
      [id, input.name, slug],
    );
    return rows[0]!;
  }

  async get(idOrSlug: string): Promise<OrgRow | undefined> {
    const { rows } = await this.pool.query<OrgRow>(
      `SELECT id, name, slug, created_at FROM orgs WHERE id = $1 OR slug = $1`,
      [idOrSlug],
    );
    return rows[0];
  }

  async list(): Promise<OrgRow[]> {
    const { rows } = await this.pool.query<OrgRow>(`SELECT id, name, slug, created_at FROM orgs ORDER BY created_at ASC`);
    return rows;
  }

  async facilityCount(orgId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM facilities WHERE org_id = $1`,
      [orgId],
    );
    return rows[0]!.n;
  }

  /** Enable RLS on the org-scoped tables and install the org-level policies.
   *  Call only after the cloud org bootstrap has created the org + its first
   *  facility. Safe to call multiple times (idempotent CREATE POLICY).
   */
  async enableRlPolicies(currentOrgId: string, currentFacilityId?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // orgs — an org admin can read all orgs in their org (by org id); everyone
      // else sees nothing. For the bootstrap path we set a permissive policy on
      // the org the caller is operating in. (PostgreSQL has no CREATE POLICY
      // IF NOT EXISTS — DROP-guarded CREATE makes this re-runnable.)
      await client.query(`DROP POLICY IF EXISTS org_read_own ON orgs`);
      await client.query(`CREATE POLICY org_read_own ON orgs FOR SELECT USING (id = current_setting('app.tenant_org_id', true)::text)`);
      // facilities — scoped to the requesting facility unless the caller is an
      // org admin (set via app.tenant_admin = 't').
      await client.query(`DROP POLICY IF EXISTS facility_read_scope ON facilities`);
      await client.query(`DROP POLICY IF EXISTS facility_write_scope ON facilities`);
      await client.query(
        `CREATE POLICY facility_read_scope ON facilities FOR SELECT
         USING (org_id = current_setting('app.tenant_org_id', true)::text
               AND (current_setting('app.tenant_admin', true)::boolean IS TRUE OR id = current_setting('app.tenant_facility_id', true)::text))`,
      );
      await client.query(
        `CREATE POLICY facility_write_scope ON facilities FOR ALL
         USING (org_id = current_setting('app.tenant_org_id', true)::text
               AND (current_setting('app.tenant_admin', true)::boolean IS TRUE))`,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Disable RLS on the org-scoped tables (undoes enableRlPolicies). Safe to
   *  call; dropping the policies leaves the tables fully accessible — used to
   *  leave single-tenant edge mode intact when the cloud context is absent.
   */
  async disableRlPolicies(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DROP POLICY IF EXISTS org_read_own ON orgs`);
      await client.query(`DROP POLICY IF EXISTS facility_read_scope ON facilities`);
      await client.query(`DROP POLICY IF EXISTS facility_write_scope ON facilities`);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Facility list + CRUD within one org. Writes always stamp org_id (provided by
 *  the caller — the server knows which org/facility it is operating in). Reads
 *  return facilities for the requested org.
 */
export class PostgresFacilityStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly pool: Pool) {}

  async create(orgId: string, input: { name: string; slug?: string }): Promise<FacilityRow> {
    // Same as the org store: the id is generated in the store (no DB default).
    const id = randomUUID();
    const slug = input.slug ?? slugify(input.name);
    const { rows } = await this.pool.query<FacilityRow>(
      `INSERT INTO facilities (id, org_id, name, slug) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, org_id, name, slug, state, created_at`,
      [id, orgId, input.name, slug],
    );
    return rows[0]!;
  }

  async list(orgId: string): Promise<FacilityRow[]> {
    const { rows } = await this.pool.query<FacilityRow>(
      `SELECT id, org_id, name, slug, state, created_at FROM facilities WHERE org_id = $1 ORDER BY name ASC`,
      [orgId],
    );
    return rows;
  }

  async get(orgId: string, idOrSlug: string): Promise<FacilityRow | undefined> {
    const { rows } = await this.pool.query<FacilityRow>(
      `SELECT id, org_id, name, slug, state, created_at FROM facilities WHERE org_id = $1 AND (id = $2 OR slug = $2)`,
      [orgId, idOrSlug],
    );
    return rows[0];
  }
}

// ---------------------------------------------------------------------------
// Cloud context helpers
// ---------------------------------------------------------------------------

/** Setting keys used by RLS policies (current_setting('app....', true)). */
export const RLS = {
  orgId: 'app.tenant_org_id',
  facilityId: 'app.tenant_facility_id',
  admin: 'app.tenant_admin',
} as const;

/** Snapshot of the current cloud operating context. The server sets these on
 *  every PG client before a tenant-scoped operation so RLS (once enabled) and
 *  the write-through both resolve the right org/facility.
 */
export interface CloudContext {
  orgId: string;
  facilityId: string;
  admin: boolean;
}

/** Set the RLS + write-through context on a client for the duration of one
 *  operation. Callers pass the logical context (org/facility/admin) — the helper
 *  sets the `app.*` GUCs so RLS policies and future row-level stamps resolve.
 *  The returned value is whatever `fn` returns (the caller is responsible for
 *  typing it; `unknown` is intentional — don't treat it as any specific shape).
 */
export async function withCloudContext<T>(
  pool: Pool,
  ctx: CloudContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // Track the setting NAME and the SET statement separately — the RESET must
  // name the GUC only (`RESET app.tenant_org_id`), not replay the SET prefix.
  const settings: { name: string; set: string }[] = [
    { name: RLS.orgId, set: `SET ${RLS.orgId} = ${client.escapeLiteral(ctx.orgId)}` },
    { name: RLS.facilityId, set: `SET ${RLS.facilityId} = ${client.escapeLiteral(ctx.facilityId)}` },
    { name: RLS.admin, set: `SET ${RLS.admin} = ${ctx.admin ? 'true' : 'false'}` },
  ];
  for (const s of settings) await client.query(s.set);
  try {
    return await fn(client);
  } finally {
    for (const s of settings) {
      await client.query(`RESET ${s.name}`);
    }
    client.release();
  }
}


// ---------------------------------------------------------------------------
// Bootstrap helpers (H1 exit: a cloud org + first facility exist on install)
// ---------------------------------------------------------------------------

/** Result of bootstrapping the first cloud org + facility on a fresh PG store. */
export interface BootstrapResult {
  org: OrgRow;
  facility: FacilityRow;
  adminApiKeySecret?: string;
}

/** Bootstrap the cloud org + its first facility on a PG-backed store. Idempotent:
 *  the org is looked up BY NAME first — calling it twice with the same names
 *  returns the same org + facility. An EXPLICIT orgName with no match creates
 *  that org (a different name = a different org: the multi-org bootstrap);
 *  the DEFAULT name attaches to the installation's existing org when one
 *  exists — the one-org-per-installation default (D5) — and otherwise creates
 *  it. The facility is matched/created under the org the same way.
 *
 *  This is the H1 "onboarding" seam — in production it is driven by the H3
 *  pairing flow; here it is the get-started path for a cloud instance.
 */
export async function bootstrapCloudOrg(
  orgStore: PostgresOrgStore,
  facilityStore: PostgresFacilityStore,
  opts: { orgName?: string; facilityName?: string },
): Promise<BootstrapResult> {
  const orgName = opts.orgName ?? 'Default Organization';
  const facilityName = opts.facilityName ?? 'Default Facility';
  const orgs = await orgStore.list();
  let org = orgs.find((o) => o.name === orgName);
  if (!org) {
    if (opts.orgName === undefined && orgs.length > 0) {
      org = orgs[0]!;
    } else {
      org = await orgStore.create({ name: orgName });
    }
  }
  const facilities = await facilityStore.list(org.id);
  let facility = facilities.find((f) => f.slug === slugify(facilityName));
  if (!facility) {
    facility = await facilityStore.create(org.id, { name: facilityName });
  }
  return { org, facility };
}
