/**
 * DeviceProfile config service (plan workstream A2, §6.3; PRD §39–40).
 *
 * A profile is configuration that turns the generic ASTM pipeline into a
 * certified device adapter: record-layout field offsets, per-model mappings,
 * capabilities and transport/session options. Zod validates profiles at the
 * API boundary and whenever stored JSON is read back, so a corrupt profile
 * fails loudly instead of silently mis-parsing results.
 */
import { z } from 'zod';
import type { DeviceProfile } from '@integration-hub/shared';

/** B4: segment-level HL7 layout overrides (the ASTM record layout cannot describe them). */
export const hl7FieldRefSchema = z.object({
  field: z.number().int().min(1),
  component: z.number().int().min(1).optional(),
});

export const hl7LayoutSchema = z.object({
  delimiters: z
    .object({
      component: z.string().length(1).optional(),
      repetition: z.string().length(1).optional(),
      escape: z.string().length(1).optional(),
      subcomponent: z.string().length(1).optional(),
    })
    .optional(),
  patient: z
    .object({
      id: hl7FieldRefSchema,
      name: hl7FieldRefSchema.optional(),
      dateOfBirth: hl7FieldRefSchema.optional(),
      sex: hl7FieldRefSchema.optional(),
    })
    .optional(),
  order: z
    .object({
      segment: z.enum(['OBR', 'ORC']).optional(),
      fillerId: hl7FieldRefSchema.optional(),
      placerId: hl7FieldRefSchema.optional(),
      test: hl7FieldRefSchema.optional(),
    })
    .optional(),
  result: z
    .object({
      testCode: hl7FieldRefSchema,
      testName: hl7FieldRefSchema.optional(),
      value: hl7FieldRefSchema,
      unit: hl7FieldRefSchema.optional(),
      referenceRange: hl7FieldRefSchema.optional(),
      flag: hl7FieldRefSchema.optional(),
      status: hl7FieldRefSchema.optional(),
      measuredAt: hl7FieldRefSchema.optional(),
    })
    .optional(),
});

export const recordLayoutSchema = z.object({
  patient: z
    .object({
      id: z.number().int().min(1),
      name: z.number().int().min(1).optional(),
      dateOfBirth: z.number().int().min(1).optional(),
      sex: z.number().int().min(1).optional(),
    })
    .optional(),
  order: z
    .object({
      sampleId: z.number().int().min(1).optional(),
      accession: z.number().int().min(1),
      test: z.number().int().min(1),
    })
    .optional(),
  result: z
    .object({
      test: z.number().int().min(1),
      value: z.number().int().min(1),
      unit: z.number().int().min(1).optional(),
      referenceRange: z.number().int().min(1).optional(),
      flag: z.number().int().min(1).optional(),
      status: z.number().int().min(1).optional(),
    })
    .optional(),
});

export const deviceProfileSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug'),
  name: z.string().min(1),
  manufacturer: z.string().min(1),
  model: z.string().min(1),
  protocol: z.enum(['ASTM', 'HL7', 'FHIR', 'REST']).default('ASTM'),
  transport: z.enum(['tcp', 'serial', 'api']).default('tcp'),
  version: z.number().int().min(1).default(1),
  layout: recordLayoutSchema,
  /** B4: HL7 v2 segment-level layout overrides (HL7 profiles only). */
  hl7: hl7LayoutSchema.optional(),
  mappings: z.record(z.string(), z.string()).optional(),
  capabilities: z.array(z.enum(['results-up', 'orders-down', 'host-query'])).optional(),
  connection: z
    .object({
      host: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      baudRate: z.number().int().positive().optional(),
      dataBits: z.number().int().min(5).max(8).optional(),
      stopBits: z.number().min(1).max(2).optional(),
      parity: z.enum(['none', 'even', 'odd']).optional(),
    })
    .optional(),
  session: z
    .object({
      initiator: z.enum(['device', 'host']).optional(),
      frameNumbering: z.enum(['none', 'echo']).optional(),
      checksumIncludesStx: z.boolean().optional(),
    })
    .optional(),
  status: z.enum(['draft', 'certified']).default('draft'),
  certifiedAt: z.string().optional(),
});

/** Parse + validate a profile from JSON/input; throws ZodError on bad input. */
export function parseDeviceProfile(value: unknown): DeviceProfile {
  return deviceProfileSchema.parse(value) as DeviceProfile;
}

export interface ProfileStore {
  list(): DeviceProfile[] | Promise<DeviceProfile[]>;
  get(id: string): DeviceProfile | undefined | Promise<DeviceProfile | undefined>;
  upsert(profile: DeviceProfile): void | Promise<void>;
  remove(id: string): void | Promise<void>;
}

export class InMemoryProfileStore implements ProfileStore {
  private readonly profiles = new Map<string, DeviceProfile>();

  async list(): Promise<DeviceProfile[]> {
    return [...this.profiles.values()];
  }

  async get(id: string): Promise<DeviceProfile | undefined> {
    return this.profiles.get(id);
  }

  async upsert(profile: DeviceProfile): Promise<void> {
    this.profiles.set(profile.id, parseDeviceProfile(profile));
  }

  async remove(id: string): Promise<void> {
    this.profiles.delete(id);
  }
}

/** The scaffold's reference ASTM layout, as a reusable seed profile. */
export const REFERENCE_PROFILE: DeviceProfile = {
  id: 'astm-reference',
  name: 'Generic ASTM E1394 reference',
  manufacturer: '(generic)',
  model: 'Reference layout',
  protocol: 'ASTM',
  transport: 'tcp',
  version: 1,
  layout: {
    patient: { id: 3, name: 4, dateOfBirth: 6, sex: 7 },
    order: { sampleId: 2, accession: 3, test: 4 },
    result: { test: 2, value: 3, unit: 4, referenceRange: 5, flag: 6, status: 8 },
  },
  // Recorded in reference.json — a certified profile's config must equal the
  // config its goldens were recorded under, or stored profiles drift.
  mappings: { GLU: 'GLUCOSE', GLUC: 'GLUCOSE', CREA: 'CREATININE', HGB: 'HEMOGLOBIN' },
  capabilities: ['results-up'],
  status: 'certified',
  certifiedAt: '2026-09-04T00:00:00.000Z',
};

/**
 * A fictional vendor whose O record swaps accession and sample-id positions
 * (accession first). Under the generic reference profile these messages are
 * mis-associated; the profile restores correct canonicalization — the exact
 * failure mode certified profiles + goldens exist to prevent.
 */
export const ACME_CHEM_200_PROFILE: DeviceProfile = {
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
  mappings: { GLU: 'GLUCOSE', CREA: 'CREATININE', HGB: 'HEMOGLOBIN' },
  capabilities: ['results-up', 'host-query'],
  connection: { port: 5000 },
  session: { initiator: 'device', checksumIncludesStx: true },
  status: 'certified',
  certifiedAt: '2026-09-04T00:00:00.000Z',
};