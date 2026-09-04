import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalMessage, MessageMatch } from '@integration-hub/shared';
import { DEFAULT_VALIDATION_RULES, validateMessage, type ValidationConfig } from './validate.js';

function matched(): MessageMatch {
  return { status: 'MATCHED', matchedOrderId: 'ACC-1', matchedPatientId: 'PID-1', strategy: 'patientId+orderId', at: new Date().toISOString() };
}

function message(overrides: Partial<CanonicalMessage['payload']> = {}): CanonicalMessage {
  return {
    id: 'm1',
    protocol: 'ASTM',
    direction: 'device-to-host',
    deviceId: 'SIM-001',
    receivedAt: new Date().toISOString(),
    raw: 'raw',
    status: 'MAPPED',
    errors: [],
    timeline: [],
    payload: {
      patient: { id: 'PID-1' },
      order: { id: 'ACC-1', tests: [] },
      results: [{ testCode: 'GLUCOSE', value: '5.0', unit: 'mmol/L' }],
      ...overrides,
    },
  };
}

test('passes when matched and everything is known', () => {
  const config: Partial<ValidationConfig> = {
    testCatalog: ['GLUCOSE'],
    unitCatalog: ['mmol/l'],
  };
  const result = validateMessage(message(), matched(), config);
  assert.deepEqual(result, { errors: [], warnings: [] });
});

test('holds when patient is not matched (default rule)', () => {
  const result = validateMessage(message(), undefined, {});
  assert.ok(result.errors.some((e) => /patient not matched/.test(e)));
  assert.ok(result.errors.some((e) => /no matched order/.test(e)));
});

test('flags unknown test codes', () => {
  const config: Partial<ValidationConfig> = {
    rules: { ...DEFAULT_VALIDATION_RULES, testKnown: { enabled: true, severity: 'error' } },
    testCatalog: ['GLUCOSE'],
  };
  const msg = message({ results: [{ testCode: 'TROPONIN', value: '0.1', unit: 'ng/mL' }] });
  const result = validateMessage(msg, matched(), config);
  assert.ok(result.errors.some((e) => /unknown test code.*TROPONIN/.test(e)));
});

test('flags unrecognized units as warnings by default', () => {
  const config: Partial<ValidationConfig> = {
    rules: { ...DEFAULT_VALIDATION_RULES, unitRecognized: { enabled: true, severity: 'warn' } },
    unitCatalog: ['mmol/l'],
  };
  const result = validateMessage(message({ results: [{ testCode: 'GLUCOSE', value: '5.0', unit: 'furlongs/fortnight' }] }), matched(), config);
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some((w) => /unrecognized unit/.test(w)));
});

test('flags out-of-range numeric results', () => {
  const config: Partial<ValidationConfig> = {
    rules: { ...DEFAULT_VALIDATION_RULES, resultPlausible: { enabled: true, severity: 'error' } },
    numericBounds: { GLUCOSE: { min: 0.5, max: 40 } },
  };
  const bad = validateMessage(message({ results: [{ testCode: 'GLUCOSE', value: '250', unit: 'mmol/L' }] }), matched(), config);
  assert.ok(bad.errors.some((e) => /outside plausible range/.test(e)));
  const good = validateMessage(message({ results: [{ testCode: 'GLUCOSE', value: '5.5', unit: 'mmol/L' }] }), matched(), config);
  assert.equal(good.errors.length, 0);
});

test('flags non-numeric values for a bounded test', () => {
  const config: Partial<ValidationConfig> = {
    rules: { ...DEFAULT_VALIDATION_RULES, resultPlausible: { enabled: true, severity: 'error' } },
    numericBounds: { GLUCOSE: { min: 0.5, max: 40 } },
  };
  const result = validateMessage(message({ results: [{ testCode: 'GLUCOSE', value: 'HIGH', unit: 'mmol/L' }] }), matched(), config);
  assert.ok(result.errors.some((e) => /not numeric/.test(e)));
});

test('flags unauthorized devices when an allowlist is set', () => {
  const config: Partial<ValidationConfig> = {
    rules: { ...DEFAULT_VALIDATION_RULES, deviceAuthorized: { enabled: true, severity: 'error' } },
    authorizedDevices: ['SIM-999'],
  };
  const result = validateMessage(message(), matched(), config);
  assert.ok(result.errors.some((e) => /not authorized/.test(e)));
});

test('disabled rules produce no issues', () => {
  const config: Partial<ValidationConfig> = {
    rules: {
      ...DEFAULT_VALIDATION_RULES,
      patientMatched: { enabled: false, severity: 'error' },
      orderExists: { enabled: false, severity: 'error' },
    },
  };
  const result = validateMessage(message(), undefined, config);
  assert.equal(result.errors.length, 0);
});

test('parseNumeric handles commas, decimals and junk', async () => {
  const { parseNumeric } = await import('./validate.js');
  assert.equal(parseNumeric('1,234.5'), 1234.5);
  assert.equal(parseNumeric('5.0'), 5);
  assert.equal(parseNumeric(''), null);
  assert.equal(parseNumeric('HIGH'), null);
});