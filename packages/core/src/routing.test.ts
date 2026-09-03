import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalMessage } from '@integration-hub/shared';
import { CONSOLE_DESTINATION, InMemoryRouteStore, resolveDestinations, type Destination, type RouteRule } from './routing.js';

const httpDest: Destination = {
  id: 'lis-http',
  kind: 'http',
  name: 'LIS webhook',
  url: 'http://127.0.0.1:9/hook',
  enabled: true,
  retry: { maxAttempts: 3, backoffMs: 10, backoffFactor: 2, jitter: false },
};

function message(deviceId: string, status: CanonicalMessage['status'] = 'MAPPED'): CanonicalMessage {
  return {
    id: `m-${deviceId}-${status}`,
    protocol: 'ASTM',
    direction: 'device-to-host',
    deviceId,
    receivedAt: new Date().toISOString(),
    raw: 'H|1',
    status,
    errors: [],
    timeline: [],
  };
}

function rule(overrides: Partial<RouteRule>): RouteRule {
  return { id: 'r1', destinationId: 'lis-http', priority: 100, enabled: true, ...overrides };
}

test('no matching rules falls back to the console destination', async () => {
  const routes = new InMemoryRouteStore();
  const resolved = await resolveDestinations(routes, message('SIM-1'));
  assert.deepEqual(resolved.map((d) => d.id), [CONSOLE_DESTINATION.id]);
});

test('a matching rule selects its destination', async () => {
  const routes = new InMemoryRouteStore();
  await routes.upsertDestination(httpDest);
  await routes.upsertRule(rule({ id: 'r1', deviceId: 'SIM-1' }));

  const forSim1 = await resolveDestinations(routes, message('SIM-1'));
  assert.deepEqual(forSim1.map((d) => d.id), ['lis-http']);

  const forSim2 = await resolveDestinations(routes, message('SIM-2'));
  assert.deepEqual(forSim2.map((d) => d.id), [CONSOLE_DESTINATION.id]);
});

test('priority orders destinations; disabled rules are ignored', async () => {
  const routes = new InMemoryRouteStore();
  const backup: Destination = { ...httpDest, id: 'backup', url: 'http://127.0.0.1:8/hook' };
  await routes.upsertDestination(httpDest);
  await routes.upsertDestination(backup);
  await routes.upsertRule(rule({ id: 'r1', destinationId: 'lis-http', priority: 50 }));
  await routes.upsertRule(rule({ id: 'r2', destinationId: 'backup', priority: 100 }));
  await routes.upsertRule(rule({ id: 'r3', destinationId: 'backup', priority: 10, enabled: false }));

  const resolved = await resolveDestinations(routes, message('SIM-1'));
  assert.deepEqual(resolved.map((d) => d.id), ['lis-http', 'backup']);
});

test('status-scoped rules only match that status', async () => {
  const routes = new InMemoryRouteStore();
  await routes.upsertDestination(httpDest);
  await routes.upsertRule(rule({ id: 'r1', status: 'MAPPED' }));

  assert.deepEqual((await resolveDestinations(routes, message('SIM-1', 'MAPPED'))).map((d) => d.id), ['lis-http']);
  assert.deepEqual((await resolveDestinations(routes, message('SIM-1', 'QUEUED'))).map((d) => d.id), [CONSOLE_DESTINATION.id]);
});

test('deleting a destination removes its rules', async () => {
  const routes = new InMemoryRouteStore();
  await routes.upsertDestination(httpDest);
  await routes.upsertRule(rule({ id: 'r1' }));
  await routes.deleteDestination('lis-http');
  assert.equal((await routes.listRules()).length, 0);
  assert.deepEqual((await resolveDestinations(routes, message('SIM-1'))).map((d) => d.id), [CONSOLE_DESTINATION.id]);
});