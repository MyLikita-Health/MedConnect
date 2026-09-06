/** @module @integration-hub/api */

/**
 * JS/TS SDK wrapping the Integration Hub v1 REST API — orders, results,
 * devices, and webhooks (PRD §38, workstream D5), plus the shared
 * primitives (health, version, OpenAPI spec, auth header).
 *
 * Usage:
 *   import { HubClient, apiKeyAuth, type HubHealth, type Order } from '@integration-hub/api';
 *
 *   const hub = new HubClient({ baseUrl: 'http://127.0.0.1:3000', auth: apiKeyAuth('ihk_...') });
 *   const health = await hub.health.get();
 *   const devices = await hub.devices.list();
 *   const order = await hub.orders.create({ patientId: 'P1', tests: ['GLUCOSE'] });
 *   const results = await hub.results.list({ limit: 50 });
 *   const deliveries = await hub.webhooks.deliveries.list({ limit: 20 });
 *
 * Built for Node 20+ and browsers. It wraps the global fetch with:
 *  - automatic `Authorization: Bearer <key>` on every /api/v1 call
 *   - retry with exponential backoff on transient 429/5xx (configurable)
 *   - typed query-parameter pagination helpers (list methods accept limit + optional cursor semantics via the limit param)
 *   - zod-free models: the shapes mirror the v1 OpenAPI contract in
 *     packages/api/src/openapi.json so SDK consumers and the API stay in sync.
 *
 * Auth: create keys via POST /api/v1/keys (admin); the secret is returned once.
 * Roles (PRD §34): viewer / operator / engineer / admin — the client is
 * role-agnostic; it trusts the caller to present a key with the right scopes.
 */

import {
  type HubVersionInfo,
  hubVersionInfo as localHubVersionInfo,
} from '@integration-hub/shared';

// ---------------------------------------------------------------------------
// Models — mirror the v1 OpenAPI contract (packages/api/src/openapi.json).
// Keep these in sync with the server's zod schemas + the OpenAPI component
// schemas; drift is a build-time concern (the SDK is tested against a live hub
// in the demo-sandbox smoke path, not here).
// ---------------------------------------------------------------------------

/** GET /api/v1/health + GET /api/v1/version (merged by the SDK for convenience). */
export interface HubHealth {
  status: 'ok';
  uptime: number;
  time: string;
  storage: string;
  version: string;
  platform: string;
  node: string;
}

/** GET /api/v1/devices, POST /api/v1/devices. */
export interface Device {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  protocol: 'ASTM' | 'HL7' | 'FHIR' | 'DICOM';
  transport: 'tcp' | 'serial' | 'api';
  host?: string;
  port?: number;
  profileId?: string;
  state: 'connected' | 'disconnected' | 'unknown';
  lastSeen?: string;
  autoRegistered?: boolean;
  createdAt: string;
}

export type DeviceProtocol = Device['protocol'];
export type DeviceTransport = Device['transport'];
export type DeviceState = Device['state'];

export interface RegisterDeviceInput {
  id?: string;
  name: string;
  manufacturer?: string;
  model?: string;
  protocol?: DeviceProtocol;
  transport?: DeviceTransport;
  host?: string;
  port?: number;
  profileId?: string;
}

/** GET /api/v1/orders, POST /api/v1/orders, DELETE /api/v1/orders/:id. */
export interface Order {
  id: string;
  patientId: string;
  sampleId?: string;
  tests: string[];
  status: 'active' | 'completed' | 'cancelled';
}

export interface CreateOrderInput {
  id: string;
  patientId: string;
  sampleId?: string;
  tests?: string[];
  status?: 'active' | 'completed' | 'cancelled';
}

/** Flattened results from GET /api/v1/results (one row per result in each message). */
export interface ResultRow {
  messageId: string;
  deviceId: string;
  receivedAt: string;
  patient: { id?: string; name?: string };
  order: { id?: string; accession?: string };
  testCode?: string;
  testName?: string;
  value?: string;
  unit?: string;
  refRange?: string;
  flag?: string;
  status?: string;
}

