-- 0014_tenancy_orgs.sql — H1: Org → Facility hierarchy + RLS scaffolding (plan §7.H H1, decision D5).
--
-- Cloud platform = one org, many facilities. facility_id is the tenant-level
-- isolation key on devices/messages/definitions (write-through in the PG stores).
-- RLS is installed but permissive while the cloud context is absent, so a single-
-- tenant edge keeps working; the server turns on strict scoping when the cloud
-- org bootstrap has run (see pg-tenancy.ts enableRlPolicies).

CREATE TABLE IF NOT EXISTS orgs (
  id        text PRIMARY KEY,
  name      text NOT NULL,
  slug      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facilities (
  id         text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name       text NOT NULL,
  slug       text NOT NULL,
  state      text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_facilities_org ON facilities (org_id);

-- RLS scaffolding: turn RLS on the org-scoped tables now (the policies are
-- permissive-while-absent until enableRlPolicies runs). Device + message tables
-- keep their nullable org_id/facility_id scaffolding plus a generic access policy
-- that allows reads while no tenant context is set (single-tenant edge mode).
ALTER TABLE orgs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilities  ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices     ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages    ENABLE ROW LEVEL SECURITY;

-- Permissive-during-absence policies (no current_setting set → allow).
-- These are replaced/pointed by enableRlPolicies once the cloud org exists.
-- NOTE: PostgreSQL has no CREATE POLICY IF NOT EXISTS — the runner records the
-- migration version, so these run exactly once per database.

CREATE POLICY orgs_read_any ON orgs        FOR SELECT USING (current_setting('app.tenant_org_id', true) IS NULL);
CREATE POLICY facilities_read_any ON facilities FOR SELECT USING (current_setting('app.tenant_org_id', true) IS NULL);
CREATE POLICY devices_read_any ON devices    FOR SELECT USING (current_setting('app.tenant_org_id', true) IS NULL);
CREATE POLICY messages_read_any ON messages   FOR SELECT USING (current_setting('app.tenant_org_id', true) IS NULL);

-- Allow writes while no tenant context is set (single-tenant edge / bootstrap),
-- so the existing PG stores + seed paths keep working before RLS is pointed.
CREATE POLICY orgs_write_any ON orgs        FOR ALL USING (current_setting('app.tenant_org_id', true) IS NULL);
CREATE POLICY facilities_write_any ON facilities FOR ALL USING (current_setting('app.tenant_org_id', true) IS NULL);
CREATE POLICY devices_write_any ON devices    FOR ALL USING (current_setting('app.tenant_org_id', true) IS NULL);
CREATE POLICY messages_write_any ON messages   FOR ALL USING (current_setting('app.tenant_org_id', true) IS NULL);
