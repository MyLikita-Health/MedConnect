import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalMessage } from '@integration-hub/shared';
import { DEFAULT_MATCHING_CONFIG, InMemoryOrderRegistry, matchMessage, type ExpectedOrder, type MatchingConfig } from './matching.js';

function order(partial: Partial<ExpectedOrder>): ExpectedOrder {
  return {
    id: 'ACC-1',
    patientId: 'PID-1',
    sampleId: 'S-1',
    tests: ['GLUCOSE', 'CREATININE'],
    status: 'active',
    receivedAt: new Date().toISOString(),
    ...partial,
  };
}

function message(patientId: string, orderId: string, sampleId?: string): CanonicalMessage {
  return {
    id: 'm1',
    protocol: 'ASTM',
    direction: 'device-to-host',
    receivedAt: new Date().toISOString(),
    raw: 'raw',
    status: 'MAPPED',
    errors: [],
    timeline: [],
    payload: {
      patient: { id: patientId },
      order: { id: orderId, sampleId, tests: [] },
      results: [{ testCode: 'GLUCOSE', value: '5.0', unit: 'mmol/L' }],
    },
  };
}

test('matches exactly on patientId+orderId', async () => {
  const registry = new InMemoryOrderRegistry();
  await registry.register(order({ id: 'ACC-1', patientId: 'PID-1' }));
  const outcome = await matchMessage(message('PID-1', 'ACC-1'), registry);
  assert.equal(outcome.status, 'MATCHED');
  assert.equal(outcome.matchedOrderId, 'ACC-1');
  assert.equal(outcome.strategy, 'patientId+orderId');
});

test('falls back to patientId+sampleId when order id differs', async () => {
  const registry = new InMemoryOrderRegistry();
  await registry.register(order({ id: 'ACC-9', patientId: 'PID-1', sampleId: 'S-7' }));
  const outcome = await matchMessage(message('PID-1', 'ACC-1', 'S-7'), registry);
  assert.equal(outcome.status, 'MATCHED');
  assert.equal(outcome.matchedOrderId, 'ACC-9');
  assert.equal(outcome.strategy, 'patientId+sampleId');
});

test('is AMBIGUOUS when two orders match the same strategy', async () => {
  // A sample barcode with two registered orders (e.g. re-collection) — the
  // order id fallback fails, then the sample-id strategy hits twice: hold.
  const registry = new InMemoryOrderRegistry();
  await registry.register(order({ id: 'ACC-1', patientId: 'PID-1', sampleId: 'S-9' }));
  await registry.register(order({ id: 'ACC-2', patientId: 'PID-1', sampleId: 'S-9' }));
  const outcome = await matchMessage(message('PID-1', 'ACC-X', 'S-9'), registry);
  assert.equal(outcome.status, 'AMBIGUOUS');
  assert.match(outcome.reason ?? '', /2 orders match/);
});

test('is UNMATCHED when no registered order matches', async () => {
  const registry = new InMemoryOrderRegistry();
  await registry.register(order({ id: 'ACC-1', patientId: 'PID-2' }));
  const outcome = await matchMessage(message('PID-1', 'ACC-1'), registry);
  assert.equal(outcome.status, 'UNMATCHED');
});

test('is REJECTED when the matching order is cancelled', async () => {
  const registry = new InMemoryOrderRegistry();
  await registry.register(order({ id: 'ACC-1', patientId: 'PID-1', status: 'cancelled' }));
  const outcome = await matchMessage(message('PID-1', 'ACC-1'), registry);
  assert.equal(outcome.status, 'REJECTED');
  assert.match(outcome.reason ?? '', /cancelled/);
});

test('ignores cancelled orders for ambiguity', async () => {
  const registry = new InMemoryOrderRegistry();
  await registry.register(order({ id: 'ACC-1', patientId: 'PID-1', status: 'cancelled' }));
  await registry.register(order({ id: 'ACC-2', patientId: 'PID-1', sampleId: 'S-2' }));
  const outcome = await matchMessage(message('PID-1', 'ACC-1'), registry);
  assert.equal(outcome.status, 'REJECTED');
});

test('deliver mode still records the match but does not hold', async () => {
  const registry = new InMemoryOrderRegistry();
  const config: MatchingConfig = { ...DEFAULT_MATCHING_CONFIG, onUnmatched: 'deliver' };
  const outcome = await matchMessage(message('PID-1', 'ACC-NOPE'), registry, config);
  assert.equal(outcome.status, 'UNMATCHED');
});

test('matches a message with no payload as UNMATCHED', async () => {
  const registry = new InMemoryOrderRegistry();
  const bare = message('PID-1', 'ACC-1');
  bare.payload = undefined;
  const outcome = await matchMessage(bare, registry);
  assert.equal(outcome.status, 'UNMATCHED');
});