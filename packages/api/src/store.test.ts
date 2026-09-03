import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageStore } from './store.js';
import type { CanonicalMessage } from '@integration-hub/shared';

function message(overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    protocol: 'ASTM',
    direction: 'device-to-host',
    deviceId: 'DEV-1',
    receivedAt: new Date().toISOString(),
    raw: 'H|\\^&|',
    status: 'ROUTED',
    errors: [],
    timeline: [{ stage: 'RECEIVED', at: new Date().toISOString() }],
    ...overrides,
  };
}

test('record, get and list newest-first', () => {
  const store = new MessageStore();
  store.record(message({ id: 'a' }));
  store.record(message({ id: 'b' }));
  assert.equal(store.get('a')?.id, 'a');
  assert.deepEqual(store.list().map((m) => m.id), ['b', 'a']);
  assert.deepEqual(store.list({ limit: 1 }).map((m) => m.id), ['b']);
});

test('filters by device and status', () => {
  const store = new MessageStore();
  store.record(message({ id: 'a', deviceId: 'DEV-1', status: 'ROUTED' }));
  store.record(message({ id: 'b', deviceId: 'DEV-2', status: 'FAILED' }));
  assert.deepEqual(store.list({ deviceId: 'DEV-2' }).map((m) => m.id), ['b']);
  assert.deepEqual(store.list({ status: 'FAILED' }).map((m) => m.id), ['b']);
});

test('caps the retained message count (drops oldest)', () => {
  const store = new MessageStore(3);
  for (let i = 0; i < 5; i++) store.record(message({ id: `m${i}` }));
  assert.deepEqual(store.list({ limit: 10 }).map((m) => m.id), ['m4', 'm3', 'm2']);
  assert.equal(store.get('m0'), undefined);
});

test('stats count by status and today', () => {
  const store = new MessageStore();
  store.record(message({ status: 'ROUTED' }));
  store.record(message({ status: 'ROUTED' }));
  store.record(message({ status: 'FAILED' }));
  const stats = store.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.today, 3);
  assert.equal(stats.failed, 1);
  assert.equal(stats.byStatus['ROUTED'], 2);
});

test('subscribe receives new messages', () => {
  const store = new MessageStore();
  const seen: string[] = [];
  const unsubscribe = store.subscribe((m) => seen.push(m.id));
  store.record(message({ id: 'x' }));
  unsubscribe();
  store.record(message({ id: 'y' }));
  assert.deepEqual(seen, ['x']);
});