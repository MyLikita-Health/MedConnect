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