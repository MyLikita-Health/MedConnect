import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupKey, InMemoryDedupStore } from './dedup.js';
import type { CanonicalMessage } from '@integration-hub/shared';

function message(raw: string, id = `m-${raw}`): CanonicalMessage {
  return {
    id,
    protocol: 'ASTM',
    direction: 'device-to-host',
    deviceId: 'DEV-1',
    receivedAt: new Date().toISOString(),
    raw,
    status: 'MAPPED',
    errors: [],
    timeline: [],
  };
}

test('dedupKey differs by protocol, device and raw', () => {
  assert.notEqual(dedupKey(message('H|1', 'a')), dedupKey(message('H|2', 'b')));
  assert.equal(dedupKey(message('H|1', 'a')), dedupKey(message('H|1', 'b')));
  assert.notEqual(dedupKey({ ...message('H|1'), deviceId: 'DEV-2' }), dedupKey(message('H|1')));
});

test('in-memory dedup finds and expires keys', async () => {
  let now = 1000;
  const store = new InMemoryDedupStore(() => now);
  const key = dedupKey(message('H|1'));

  assert.equal(await store.find(key), undefined);
  await store.add(key, 'm1', 5000);
  assert.equal(await store.find(key), 'm1');

  now = 5999;
  assert.equal(await store.find(key), 'm1');
  now = 6001; // expired
  assert.equal(await store.find(key), undefined);
  assert.equal(store.size(), 0);
});