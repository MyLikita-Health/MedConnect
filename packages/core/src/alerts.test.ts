import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertService } from './alerts.js';
import { InMemoryAlertStore, type AlertRule } from './alert-store.js';

function rule(partial: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'r1',
    kind: 'device-offline',
    name: 'Device offline',
    threshold: 1,
    channels: ['console'],
    enabled: true,
    ...partial,
  };
}

test('device-offline fires on disconnect and resolves on reconnect', async () => {
  const store = new InMemoryAlertStore();
  await store.upsertRule(rule({ id: 'off', kind: 'device-offline' }));
  const alerts = new AlertService(store);

  await alerts.deviceState('SIM-1', 'connected'); // no alert on connect
  await alerts.deviceState('SIM-1', 'offline');
  let firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 1);
  assert.equal(firing[0]!.subject, 'SIM-1');
  assert.equal(firing[0]!.kind, 'device-offline');

  // Still offline — no duplicate firing.
  await alerts.deviceState('SIM-1', 'disconnected');
  firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 1);

  await alerts.deviceState('SIM-1', 'connected');
  firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 0);
  const history = await store.listAlerts();
  assert.equal(history.filter((a) => a.status === 'RESOLVED').length, 1);
});

test('destination-down fires after consecutive failures and resolves on success', async () => {
  const store = new InMemoryAlertStore();
  await store.upsertRule(rule({ id: 'dd', kind: 'destination-down', subject: 'lis-1', threshold: 3 }));
  const alerts = new AlertService(store);

  await alerts.deliveryFailed('lis-1', 'ECONNREFUSED');
  await alerts.deliveryFailed('lis-1', 'ECONNREFUSED');
  assert.equal((await store.listAlerts({ firing: true })).length, 0);
  await alerts.deliveryFailed('lis-1', 'ECONNREFUSED');
  const firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 1);
  assert.equal(firing[0]!.count, 3);

  await alerts.deliverySucceeded('lis-1');
  assert.equal((await store.listAlerts({ firing: true })).length, 0);

  // Counters reset — one failure is not enough to re-fire.
  await alerts.deliveryFailed('lis-1', 'timeout');
  assert.equal((await store.listAlerts({ firing: true })).length, 0);
});

test('destination-down rules scoped to another subject do not fire', async () => {
  const store = new InMemoryAlertStore();
  await store.upsertRule(rule({ id: 'dd', kind: 'destination-down', subject: 'lis-2', threshold: 1 }));
  const alerts = new AlertService(store);
  await alerts.deliveryFailed('lis-1', 'down');
  assert.equal((await store.listAlerts({ firing: true })).length, 0);
});

test('held-backlog fires at threshold and resolves below it', async () => {
  const store = new InMemoryAlertStore();
  await store.upsertRule(rule({ id: 'hb', kind: 'held-backlog', threshold: 2 }));
  const alerts = new AlertService(store);

  await alerts.checkBacklog('held-backlog', 1);
  assert.equal((await store.listAlerts({ firing: true })).length, 0);
  await alerts.checkBacklog('held-backlog', 2);
  let firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 1);
  assert.match(firing[0]!.message, /backlog is 2/);

  // Repeated checks at/above threshold do not re-fire while open.
  await alerts.checkBacklog('held-backlog', 3);
  firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 1);

  await alerts.checkBacklog('held-backlog', 1);
  assert.equal((await store.listAlerts({ firing: true })).length, 0);
});

test('dlq backlog fires and resolves', async () => {
  const store = new InMemoryAlertStore();
  await store.upsertRule(rule({ id: 'dlq', kind: 'dlq', threshold: 3 }));
  const alerts = new AlertService(store);
  await alerts.checkBacklog('dlq', 3);
  assert.equal((await store.listAlerts({ firing: true })).length, 1);
  await alerts.checkBacklog('dlq', 0);
  assert.equal((await store.listAlerts({ firing: true })).length, 0);
});

test('profile-drift fires per device on a drifted delivery and resolves on a clean one', async () => {
  const store = new InMemoryAlertStore();
  await store.upsertRule(rule({ id: 'pd', kind: 'profile-drift' }));
  const alerts = new AlertService(store);

  // Drifted delivery → one FIRING alert naming both versions.
  await alerts.profileDrift({ deviceId: 'ACME-1', drift: true, profileId: 'acme-chem-200', version: 2, certifiedVersion: 1 });
  let firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 1);
  assert.equal(firing[0]!.subject, 'ACME-1');
  assert.equal(firing[0]!.kind, 'profile-drift');
  assert.match(firing[0]!.message, /acme-chem-200 v2 drifted from its certified v1/);

  // Every drifted message would page — but open alerts do not re-fire.
  await alerts.profileDrift({ deviceId: 'ACME-1', drift: true, profileId: 'acme-chem-200', version: 2, certifiedVersion: 1 });
  firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 1);

  // A second device drifts independently → its own alert.
  await alerts.profileDrift({ deviceId: 'ACME-2', drift: true, profileId: 'acme-chem-200', version: 2, certifiedVersion: 1 });
  firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 2);

  // A non-drifted delivery (clean stamp / unbound) resolves only its device.
  await alerts.profileDrift({ deviceId: 'ACME-1', drift: false });
  firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 1);
  assert.equal(firing[0]!.subject, 'ACME-2');
  const history = await store.listAlerts();
  assert.equal(history.filter((a) => a.status === 'RESOLVED').length, 1);
});

