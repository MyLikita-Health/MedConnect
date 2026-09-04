import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from './server.js';
import { DeviceRegistry } from './devices.js';
import { MessageStore } from './store.js';
import type { CanonicalMessage } from '@integration-hub/shared';

function message(overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    protocol: 'ASTM',
    direction: 'device-to-host',
    deviceId: 'SIM-1',
    receivedAt: new Date().toISOString(),
    raw: 'H|\\^&||||SIM^1|||||||P|1|20260903143000',
    status: 'ROUTED',
    errors: [],
    timeline: [{ stage: 'RECEIVED', at: new Date().toISOString() }],
    ...overrides,
  };
}

async function startApi(t: any, replayHandler?: (m: CanonicalMessage) => CanonicalMessage, imaging = false) {
  const store = new MessageStore();
  const devices = new DeviceRegistry();
  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store,
    devices,
    replayHandler,
    ...(imaging ? { imaging: true } : {}),
  });
  const { port } = await api.start();
  t.after(() => api.stop());
  return { base: `http://127.0.0.1:${port}`, store, devices };
}

test('REST API serves health, stats and the console UI', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message({ id: 'm1' }));

  const health = (await (await fetch(`${base}/api/v1/health`)).json()) as { status: string };
  assert.equal(health.status, 'ok');

  const stats = (await (await fetch(`${base}/api/v1/stats`)).json()) as { total: number };
  assert.equal(stats.total, 1);

  const ui = await (await fetch(base)).text();
  assert.ok(ui.includes('Integration Hub'));
});

test('REST API returns a single message by id and 404 for unknown', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message({ id: 'm1' }));

  const byId = (await (await fetch(`${base}/api/v1/messages/m1`)).json()) as CanonicalMessage;
  assert.equal(byId.id, 'm1');

  const missing = await fetch(`${base}/api/v1/messages/nope`);
  assert.equal(missing.status, 404);
});

test('replay endpoint re-runs a message via the wired handler', async (t) => {
  const replayed: CanonicalMessage[] = [];
  const { base, store } = await startApi(t, (m) => {
    const copy = message({ id: `replay-${m.id}`, raw: m.raw });
    replayed.push(copy);
    return copy;
  });
  store.record(message({ id: 'm1' }));

  const res = await fetch(`${base}/api/v1/messages/m1/replay`, { method: 'POST' });
  assert.equal(res.status, 201);
  const body = (await res.json()) as CanonicalMessage;
  assert.equal(body.id, 'replay-m1');
  assert.equal(replayed.length, 1);

  const notFound = await fetch(`${base}/api/v1/messages/ghost/replay`, { method: 'POST' });
  assert.equal(notFound.status, 404);
});

test('replay endpoint returns 501 when no handler is wired', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message({ id: 'm1' }));
  const res = await fetch(`${base}/api/v1/messages/m1/replay`, { method: 'POST' });
  assert.equal(res.status, 501);
});

test('dead-letter retry endpoint returns 501 when no handler is wired (M3.4)', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message({ id: 'm1' }));
  const res = await fetch(`${base}/api/v1/messages/m1/retry`, { method: 'POST' });
  assert.equal(res.status, 501);
});

test('device registration endpoint creates and lists devices', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mindray BS-430', manufacturer: 'Mindray', model: 'BS-430' }),
  });
  assert.equal(res.status, 201);
  const record = (await res.json()) as { id: string; state: string };
  assert.equal(record.id, 'mindray-bs-430');
  assert.equal(record.state, 'unknown');

  const list = (await (await fetch(`${base}/api/v1/devices`)).json()) as unknown[];
  assert.equal(list.length, 1);
});

