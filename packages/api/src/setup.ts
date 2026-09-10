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

/** Imaging endpoint recorded at first boot (W3): the colocated/hooked Orthanc
 *  REST API the hub drives (AGPL boundary — REST only, §3.2). Applied by
 *  startHub on later boots when domains.imaging is on. */
export interface OrthancSettings {
  baseUrl: string;
  username?: string;
  password?: string;
}

export interface SetupStatus {
  firstBoot: boolean;
  configuredAt?: string;
  facility?: FacilitySettings;
  domains?: DomainSettings;
  /** W3 §8.3: the stored network settings echoed back (the wizard's values —
   *  what the NEXT restart will apply when env does not override). */
  network?: NetworkSettings;
  /** W3 §8.3: the imaging endpoint (baseUrl only — the password never
   *  echoes back over the API). */
  orthanc?: { baseUrl: string };
  /** W3 §8.3 LAN reach: the listeners this hub process actually bound
   *  (present when the mount provides the runtime getter). */
  runtime?: { host: string; device?: number; hl7?: number; http?: number };
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
  /** W3 imaging: the Orthanc REST endpoint for the imaging domain. When
   *  domains.imaging is true but orthanc is omitted, startHub falls back to
   *  the default colocated-bundle address http://127.0.0.1:8042. */
  orthanc: z
    .object({
      baseUrl: z.string().url().max(200).default('http://127.0.0.1:8042'),
      username: z.string().max(100).optional(),
      password: z.string().max(200).optional(),
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
  orthanc: z
    .object({
      baseUrl: z.string().url().max(200).optional(),
      username: z.string().max(100).nullable().optional(),
      password: z.string().max(200).nullable().optional(),
    })
    .optional(),
});

export interface SetupRoutesOptions {
  settings: SqliteLocalSettingsStore;
  /** When auth is disabled (dev), key minting is skipped. */
  keys?: KeyStore;
  /** W3 §8.3: getter for the listeners this process bound (device/hl7/http
   *  ports + host) — evaluated per status request so late-bound ports
   *  (gateway.start() after route registration) are correct. */
  listeners?: () => { host: string; device?: number; hl7?: number; http?: number };
}

/** Mount /api/v1/setup/* on the API. */
export function registerSetupRoutes(app: FastifyInstance, opts: SetupRoutesOptions): void {
  const { settings } = opts;

  const status = (): SetupStatus => {
    const facility = settings.get<FacilitySettings>('facility');
    const domains = settings.get<DomainSettings>('domains');
    const network = settings.get<NetworkSettings>('network');
    const orthanc = settings.get<OrthancSettings>('orthanc');
    const flag = settings.get<{ complete: boolean; completedAt?: string }>('firstBootComplete');
    const firstBoot = flag?.complete !== true;
    const runtime = opts.listeners?.();
    return {
      firstBoot,
      ...(firstBoot ? {} : { configuredAt: flag?.completedAt }),
      ...(facility ? { facility } : {}),
      ...(domains ? { domains } : {}),
      ...(network ? { network } : {}),
      // baseUrl only — the stored orthanc password never echoes back.
      ...(orthanc ? { orthanc: { baseUrl: orthanc.baseUrl } } : {}),
      ...(runtime ? { runtime } : {}),
    };
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
    if (input.orthanc) settings.set('orthanc', input.orthanc);
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
    if (patch.orthanc) {
      const current = settings.get<OrthancSettings>('orthanc') ?? { baseUrl: 'http://127.0.0.1:8042' };
      const merged: OrthancSettings = {
        baseUrl: patch.orthanc.baseUrl ?? current.baseUrl,
        ...(patch.orthanc.username !== undefined ? { username: patch.orthanc.username ?? undefined } : current.username !== undefined ? { username: current.username } : {}),
        ...(patch.orthanc.password !== undefined ? { password: patch.orthanc.password ?? undefined } : current.password !== undefined ? { password: current.password } : {}),
      };
      settings.set('orthanc', merged);
    }
    return { ok: true, ...status() };
  });
}