/** Webhook subscription (secret is never returned by the API — reflect that here). */
export interface WebhookSubscription {
  id: string;
  name: string;
  url: string;
  events: ('result.received' | 'result.validated' | 'result.failed' | 'order.received' | 'device.connected' | 'device.disconnected' | 'message.failed')[] | '*';
  enabled: boolean;
  retry?: {
    maxAttempts: number;
    backoffMs: number;
    backoffFactor: number;
    jitter: boolean;
  };
  createdAt: string;
}

export type WebhookEventType = WebhookSubscription['events'] extends infer E
  ? E extends '*' | string[]
    ? E extends '*'
      ? '*'
      : E extends (infer T)[]
        ? T
        : never
    : never
  : never;

export interface CreateWebhookSubscriptionInput {
  id?: string;
  name: string;
  url: string;
  secret?: string;
  events?: WebhookSubscription['events'];
  enabled?: boolean;
  retry?: WebhookSubscription['retry'];
}

export interface UpdateWebhookSubscriptionInput {
  name?: string;
  url?: string;
  secret?: string;
  events?: WebhookSubscription['events'];
  enabled?: boolean;
  retry?: WebhookSubscription['retry'];
}

/** GET /api/v1/webhooks/deliveries. */
export interface WebhookDelivery {
  eventId: string;
  subscriptionId: string;
  ok: boolean;
  attempts: {
    eventId: string;
    subscriptionId: string;
    attempt: number;
    ok: boolean;
    status?: number;
    error?: string;
    at: string;
  }[];
  lastError?: string;
  deliveredAt?: string;
}

/** POST /api/v1/webhooks/deliveries/:eventId/replay. */
export interface ReplayDeliveryResponse {
  ok: true;
  eventId: string;
  attempted: number;
}

/** POST /api/v1/webhooks/test. */
export interface TestWebhookResponse {
  ok: true;
  id: string;
  matched: number;
  note?: string;
}