test('destination and route endpoints manage routing configuration', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/destinations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'lis-webhook',
      name: 'LIS webhook',
      kind: 'http',
      url: 'http://127.0.0.1:9999/hook',
      retry: { maxAttempts: 5 },
    }),
  });
  assert.equal(res.status, 201);
  const destinations = (await (await fetch(`${base}/api/v1/destinations`)).json()) as Array<{ id: string; retry: { maxAttempts: number } }>;
  assert.equal(destinations.length, 1);
  assert.equal(destinations[0]!.retry.maxAttempts, 5);

  const consoleBad = await fetch(`${base}/api/v1/destinations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'console', name: 'x' }),
  });
  assert.equal(consoleBad.status, 400);

  const routeRes = await fetch(`${base}/api/v1/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'r1', destinationId: 'lis-webhook', deviceId: 'SIM-1' }),
  });
  assert.equal(routeRes.status, 201);
  const rules = (await (await fetch(`${base}/api/v1/routes`)).json()) as unknown[];
  assert.equal(rules.length, 1);

  const deleted = await fetch(`${base}/api/v1/destinations/lis-webhook`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal(((await (await fetch(`${base}/api/v1/destinations`)).json()) as unknown[]).length, 0);
});

test('hl7 destinations carry their MLLP config; a missing config is rejected', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/destinations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'lis-mllp',
      name: 'LIS MLLP',
      kind: 'hl7',
      hl7: { host: '127.0.0.1', port: 6661, sendingApp: 'HUB', receivingApp: 'ACME_LIS' },
    }),
  });
  assert.equal(res.status, 201);
  const out = (await (await fetch(`${base}/api/v1/destinations`)).json()) as Array<{
    id: string;
    kind: string;
    hl7?: { host: string; port: number; receivingApp?: string };
  }>;
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'hl7');
  assert.equal(out[0]!.hl7?.host, '127.0.0.1');
  assert.equal(out[0]!.hl7?.port, 6661);
  assert.equal(out[0]!.hl7?.receivingApp, 'ACME_LIS');

  // kind 'hl7' without an hl7 config is a validation error (superRefine).
  const missing = await fetch(`${base}/api/v1/destinations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'bad-mllp', name: 'Bad MLLP', kind: 'hl7' }),
  });
  assert.equal(missing.status, 400);
});

test('dlq endpoint lists failed messages and discard retires them', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message({ id: 'm1', status: 'FAILED' }));
  store.mark('m1', 'FAILED', 'DLQ: delivery failed', { dlqAt: new Date().toISOString() });
  store.record(message({ id: 'm2', status: 'ROUTED' }));

  const dlq = (await (await fetch(`${base}/api/v1/dlq`)).json()) as Array<{ id: string }>;
  assert.equal(dlq.length, 1);
  assert.equal(dlq[0]!.id, 'm1');

  const discard = await fetch(`${base}/api/v1/messages/m1/discard`, { method: 'POST' });
  assert.equal(discard.status, 200);
  assert.equal(store.get('m1')?.status, 'DISCARDED');

  const missing = await fetch(`${base}/api/v1/messages/ghost/discard`, { method: 'POST' });
  assert.equal(missing.status, 404);
});

test('order registry endpoints register, list and remove expected orders', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'ACC-424242',
      patientId: 'PID-1001',
      sampleId: 'S-4242',
      tests: ['GLUCOSE', 'CREATININE'],
    }),
  });
  assert.equal(res.status, 201);

  const list = (await (await fetch(`${base}/api/v1/orders`)).json()) as Array<{ id: string; patientId: string }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, 'ACC-424242');
  assert.equal(list[0]!.patientId, 'PID-1001');

  const deleted = await fetch(`${base}/api/v1/orders/ACC-424242`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal(((await (await fetch(`${base}/api/v1/orders`)).json()) as unknown[]).length, 0);
});

test('admission endpoints list and register patient admissions (the ADT feed view)', async (t) => {
  const { base } = await startApi(t);

  // Empty until an ADT^A01 registers (or manual entry without the HL7 port).
  assert.equal(((await (await fetch(`${base}/api/v1/admissions`)).json()) as unknown[]).length, 0);

  const res = await fetch(`${base}/api/v1/admissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patientId: 'PID-1001',
      name: 'Adeyemi, Tunde',
      dateOfBirth: '19850312',
      gender: 'M',
      visitId: 'VIS-77',
    }),
  });
  assert.equal(res.status, 201);

  const list = (await (await fetch(`${base}/api/v1/admissions`)).json()) as Array<{ patientId: string; status: string; visitId?: string }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.patientId, 'PID-1001');
  assert.equal(list[0]!.status, 'admitted');
  assert.equal(list[0]!.visitId, 'VIS-77');

  // A discharge flips the same patient's current admission.
  const discharge = await fetch(`${base}/api/v1/admissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 'PID-1001', status: 'discharged' }),
  });
  assert.equal(discharge.status, 201);
  const after = (await (await fetch(`${base}/api/v1/admissions`)).json()) as Array<{ status: string }>;
  assert.equal(after.length, 1);
  assert.equal(after[0]!.status, 'discharged');

  // Bad input (no patient id) is a validation error.
  const bad = await fetch(`${base}/api/v1/admissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'admitted' }),
  });
  assert.equal(bad.status, 400);
});

