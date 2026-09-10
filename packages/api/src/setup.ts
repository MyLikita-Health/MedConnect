/** @packageDocumentation
 * W2 — first-boot setup surface (docs/windows-desktop-installer.md §4.5).
 *
 * A local-mode hub boots unconfigured; this module serves the end-user setup
 * flow at /api/v1/setup/*:
 *
 *   GET  /api/v1/setup/status    public — which screen should the console render
 *   POST /api/v1/setup/complete  public ONLY while unconfigured; mints the
 *                                admin API key (returned exactly once — the
 *                                H3 pairing-bundle pattern) and flips the flag
 *   GET/PATCH /api/v1/setup/settings  config:write (admin) — later edits
 *
 * The completion write and the `firstBootComplete` flip are the same
 * transaction-ordered pair: a second concurrent POST sees the flag already
 * true and 403s. After completion, /complete refuses with 403 — further
 * changes go through the auth'd settings PATCH.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { KeyStore } from './security.js';
import type { SqliteLocalSettingsStore } from './sqlite/index.js';

/** Facility identity recorded at first boot. */
export interface FacilitySettings {
  name: string;
  /** Optional org slug recorded now for a later H3 cloud pairing. */
  orgSlug?: string;
}

/** Which domains this installation serves (the install-time choice, §4.5). */
export interface DomainSettings {
  lab: boolean;
  imaging: boolean;
}

/** Network basics (§4.3): listeners + optional TLS. */
export interface NetworkSettings {
  host: string;
  devicePort: number;
  hl7Port?: number;
  httpPort: number;
  tls: boolean;
}

export interface SetupStatus {
  firstBoot: boolean;
  configuredAt?: string;
  facility?: FacilitySettings;
  domains?: DomainSettings;
}

const completeSchema = z.object({
  facility: z.object({
    name: z.string().min(1).max(200),
    orgSlug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64).optional(),
  }),
  domains: z
    .object({
      lab: z.boolean().default(true),
      imaging: z.boolean().default(false),
    })
    .default({ lab: true, imaging: false }),
  network: z
    .object({
      host: z.string().min(1).default('0.0.0.0'),
      devicePort: z.coerce.number().int().min(1).max(65535).default(5000),
      hl7Port: z.coerce.number().int().min(1).max(65535).optional(),
      httpPort: z.coerce.number().int().min(1).max(65535).default(3000),
      tls: z.boolean().default(false),
    })
    .optional(),
  /** Pin the admin key to a caller-chosen secret (idempotent recreate) —
   *  automation-friendly; when absent a random secret is generated. */
  adminKey: z.string().min(20).max(200).optional(),
});

const settingsPatchSchema = z.object({
  facility: z.object({ name: z.string().min(1).max(200), orgSlug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64).optional() }).optional(),
  domains: z.object({ lab: z.boolean(), imaging: z.boolean() }).optional(),
  network: z
    .object({
      host: z.string().min(1).optional(),
      devicePort: z.coerce.number().int().min(1).max(65535).optional(),
      hl7Port: z.coerce.number().int().min(1).max(65535).nullable().optional(),
      httpPort: z.coerce.number().int().min(1).max(65535).optional(),
      tls: z.boolean().optional(),
    })
    .optional(),
});

export interface SetupRoutesOptions {
  settings: SqliteLocalSettingsStore;
  /** When auth is disabled (dev), key minting is skipped. */
  keys?: KeyStore;
}

/** Mount /api/v1/setup/* on the API. */
export function registerSetupRoutes(app: FastifyInstance, opts: SetupRoutesOptions): void {
  const { settings } = opts;

  const status = (): SetupStatus => {
    const facility = settings.get<FacilitySettings>('facility');
    const domains = settings.get<DomainSettings>('domains');
    const flag = settings.get<{ complete: boolean; completedAt?: string }>('firstBootComplete');
    const firstBoot = flag?.complete !== true;
    return firstBoot
      ? { firstBoot: true }
      : { firstBoot: false, configuredAt: flag?.completedAt, ...(facility ? { facility } : {}), ...(domains ? { domains } : {}) };
  };

  app.get('/api/v1/setup/status', async () => status());

  app.post('/api/v1/setup/complete', async (req, reply) => {
    // Public only while unconfigured (checked again here, not just by the
    // auth hook, so the route fails closed even if PUBLIC_ROUTES changes).
    if (settings.isConfigured()) {
      return reply.code(403).send({ error: 'forbidden', message: 'setup already completed' });
    }
    const input = completeSchema.parse(req.body);
    const now = new Date().toISOString();

    settings.set('facility', input.facility);
    settings.set('domains', input.domains);
    if (input.network) settings.set('network', input.network);
    settings.set('firstBootComplete', { complete: true, completedAt: now });

    // Mint the admin key at completion (shown exactly once). When a key with
    // id 'admin' already exists (HUB_ADMIN_KEY pinned at boot), the pinned
    // secret wins and no new secret is returned.
    let secret: string | undefined;
    if (opts.keys) {
      const existing = await opts.keys.get('admin');
      if (!existing) {
        const created = await opts.keys.create({
          id: 'admin',
          name: `Administrator (${input.facility.name})`,
          role: 'admin',
          ...(input.adminKey ? { secret: input.adminKey } : {}),
          createdBy: 'setup',
        });
        secret = created.secret;
      }
    }

    const body: Record<string, unknown> = { ok: true, configuredAt: now, ...status(), status: status() };
    return reply.code(201).send(secret !== undefined ? { ...body, adminKey: { secret } } : body);
  });

  // Later edits (auth'd; the auth hook enforces config:write on PATCH).
  app.get('/api/v1/setup/settings', async () => settings.all());

  app.patch('/api/v1/setup/settings', async (req) => {
    const patch = settingsPatchSchema.parse(req.body);
    if (patch.facility) settings.set('facility', patch.facility);
    if (patch.domains) settings.set('domains', patch.domains);
    if (patch.network) {
      const current = settings.get<NetworkSettings>('network') ?? { host: '0.0.0.0', devicePort: 5000, httpPort: 3000, tls: false };
      settings.set('network', { ...current, ...patch.network });
    }
    return { ok: true, ...status() };
  });
}