/** Standard API error envelope (4xx/5xx). */
export interface ApiError {
  error: string;
  message?: string;
  reason?: string;
  required?: string;
  issues?: string[];
  note?: string;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Build an `Authorization: Bearer <key>` header value for a given API key
 * secret. Use it when you control the headers directly (e.g. a custom fetch,
 * a non-sdk HTTP layer, or webhook-receiver verification of outbound deliveries
 * that present a key instead of a subscription secret).
 */
export function apiKeyAuth(secret: string): { Authorization: string } {
  return { Authorization: `Bearer ${secret}` };
}

// ---------------------------------------------------------------------------
// Config + retry
// ---------------------------------------------------------------------------

export interface HubClientOptions {
  /** Base URL of the hub API, e.g. `http://127.0.0.1:3000`. */
  baseUrl: string;
  /** API key secret. When omitted, calls to /api/v1 routes are unauthenticated (401 unless AUTH_DISABLED=1). */
  auth?: { Authorization: string };
  /**
   * Retry on transient failures (429 + 5xx) with exponential backoff.
   * Pass `0`/unset for no retry (fire-and-forget style). backoffMs is the
   * first attempt's delay; each subsequent retry multiplies by backoffFactor
   * (capped at maxDelayMs). jitter adds ±25% so retries decouple.
   */
  retry?: { maxAttempts?: number; backoffMs?: number; backoffFactor?: number; maxDelayMs?: number; jitter?: boolean };
}

const DEFAULT_RETRY = {
  maxAttempts: 3,
  backoffMs: 500,
  backoffFactor: 2,
  maxDelayMs: 30_000,
  jitter: true,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jittered(base: number, jitter: boolean): number {
  if (!jitter) return base;
  const span = base * 0.25;
  return base + (Math.random() * span * 2 - span);
}

/** True when a response is transient and worth retrying. */
function isTransient(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * POST/GET/PATCH/DELETE with auth + retry. Throws normalized ApiError on
 * 4xx/5xx after the last attempt. Bodies are parsed as JSON when present;
 * empty 204 responses resolve to `undefined`.
 */
async function request<T>(
  opts: HubClientOptions,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  let base = opts.baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error('HubClient baseUrl must be a non-empty URL');
  const url = new URL(`${base}/api/v1${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth) {
    headers.Authorization = opts.auth.Authorization;
  }

  const retry = opts.retry
    ? { ...DEFAULT_RETRY, ...opts.retry }
    : undefined;

  let lastStatus = 0;
  let lastBody: string | undefined;

  for (let attempt = 1;; attempt++) {
    let init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (method === 'DELETE' || method === 'GET') {
      // DELETE with a body is unusual; GET never has one.
      if (body !== undefined) init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), init);
    } catch (err) {
      // Network-level failure: treat like a 502-ish transient.
      lastBody = err instanceof Error ? err.message : String(err);
      if (!retry || attempt >= retry.maxAttempts) {
        throw Object.assign(new Error(lastBody), {
          response: { status: 0, ok: false, body: lastBody },
        }) as unknown as T;
      }
      await sleep(jittered(retry.backoffMs * retry.backoffFactor ** (attempt - 1), retry.jitter));
      continue;
    }

    lastStatus = res.status;
    const ok = res.ok;

    if (ok) {
      if (res.status === 204 || res.headers.get('content-length') === '0') {
        return undefined as unknown as T;
      }
      return (await res.json()) as T;
    }

    // Read body once for error context.
    lastBody = (await res.clone().text()).trim() || undefined;

    if (!isTransient(res.status) || attempt >= retry!.maxAttempts) {
      const err = new Error(lastBody ?? `HTTP ${res.status}`);
      (err as unknown as { response?: { status: number; body?: string } }).response = { status: res.status, body: lastBody };
      throw err as unknown as T;
    }

    await sleep(jittered(retry!.backoffMs * retry!.backoffFactor ** (attempt - 1), retry!.jitter));
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Typed client for the Integration Hub v1 API.
 *
 * Surface:
 *   client.health       — GET /api/v1/health (concrete HubHealth)
 *   client.version      — GET /api/v1/version (HubVersionInfo)
 *   client.openapi      — GET /api/v1/openapi.json (the raw spec object)
 *   client.devices      — list / register
 *   client.orders       — list / create / delete
 *   client.results      — flattened result rows (GET /api/v1/results)
 *   client.webhooks     — subscriptions CRUD, deliveries, replay, test ping
 */
export class HubClient {
  readonly baseUrl: string;
  readonly auth?: { Authorization: string };
  readonly retry?: HubClientOptions['retry'];

  constructor(options: HubClientOptions) {
    this.baseUrl = options.baseUrl;
    this.auth = options.auth;
    this.retry = options.retry;
  }

  // ---- shared primitives -------------------------------------------------
  /**
   * Liveness + version, merged into one HubHealth shape. Public (no auth).
   */
  async getHealth(): Promise<HubHealth> {
    // /api/v1/health returns { status, uptime, time, storage, version, platform, node }
    // but the server computes version via hubVersionInfo() inline. To avoid an
    // extra round trip we trust the health endpoint's fields and, if present,
    // merge the canonical version shape from the local process when the caller
    // wants the server-reported identity. Here we just return the health body
    // widened to HubHealth.
    const h = await request<{ status: string; uptime: number; time: string; storage: string; version?: string; platform?: string; node?: string }>(
      this.#opts, 'GET', '/health',
    );
    return {
      status: h.status as 'ok',
      uptime: h.uptime,
      time: h.time,
      storage: h.storage,
      version: h.version ?? localHubVersionInfo().version,
      platform: h.platform ?? localHubVersionInfo().platform,
      node: h.node ?? localHubVersionInfo().node,
    } satisfies HubHealth;
  }

  /**
   * GET /api/v1/version (public). Returns the release identity the running
   * hub reports (may differ from the local process when supervised).
   */
  async getVersion(): Promise<HubVersionInfo> {
    return request<HubVersionInfo>(this.#opts, 'GET', '/version');
  }

  /** GET /api/v1/openapi.json (public) — the raw OpenAPI 3.1 spec object. */
  async getOpenApiSpec(): Promise<unknown> {
    return request<unknown>(this.#opts, 'GET', '/openapi.json');
  }

  // ---- devices -----------------------------------------------------------
  get devices() {
    return {
      /** GET /api/v1/devices (api:read). */
      list: (options?: { signal?: AbortSignal }) =>
        this.#requestList<Device>('/devices', options?.signal),
      /** POST /api/v1/devices (devices:write). Returns 201 Device. */
      create: (input: RegisterDeviceInput) =>
        this.#request<Device>('POST', '/devices', input),
    };
  }

  // ---- orders ------------------------------------------------------------
  get orders() {
    return {
      /** GET /api/v1/orders (api:read). */
      list: (options?: { signal?: AbortSignal }) =>
        this.#requestList<Order>('/orders', options?.signal),
      /** POST /api/v1/orders (config:write). Returns 201 Order. */
      create: (input: CreateOrderInput) =>
        this.#request<Order>('POST', '/orders', input),
      /** DELETE /api/v1/orders/:id (config:write). 204 no content. */
      delete: (id: string) =>
        this.#request<undefined>('DELETE', `/orders/${encodeURIComponent(id)}`),
    };
  }

  // ---- results -----------------------------------------------------------
  get results() {
    return {
      /**
       * GET /api/v1/results (api:read). Flattened one-row-per-result view.
       * Paginated via `limit` (max 500). Returns the raw result rows.
       */
      list: (options?: { limit?: number; signal?: AbortSignal }) =>
        this.#requestList<ResultRow>('/results', options?.signal, { limit: options?.limit }),
    };
  }

  // ---- webhooks ---------------------------------------------------------
  get webhooks() {
    return {
      /** GET /api/v1/webhooks (api:read) — secret never returned. */
      list: (options?: { signal?: AbortSignal }) =>
        this.#requestList<WebhookSubscription>('/webhooks', options?.signal),
      /** POST /api/v1/webhooks (config:write). Returns 201 with the secret (once). */
      create: (input: CreateWebhookSubscriptionInput) =>
        this.#request<WebhookSubscription>('POST', '/webhooks', input),
      /** PATCH /api/v1/webhooks/:id (config:write). Returns 200 (without secret). */
      update: (id: string, input: UpdateWebhookSubscriptionInput) =>
        this.#request<WebhookSubscription>('PATCH', `/webhooks/${encodeURIComponent(id)}`, input),
      /** DELETE /api/v1/webhooks/:id (config:write). 204 no content. */
      delete: (id: string) =>
        this.#request<undefined>('DELETE', `/webhooks/${encodeURIComponent(id)}`),
      /** GET /api/v1/webhooks/deliveries (api:read). */
      deliveries: {
        list: (options?: { limit?: number; signal?: AbortSignal }) =>
          this.#requestList<WebhookDelivery>('/webhooks/deliveries', options?.signal, { limit: options?.limit }),
      },
      /** POST /api/v1/webhooks/deliveries/:eventId/replay (config:write). */
      replay: (eventId: string) =>
        this.#request<ReplayDeliveryResponse>('POST', `/webhooks/deliveries/${encodeURIComponent(eventId)}/replay`),
      /** POST /api/v1/webhooks/test (config:write). Fires a synthetic signed ping. */
      test: (input?: { type?: WebhookEventType; data?: Record<string, unknown> }) =>
        this.#request<TestWebhookResponse>('POST', '/webhooks/test', input ?? {}),
    };
  }

  // ---- internal ---------------------------------------------------------
  get #opts(): HubClientOptions {
    return { baseUrl: this.baseUrl, auth: this.auth, retry: this.retry };
  }

  #request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return request<T>(this.#opts, method, path, body, query);
  }

  #requestList<T>(path: string, signal?: AbortSignal, query?: Record<string, string | number | boolean | undefined>): Promise<T[]> {
    return request<T[]>(this.#opts, 'GET', path, undefined, {
      ...query,
      signal: undefined, // query values are primitives; drop AbortSignal so the type is consistent
    });
  }
}

// Re-export the shared version shape so SDK consumers can compare the local
// process identity with the server-reported one without an extra import.
export { type HubVersionInfo } from '@integration-hub/shared';