test('held endpoint lists the exception queue and release re-enters delivery', async (t) => {
  const store = new MessageStore();
  const devices = new DeviceRegistry();
  const released: string[] = [];
  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store,
    devices,
    releaseHandler: (id) => {
      released.push(id);
      if (store.get(id)?.status === 'HELD') {
        store.mark(id, 'QUEUED', 'released by operator after review');
        return true;
      }
      return false;
    },
  });
  const { port } = await api.start();
  t.after(() => api.stop());
  const base = `http://127.0.0.1:${port}`;

  store.record(message({ id: 'm1', status: 'HELD', match: { status: 'UNMATCHED', at: new Date().toISOString() } }));
  store.record(message({ id: 'm2', status: 'ROUTED' }));

  const held = (await (await fetch(`${base}/api/v1/held`)).json()) as Array<{ id: string }>;
  assert.equal(held.length, 1);
  assert.equal(held[0]!.id, 'm1');

  const release = await fetch(`${base}/api/v1/messages/m1/release`, { method: 'POST' });
  assert.equal(release.status, 200);
  assert.deepEqual(released, ['m1']);
  assert.equal(store.get('m1')?.status, 'QUEUED');

  const notHeld = await fetch(`${base}/api/v1/messages/m2/release`, { method: 'POST' });
  assert.equal(notHeld.status, 409);
  const missing = await fetch(`${base}/api/v1/messages/ghost/release`, { method: 'POST' });
  assert.equal(missing.status, 404);
});

test('release endpoint returns 501 when no handler is wired', async (t) => {
  const { base, store } = await startApi(t);
  store.record(message({ id: 'm1', status: 'HELD' }));
  const res = await fetch(`${base}/api/v1/messages/m1/release`, { method: 'POST' });
  assert.equal(res.status, 501);
});

test('profile endpoints CRUD config-first device profiles', async (t) => {
  const { base } = await startApi(t);
  const body = {
    id: 'acme-chem-200',
    name: 'Acme Chem 200',
    manufacturer: 'Acme Diagnostics',
    model: 'Chem 200',
    protocol: 'ASTM',
    transport: 'tcp',
    version: 1,
    layout: {
      patient: { id: 3, name: 4, dateOfBirth: 6, sex: 7 },
      order: { sampleId: 3, accession: 2, test: 4 },
      result: { test: 2, value: 3, unit: 4, referenceRange: 5, flag: 6, status: 8 },
    },
    mappings: { GLU: 'GLUCOSE' },
    status: 'certified',
  };
  const res = await fetch(`${base}/api/v1/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201);

  const byId = (await (await fetch(`${base}/api/v1/profiles/acme-chem-200`)).json()) as { manufacturer: string; status: string };
  assert.equal(byId.manufacturer, 'Acme Diagnostics');
  assert.equal(byId.status, 'certified');

  // Invalid profile → 400 via zod.
  const bad = await fetch(`${base}/api/v1/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, layout: { order: { accession: 0, test: 4 } } }),
  });
  assert.equal(bad.status, 400);

  const missing = await fetch(`${base}/api/v1/profiles/nope`);
  assert.equal(missing.status, 404);

  const deleted = await fetch(`${base}/api/v1/profiles/acme-chem-200`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal(((await (await fetch(`${base}/api/v1/profiles`)).json()) as unknown[]).length, 0);
});