test('profile-drift honors threshold and per-device rule subjects', async () => {
  const store = new InMemoryAlertStore();
  await store.upsertRule(rule({ id: 'pd-th', kind: 'profile-drift', threshold: 2 }));
  await store.upsertRule(rule({ id: 'pd-scope', kind: 'profile-drift', subject: 'OTHER-1', name: 'scoped' }));
  const alerts = new AlertService(store);

  // Threshold 2 with count 1 → no fire.
  await alerts.profileDrift({ deviceId: 'ACME-1', drift: true, profileId: 'acme-chem-200', version: 2, certifiedVersion: 1 });
  assert.equal((await store.listAlerts({ firing: true })).length, 0);

  // Rule scoped to OTHER-1 never fires for ACME-1.
  await alerts.profileDrift({ deviceId: 'OTHER-1', drift: true, profileId: 'p', version: 2, certifiedVersion: 1 });
  const firing = await store.listAlerts({ firing: true });
  assert.equal(firing.length, 1);
  assert.equal(firing[0]!.ruleId, 'pd-scope');
  assert.equal(firing[0]!.subject, 'OTHER-1');
});

test('profile-drift webhook posts the fired and resolved payloads', async () => {
  const posted: unknown[] = [];
  const store = new InMemoryAlertStore();
  await store.upsertRule(
    rule({ id: 'pd', kind: 'profile-drift', channels: ['console', 'webhook'], webhookUrl: 'https://hooks.example/1' }),
  );
  const alerts = new AlertService(store, {
    webhook: async (_url, body) => {
      posted.push(body);
    },
  });

  await alerts.profileDrift({ deviceId: 'ACME-1', drift: true, profileId: 'acme-chem-200', version: 2, certifiedVersion: 1 });
  assert.equal(posted.length, 1);
  assert.equal((posted[0] as { status: string }).status, 'FIRING');
  await alerts.profileDrift({ deviceId: 'ACME-1', drift: false });
  assert.equal(posted.length, 2);
  assert.equal((posted[1] as { status: string }).status, 'RESOLVED');
});

test('disabled and kind-mismatched rules are skipped', async () => {
  const store = new InMemoryAlertStore();
  await store.upsertRule(rule({ id: 'off', kind: 'device-offline', enabled: false }));
  await store.upsertRule(rule({ id: 'hb', kind: 'held-backlog', threshold: 1 }));
  const alerts = new AlertService(store);
  await alerts.deviceState('SIM-1', 'offline');
  assert.equal((await store.listAlerts({ firing: true })).length, 0);
  await alerts.checkBacklog('held-backlog', 1);
  assert.equal((await store.listAlerts({ firing: true })).length, 1);
});

test('webhook channel posts fire and resolve payloads', async () => {
  const posted: unknown[] = [];
  const store = new InMemoryAlertStore();
  await store.upsertRule(
    rule({ id: 'off', kind: 'device-offline', channels: ['console', 'webhook'], webhookUrl: 'https://hooks.example/1' }),
  );
  const alerts = new AlertService(store, {
    webhook: async (url, body) => {
      assert.equal(url, 'https://hooks.example/1');
      posted.push(body);
    },
  });

  await alerts.deviceState('SIM-1', 'offline');
  assert.equal(posted.length, 1);
  assert.equal((posted[0] as { status: string }).status, 'FIRING');
  await alerts.deviceState('SIM-1', 'connected');
  assert.equal(posted.length, 2);
  assert.equal((posted[1] as { status: string }).status, 'RESOLVED');
});

test('webhook failures are logged, not thrown', async () => {
  const store = new InMemoryAlertStore();
  await store.upsertRule(rule({ id: 'off', kind: 'device-offline', channels: ['webhook'], webhookUrl: 'https://hooks.example/1' }));
  const logged: string[] = [];
  const alerts = new AlertService(store, {
    log: (l) => logged.push(l),
    webhook: async () => {
      throw new Error('boom');
    },
  });
  await alerts.deviceState('SIM-1', 'offline');
  assert.equal((await store.listAlerts({ firing: true })).length, 1);
  assert.ok(logged.some((l) => l.includes('webhook')));
});