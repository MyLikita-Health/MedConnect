/**
 * Result validation engine (PRD §28; plan workstream E5).
 *
 * Before a result is forwarded: patient matched? order exists? test known?
 * unit recognized? result plausible? device authorized? Each rule is
 * configurable (enabled + severity). Error-severity findings hold the message
 * in the exception queue; warnings are recorded but do not block delivery.
 */
import type { CanonicalMessage, MessageMatch } from '@integration-hub/shared';

export type ValidationRuleName =
  | 'patientMatched'
  | 'orderExists'
  | 'testKnown'
  | 'unitRecognized'
  | 'resultPlausible'
  | 'deviceAuthorized';

export interface ValidationRuleConfig {
  enabled: boolean;
  /** 'error' → message is HELD; 'warn' → recorded on the timeline only. */
  severity: 'error' | 'warn';
}

export type ValidationConfig = {
  rules: Record<ValidationRuleName, ValidationRuleConfig>;
  /** Canonical test codes the lab recognizes; empty = no test-known check. */
  testCatalog?: string[];
  /** Recognized units (compared case-insensitively); empty = no unit check. */
  unitCatalog?: string[];
  /** Device ids allowed to send results; empty = all authorized (PRD §28). */
  authorizedDevices?: string[];
  /** Plausible numeric range per canonical test code. */
  numericBounds?: Record<string, { min: number; max: number }>;
};

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export const DEFAULT_VALIDATION_RULES: Record<ValidationRuleName, ValidationRuleConfig> = {
  patientMatched: { enabled: true, severity: 'error' },
  orderExists: { enabled: true, severity: 'error' },
  testKnown: { enabled: false, severity: 'error' },
  unitRecognized: { enabled: false, severity: 'warn' },
  resultPlausible: { enabled: false, severity: 'error' },
  deviceAuthorized: { enabled: false, severity: 'error' },
};

/** Common lab units (case-insensitive; trimmed). */
export const DEFAULT_UNIT_CATALOG = [
  'mmol/l', 'umol/l', 'mg/dl', 'g/l', 'g/dl', 'mg/l', 'ng/ml', 'pg/ml',
  'u/l', 'iu/l', 'miu/ml', '%', 'ratio', 'cells/ul', '10^9/l', '10^12/l',
  'fmol/l', 'pmol/l', 'nmol/l', 'fl', 'pg', 'mm/h', 's', 'min', 'h',
];

/**
 * Validate a message against the configured rules. `match` is the outcome of
 * the matching engine (E6) — patientMatched/orderExists read from it.
 */
export function validateMessage(
  message: CanonicalMessage,
  match: MessageMatch | undefined,
  config: Partial<ValidationConfig> = {},
): ValidationResult {
  const rules: Record<ValidationRuleName, ValidationRuleConfig> = {
    ...DEFAULT_VALIDATION_RULES,
    ...config.rules,
  };
  const errors: string[] = [];
  const warnings: string[] = [];
  const add = (name: ValidationRuleName, issue: string) => {
    const rule = rules[name]!;
    if (!rule.enabled) return;
    if (rule.severity === 'error') errors.push(issue);
    else warnings.push(issue);
  };

  // patientMatched + orderExists (PRD §28: patient matched? order exists?).
  if (!match || match.status !== 'MATCHED') {
    add('patientMatched', `patient not matched (${match?.status ?? 'no match'}) — held for review`);
  }
  if (!match?.matchedOrderId) {
    add('orderExists', 'no matched order exists in the registry');
  }

  const payload = message.payload;
  const tests = payload?.results ?? [];

  // testKnown: canonical codes must be in the catalog (PRD §17 mapping + §28).
  const catalog = config.testCatalog;
  if (catalog && catalog.length > 0) {
    const known = new Set(catalog.map((c) => c.toLowerCase()));
    const unknown = [...new Set(tests.map((r) => r.testCode).filter((c) => !known.has(c.toLowerCase())))];
    if (unknown.length > 0) {
      add('testKnown', `unknown test code(s): ${unknown.join(', ')}`);
    }
  }

  // unitRecognized: units must be in the catalog (case-insensitive).
  const units = config.unitCatalog;
  if (units && units.length > 0) {
    const known = new Set(units.map((u) => u.toLowerCase()));
    for (const r of tests) {
      if (!r.unit) {
        add('unitRecognized', `result "${r.testCode}" has no unit`);
        continue;
      }
      if (!known.has(r.unit.trim().toLowerCase())) {
        add('unitRecognized', `unrecognized unit "${r.unit}" for ${r.testCode}`);
      }
    }
  }

  // resultPlausible: numeric value within configured bounds.
  const bounds = config.numericBounds;
  if (bounds) {
    for (const r of tests) {
      const range = bounds[r.testCode];
      if (!range) continue;
      const value = parseNumeric(r.value);
      if (value === null) {
        add('resultPlausible', `result "${r.testCode}" value "${r.value}" is not numeric`);
        continue;
      }
      if (value < range.min || value > range.max) {
        add('resultPlausible', `result ${r.testCode} = ${value} outside plausible range [${range.min}, ${range.max}]`);
      }
    }
  }

  // deviceAuthorized (PRD §28: device authorized?).
  const authorized = config.authorizedDevices;
  if (authorized && authorized.length > 0 && message.deviceId) {
    if (!authorized.includes(message.deviceId)) {
      add('deviceAuthorized', `device ${message.deviceId} is not authorized to send results`);
    }
  }

  return { errors, warnings };
}

/** Parse a numeric lab value: strips spaces and allows decimals/exponents. */
export function parseNumeric(value: string): number | null {
  const cleaned = value.trim().replace(/,/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}