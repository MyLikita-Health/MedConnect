/**
 * A4 AdapterRegistry seam at the API (PRD §11 + §39–40): devices can be
 * registered bound to a certified DeviceProfile (acme-chem-200 is seeded by
 * the hub), the binding survives a GET, and an unknown profile id is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from './server.js';
import { DeviceRegistry } from './devices.js';
import { MessageStore } from './store.js';
import { InMemoryAuditStore, InMemoryKeyStore } from './security.js';
import { InMemoryProfileStore, ACME_CHEM_200_PROFILE, REFERENCE_PROFILE } from '@integration-hub/core';

const ENGINEER = 'ihk_test_adapter_eng';
const ADMIN = 'ihk_test_adapter_admin';

async function startApi(t: any) {
  const keys = new InMemoryKeyStore();
  await keys.create({ id: 'key-engineer', name: 'engineer', role: 'engineer', secret: ENGINEER });
  await keys.create({ id: 'key-admin', name: 'admin', role: 'admin', secret: ADMIN });
  const profiles = new InMemoryProfileStore();
  await profiles.upsert(REFERENCE_PROFILE);
  await profiles.upsert(ACME_CHEM_200_PROFILE);
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
  return { base: `http://127.0.0.1:${port}` };
}

function authed(secret: string) {
  return { Authorization: `Bearer ${secret}` };
}

test('a device registers bound to a certified profile; the binding is listed', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/devices`, {
    method: 'POST',
    headers: { ...authed(ENGINEER), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'acme-1',
      name: 'Acme Chem 200 #1',
      manufacturer: 'Acme Diagnostics',
      model: 'Chem 200',
      profileId: 'acme-chem-200',
    }),
  });
  assert.equal(res.status, 201);
  const record = (await res.json()) as { id: string; profileId: string };
  assert.equal(record.id, 'acme-1');
  assert.equal(record.profileId, 'acme-chem-200');

  const list = (await (await fetch(`${base}/api/v1/devices`, { headers: authed(ENGINEER) })).json()) as {
    id: string;
    profileId?: string;
  }[];
  const bound = list.find((d) => d.id === 'acme-1');
  assert.equal(bound?.profileId, 'acme-chem-200');
});

test('registering with an unknown profile id is refused with a clear error', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/devices`, {
    method: 'POST',
    headers: { ...authed(ENGINEER), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mystery Box', profileId: 'no-such-profile' }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /unknown device profile: no-such-profile/);
});

test('a device without a profile stays unbound (defaults to the reference layout)', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/devices`, {
    method: 'POST',
    headers: { ...authed(ENGINEER), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Plain Analyzer' }),
  });
  assert.equal(res.status, 201);
  const record = (await res.json()) as { profileId?: string };
  assert.equal(record.profileId, undefined);
});
