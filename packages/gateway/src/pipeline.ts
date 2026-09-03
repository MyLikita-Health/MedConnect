/**
 * Pipeline: ASTM records -> canonical model (PRD §52 Core Workflow).
 *
 * Stages: parse (done by the protocol layer) -> validate -> map -> envelope.
 * Validation failures never drop a message silently: the message is recorded
 * with status FAILED plus the issues, so operators can correct and replay.
 */
import { randomUUID } from 'node:crypto';
import type {
  CanonicalMessage,
  LabPayload,
  MappingTable,
  ParsedRecord,
  TimelineEntry,
} from '@integration-hub/shared';
import { splitComponent } from '@integration-hub/astm';

export interface BuildMessageOptions {
  deviceId?: string;
  mappings?: MappingTable;
  protocol?: CanonicalMessage['protocol'];
  direction?: CanonicalMessage['direction'];
}

export interface CanonicalizationResult {
  payload: LabPayload | null;
  issues: string[];
}

/**
 * Extract patient, order and results from ASTM records into the canonical model.
 *
 * Reference record layout (see packages/simulator and README "Record layouts"):
 *   P | seq | (reserved) | patient id | Last^First | (reserved) | DOB | sex
 *   O | seq | sample id  | order/accession id | ^code^name
 *   R | seq | ^code^name | value | unit | ref range | flag | (nature) | status
 * Real analyzers deviate vendor-by-vendor; production adapters load a per-device
 * profile rather than hard-coding these positions.
 */
export function astmToCanonical(
  records: ParsedRecord[],
  mappings: MappingTable = {},
): CanonicalizationResult {
  const issues: string[] = [];
  let patient: LabPayload['patient'] | undefined;
  let order: LabPayload['order'] | undefined;
  const results: LabPayload['results'] = [];

  for (const record of records) {
    switch (record.type) {
      case 'H':
        // Header: sender name (fields[4], "name^id") identifies the device.
        break;
      case 'P': {
        const id = (record.fields[2] ?? '').trim();
        patient = {
          id,
          name: formatPersonName(record.fields[3]),
          dateOfBirth: record.fields[5] || undefined,
          gender: record.fields[6] || undefined,
        };
        break;
      }
      case 'O': {
        const test = parseTestId(record.fields[3]);
        order = {
          id: (record.fields[2] ?? '').trim() || (record.fields[1] ?? '').trim(),
          sampleId: record.fields[1] || undefined,
          tests: test.code ? [{ code: test.code, name: test.name }] : [],
        };
        break;
      }
      case 'R': {
        const test = parseTestId(record.fields[1]);
        results.push({
          testCode: test.code,
          testName: test.name,
          value: record.fields[2] ?? '',
          unit: record.fields[3] || undefined,
          referenceRange: record.fields[4] || undefined,
          flag: record.fields[5] || undefined,
          status: record.fields[7] || 'F',
        });
        break;
      }
      default:
        break;
    }
  }

  // Validation (PRD §28): never forward results that cannot be associated.
  if (!patient || !patient.id) issues.push('Missing patient identifier');
  if (!order || !order.id) issues.push('Missing order identifier');
  if (results.length === 0) issues.push('No result records');
  for (const r of results) {
    if (!r.value) issues.push(`Result for "${r.testCode || '(unknown test)'}" has no value`);
  }

  if (!patient || !order || results.length === 0 || issues.length > 0) {
    return { payload: null, issues };
  }

  // Test-code mapping (PRD §17–18): analyzer code -> canonical code.
  const mapped = results.map((r) => {
    const mappedCode = mappings[r.testCode] ?? mappings[r.testCode.toUpperCase()];
    if (mappedCode && mappedCode !== r.testCode) {
      return { ...r, testCode: mappedCode, originalTestCode: r.testCode };
    }
    return r;
  });

  return { payload: { patient, order, results: mapped }, issues };
}

/** Wrap a canonical payload into a full pipeline message with timeline + status. */
export function buildMessage(
  records: ParsedRecord[],
  raw: string,
  opts: BuildMessageOptions = {},
): CanonicalMessage {
  const now = new Date().toISOString();
  const timeline: TimelineEntry[] = [
    { stage: 'RECEIVED', at: now },
    { stage: 'PARSED', at: now, note: `${records.length} record(s)` },
  ];

  const { payload, issues } = astmToCanonical(records, opts.mappings);
  if (payload) {
    timeline.push({ stage: 'VALIDATED', at: now, note: 'all checks passed' });
    timeline.push({ stage: 'MAPPED', at: now, note: `${payload.results.length} result(s) mapped` });
  } else {
    timeline.push({ stage: 'VALIDATED', at: now, note: `failed: ${issues.length} issue(s)` });
  }

  return {
    id: randomUUID(),
    protocol: opts.protocol ?? 'ASTM',
    direction: opts.direction ?? 'device-to-host',
    deviceId: opts.deviceId,
    receivedAt: now,
    raw,
    records,
    payload: payload ?? undefined,
    status: payload ? 'MAPPED' : 'FAILED',
    errors: issues,
    timeline,
  };
}

/**
 * Parse a test-id field, commonly "^code^name" (leading type component empty)
 * or a bare code like "GLU".
 */
function parseTestId(value: string | undefined): { code: string; name?: string } {
  const parts = splitComponent(value ?? '');
  if (parts.length >= 3) {
    // ^code^name — first component is the empty (or 'L') type marker.
    const code = parts[1] ?? parts[0];
    return { code: code ?? '', name: parts[2] || undefined };
  }
  if (parts.length === 2) {
    const code = parts[0] || parts[1];
    return { code: code ?? '', name: undefined };
  }
  return { code: parts[0] ?? '' };
}

/** "Doe^John^A" -> "Doe, John A". */
function formatPersonName(value?: string): string | undefined {
  if (!value) return undefined;
  const parts = splitComponent(value).filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  const last = parts[0];
  const given = parts.slice(1).join(' ');
  return given ? `${last}, ${given}` : last;
}