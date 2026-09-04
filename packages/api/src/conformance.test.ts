/**
 * API tests for the golden-conformance surface behind the console's Device
 * profiles section: GET /api/v1/profiles/:id/conformance re-runs a stored
 * profile's CURRENT config against its recorded golden transcripts (workstream
 * K). A certified stored profile must pass; a draft with no recorded goldens
 * reports unavailable; unknown profiles 404; reads are api:read scoped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from './server.js';
import { DeviceRegistry } from './devices.js';
import { MessageStore } from './store.js';
import { InMemoryAuditStore, InMemoryKeyStore, type ApiKeyRole } from './security.js';
import { InMemoryProfileStore, REFERENCE_PROFILE } from '@integration-hub/core';
import type { DeviceProfile } from '@integration-hub/shared';

const SECRETS = { admin: 'ihk_test_conf_admin', engineer: 'ihk_test_conf_eng', operator: 'ihk_test_conf_op', viewer: 'ihk_test_conf_view' };

/** Draft profile with no recorded golden file — conformance is "unavailable". */
const DRAFT: DeviceProfile = {
  id: 'draft-analyzer',
  name: 'Draft Analyzer',
  manufacturer: 'X',
  model: 'Y',
  protocol: 'ASTM',
  transport: 'tcp',
  version: 1,
  layout: {},
  status: 'draft',
};

function authed(secret: string) {
  return { Authorization: `Bearer ${secret}` };
}

async function startApi(t: any) {
  const keys = new InMemoryKeyStore();
  for (const [role, secret] of Object.entries(SECRETS)) {
    await keys.create({ id: `key-${role}`, name: `${role} key`, role: role as ApiKeyRole, secret });
  }
  const profiles = new InMemoryProfileStore();
  await profiles.upsert(REFERENCE_PROFILE); // astm-reference: certified, goldens recorded
  await profiles.upsert(DRAFT); // no golden file records it
  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store: new MessageStore(),
    devices: new DeviceRegistry(),
    profiles,
    keys,
    audit: new InMemoryAuditStore(),
  });
  const { port } = await api.start();
  t.after(() => api.stop());
  return { base: `http://127.0.0.1:${port}`, profiles };
}

test('conformance endpoint requires auth and is readable by every role', async (t) => {
  const { base } = await startApi(t);
  assert.equal((await fetch(`${base}/api/v1/profiles/astm-reference/conformance`)).status, 401);
  for (const role of ['viewer', 'operator', 'engineer', 'admin'] as const) {
    const res = await fetch(`${base}/api/v1/profiles/astm-reference/conformance`, { headers: authed(SECRETS[role]) });
    assert.equal(res.status, 200, `${role} must read conformance`);
  }
});

test('stored certified profile passes its recorded goldens (no drift)', async (t) => {
  const { base } = await startApi(t);
  const body = (await (
    await fetch(`${base}/api/v1/profiles/astm-reference/conformance`, { headers: authed(SECRETS.viewer) })
  ).json()) as {
    available: boolean;
    profileId: string;
    goldenFile?: string;
    run?: { failed: number; passed: number; cases: Array<{ name: string; pass: boolean }> };
  };
  assert.equal(body.available, true);
  assert.equal(body.profileId, 'astm-reference');
  assert.equal(body.goldenFile, 'reference.json');
  assert.ok(body.run && body.run.failed === 0, 'stored certified profile must still pass its transcripts');
  assert.ok((body.run?.cases.length ?? 0) >= 1);
});

test('a profile with no recorded goldens reports unavailable, not a failure', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/profiles/draft-analyzer/conformance`, { headers: authed(SECRETS.viewer) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { available: boolean; reason?: string };
  assert.equal(body.available, false);
  assert.match(body.reason ?? '', /no recorded goldens/);
});

test('unknown profile id returns 404 before any conformance work', async (t) => {
  const { base } = await startApi(t);
  assert.equal((await fetch(`${base}/api/v1/profiles/ghost/conformance`, { headers: authed(SECRETS.viewer) })).status, 404);
});