test('alert-rule endpoints manage rules and the alerts endpoint lists them', async (t) => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/v1/alert-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'held-r', kind: 'held-backlog', name: 'Held review', threshold: 2 }),
  });
  assert.equal(res.status, 201);

  const rules = (await (await fetch(`${base}/api/v1/alert-rules`)).json()) as Array<{ id: string; threshold: number }>;
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.threshold, 2);

  const drift = await fetch(`${base}/api/v1/alert-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'pd', kind: 'profile-drift', name: 'Profile drifted', channels: ['console', 'webhook'], webhookUrl: 'https://hooks.example/pd' }),
  });
  assert.equal(drift.status, 201);
  assert.equal(((await (await fetch(`${base}/api/v1/alert-rules`)).json()) as unknown[]).length, 2);

  const bad = await fetch(`${base}/api/v1/alert-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'x', kind: 'not-a-kind', name: 'x', threshold: 0 }),
  });
  assert.equal(bad.status, 400);

  const alerts = (await (await fetch(`${base}/api/v1/alerts?firing=true`)).json()) as unknown[];
  assert.deepEqual(alerts, []);

  const deleted = await fetch(`${base}/api/v1/alert-rules/held-r`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  const deletedDrift = await fetch(`${base}/api/v1/alert-rules/pd`, { method: 'DELETE' });
  assert.equal(deletedDrift.status, 204);
  assert.equal(((await (await fetch(`${base}/api/v1/alert-rules`)).json()) as unknown[]).length, 0);
});

test('mwl endpoint returns monitor status + live worklist; 404 when not wired', async (t) => {
  const store = new MessageStore();
  const devices = new DeviceRegistry();
  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store,
    devices,
    mwl: {
      status: () => ({
        enabled: true,
        baseUrl: 'http://orthanc:8042',
        pollMs: 60_000,
        lastRunAt: '2026-09-04T00:00:00.000Z',
        totals: { created: 2, queued: 1, failed: 0 },
        performed: [],
      }),
      worklist: async () => [
        { worklistId: 'wl-1', accession: 'ACC-1', patientName: 'Okafor^Amara', modality: 'CT' },
      ],
    },
  });
  const { port } = await api.start();
  t.after(() => api.stop());
  const base = `http://127.0.0.1:${port}`;

  const body = (await (await fetch(`${base}/api/v1/mwl`)).json()) as {
    status: { totals: { created: number } };
    worklist: Array<{ worklistId: string; accession: string }>;
  };
  assert.equal(body.status.totals.created, 2);
  assert.equal(body.worklist.length, 1);
  assert.equal(body.worklist[0]?.accession, 'ACC-1');

  // Without the monitor wired the endpoint says so (404), like other optional legs.
  const bare = await startApi(t);
  assert.equal((await fetch(`${bare.base}/api/v1/mwl`)).status, 404);
});

test('imaging endpoint surfaces performed-study messages by status; 404 when disabled', async (t) => {
  const { base, store } = await startApi(t, undefined, true);
  store.record(
    message({
      id: 'img-1',
      imaging: {
        kind: 'imaging',
        accession: 'ACC-9',
        performedAt: new Date().toISOString(),
        study: {
          orthancId: 'study-1',
          patientOrthancId: 'patient-1',
          accessionNumber: 'ACC-9',
          series: [],
          storageUrl: 'http://orthanc:8042/studies/study-1',
        },
      },
      status: 'ROUTED',
    }),
  );
  store.record(message({ id: 'lab-1', status: 'ROUTED' })); // not an imaging event

  const body = (await (await fetch(`${base}/api/v1/imaging`)).json()) as {
    total: number;
    byStatus: Record<string, number>;
    messages: Array<{ imaging: { accession: string } }>;
  };
  assert.equal(body.total, 1); // only the imaging message, not the lab one
  assert.deepEqual(body.byStatus, { ROUTED: 1 });
  assert.equal(body.messages[0]?.imaging.accession, 'ACC-9');

  const bare = await startApi(t);
  assert.equal((await fetch(`${bare.base}/api/v1/imaging`)).status, 404);
});

test('results endpoint flattens result rows across messages', async (t) => {
  const { base, store } = await startApi(t);
  store.record(
    message({
      id: 'm1',
      payload: {
        patient: { id: 'P1', name: 'Doe, John' },
        order: { id: 'ACC1', tests: [] },
        results: [{ testCode: 'GLUCOSE', value: '95', unit: 'mg/dL' }],
      },
    }),
  );
  const rows = (await (await fetch(`${base}/api/v1/results`)).json()) as Array<{ testCode: string; patient: unknown }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.testCode, 'GLUCOSE');
});