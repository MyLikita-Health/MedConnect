# Integration Hub — MVP scaffold

> Full-platform roadmap: see [`docs/implementation-plan.md`](docs/implementation-plan.md) — architecture decisions, workstream plans, phased milestones M0–M5, risks, and the scaffold→production evolution map.

A working skeleton of the healthcare interoperability platform described in
[`prd.txt`](./prd.txt): a hub that connects laboratory analyzers to LIS/HIS
systems over **ASTM E1381/E1394**, translates messages into a **canonical
internal model**, maps vendor test codes, validates, and exposes everything
through a REST API and a web console.

This scaffold implements the **V1 laboratory boundary** of the PRD (§55, §69):

```
Analyzer (simulator) ──ASTM/TCP──▶ Edge gateway ──pipeline──▶ REST API + console UI
                                     ENQ/ACK frames            parse → validate → map → route
                                     checksums, NAK/retry      message viewer, replay
```

It is built as an **npm-workspaces TypeScript monorepo**. The protocol layer
(`astm`, `gateway`) stays zero-dependency; M0 added Fastify + zod + pg for the
API and persistence. Tests use Node's built-in test runner.

## Quickstart (in-memory, no services needed)

```bash
npm install        # links workspaces; dev deps only (typescript, tsx, @types/node)
npm run demo       # starts the hub, sends 3 analyzer messages, prints the API summary
```

Then, to poke around:

```bash
npm start          # hub on tcp://127.0.0.1:5000 (devices) + http://127.0.0.1:3000 (API/UI)
# in a second terminal:
npm run simulate   # analyzer simulator sends 3 result messages to the hub
```

Without `DATABASE_URL` the hub uses in-memory stores (the scaffold default).

## Quickstart (PostgreSQL — M0 persistence)

```bash
npm run db:up      # docker compose: PostgreSQL 16 (host port 5434) + Redis (6380)
npm run demo:db    # end-to-end demo persisting to Postgres (migrations auto-applied)
npm start          # with DATABASE_URL set: durable hub on Postgres
```

`DATABASE_URL` defaults to `postgres://hub:hub@localhost:5434/hub` (matches
`docker-compose.yml`). Migrations live in `packages/api/migrations/` and are
applied automatically at startup by a tiny zero-dependency runner (the ORM
choice is still open — plan decision D1). Host ports 5434/6380 avoid clashing
with other local projects that bind 5432/6379.

Run the DB-backed test suite (4 extra integration tests against a live
Postgres):

```bash
npm run test:db
```

The DB tests drop/recreate a dedicated `hub_test` database on the same server
(never touching the dev `hub` database), then run the real migrations.

## What M0 foundations landed

- **PostgreSQL persistence behind `MessageSink`** — `PostgresMessageStore` /
  `PostgresDeviceRegistry` (`packages/api/src/pg/`); one message persists
  atomically as envelope + canonical patient/order/result rows; mappings are
  DB-driven (`test_mappings`) and seeded from `DEFAULT_MAPPINGS`. In-memory
  stores remain the no-config default.
- **Fastify + zod API** — the hand-rolled node:http router is gone; the same
  v1 route surface now runs on Fastify with zod validation
  (`packages/api/src/server.ts`). Health reports the active backend
  (`storage: memory | postgres`).
- **docker-compose dev env** — PostgreSQL 16 + Redis 7 (`npm run db:up`);
  `.env.example`; `npm run demo:db` / `npm run test:db`.

Backend choice is a wiring decision in `packages/server/src/index.ts` — set
`DATABASE_URL` and everything (gateway sink, device registry, mappings) is
durable. The gateway awaits async sinks and surfaces persistence failures as
session errors rather than dropping messages silently.

- Console UI: <http://127.0.0.1:3000/> — live dashboard, devices, message
  viewer (raw + parsed + canonical payload + pipeline timeline), replay.
- REST API: <http://127.0.0.1:3000/api/v1/health>

Other commands:

```bash
npm test           # 36 tests: codec, sessions over real TCP, pipeline, API
npm run test:db    # 40 tests: same + 4 PostgreSQL integration tests (needs db:up)
npm run build      # tsc -b (project references) — also the typecheck
npm run simulate -- --count 10 --interval 200
npm run simulate -- --corrupt-rate 0.5   # exercise NAK + retry on the wire
```

Ports/host are configurable: `PORT`, `DEVICE_PORT`, `HOST` env vars or
`--http-port` / `--device-port` / `--host` flags.

## Repository layout

```
packages/
  shared/     @integration-hub/shared   Canonical data model (PRD §16), message
                                        envelope, statuses, MessageSink contract
  astm/       @integration-hub/astm     ASTM E1381 framing + checksums, E1394
                                        records, session (host) + client (device)
  gateway/    @integration-hub/gateway  TCP listener, per-connection ASTM session,
                                        pipeline: parse → validate → map → route,
                                        default test-code mappings (PRD §17–18)
  api/        @integration-hub/api      REST API on Fastify + zod (PRD §36), message store
                                        (in-memory or PostgreSQL behind the MessageSink
                                        contract), device registry, embedded web console
                                        (PRD §24, §31), migrations in api/migrations/
  simulator/  @integration-hub/simulator  Analyzer simulator: generates realistic
                                        H/P/O/R/L result messages (PRD §26)
  server/     @integration-hub/server   Edge-gateway process wiring it all together
scripts/demo.ts      one-command end-to-end demo
```

Layering (PRD §67): `shared` is the canonical model; `gateway` depends only on
`astm` + `shared`; `api` depends only on `shared`; `server` wires gateway and
API through interfaces (`MessageSink`, `replayHandler`, `onDeviceState`), so a
durable store (Postgres/Redis/BullMQ per PRD §49) or an HL7 adapter can be
dropped in without touching the protocol layer.

## How a message flows (PRD §52)

1. **Transport** — the analyzer connects over TCP and starts an ASTM session:
   `ENQ` → host `ACK` → one frame per record (`STX … ETX/ETB` + 2-hex
   checksum) → host `ACK`s each frame (or `NAK`s a corrupted one; the device
   retries) → `EOT` ends the session. Records accumulate across ETB frames;
   the ETX frame completes the message.
2. **Parse** — records are split into `H / P / O / R / L` with `|`-separated
   fields and `^`-separated components (`@integration-hub/astm`).
3. **Validate** (`gateway/src/pipeline.ts`) — patient identifier, order
   identifier, and at least one result with a value are required. Failures are
   **recorded with status `FAILED` + the issues**, never dropped (PRD §22–23,
   §28).
4. **Map** — analyzer test codes become canonical codes via the mapping table
   (e.g. `GLU`/`GLUC` → `GLUCOSE`), keeping `originalTestCode` for the viewer.
   Unmapped codes pass through unchanged.
5. **Route** — the message lands in the store as `ROUTED`, is exposed via
   `GET /api/v1/messages/:id`, and can be re-run with
   `POST /api/v1/messages/:id/replay` (PRD §23 DLQ replay).

## REST API (PRD §36)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Web console (dashboard, devices, message viewer) |
| GET | `/api/v1/health` | Liveness |
| GET | `/api/v1/stats` | Totals by status (PRD §31) |
| GET | `/api/v1/mappings` | Active test-code mapping table |
| GET/POST | `/api/v1/devices` | List / register devices (PRD §11) |
| GET | `/api/v1/messages?status=&deviceId=&limit=` | Messages, newest first (PRD §24) |
| GET | `/api/v1/messages/:id` | Message detail incl. raw, parsed, canonical, timeline |
| POST | `/api/v1/messages/:id/replay` | Re-run a message through the pipeline |
| GET | `/api/v1/results` | Flattened result rows |

## Protocol notes for real devices

- **Checksum** — mod-256 sum of bytes from `STX` through `ETX`/`ETB`
  inclusive, two uppercase hex digits. Some devices exclude `STX`; the codec
  exposes `checksumIncludesStx` as a per-device configuration point
  (`packages/astm/src/frame.ts`).
- **ACK/NAK** — the session acknowledges with a bare `ACK` and tolerates
  stray padding bytes; frame-number echoing (required by some analyzers) is a
  documented extension point in `packages/astm/src/session.ts`.
- **Record layouts** — this scaffold uses a fixed reference layout for
  `H/P/O/R/L` (documented in `gateway/src/pipeline.ts`). Real analyzers
  deviate vendor-by-vendor, sometimes even between firmware versions, so a
  production adapter should load a **per-device profile** that describes field
  offsets — that is the "configuration-first" direction of PRD §39–40.
- **Serial transport** — the session/client take a minimal `DuplexLike`
  interface, so swapping TCP for RS-232 (`SerialPort`) only changes how bytes
  arrive.

## Persistence (M0)

The `MessageSink` contract is the seam between the gateway and the store
(`packages/shared/src/message.ts`). Two implementations exist:

- `MessageStore` — in-memory bounded ring (scaffold default, used in tests).
- `PostgresMessageStore` — durable: `messages` (raw + parsed records +
  payload + timeline as JSONB), canonical `patients` / `orders` / `results`
  tables, and a DB-driven `test_mappings` table (plan §5.1–5.2). One message
  lands in the DB atomically — envelope + clinical rows in a single
  transaction, so a crash cannot leave a half-persisted result.

`PostgresDeviceRegistry` persists devices the same way. Both Postgres classes
implement the exact interfaces the API server consumes (`StoreBackend` /
`DeviceBackend` in `packages/api/src/backend.ts`), so switching backends is a
wiring choice in `packages/server/src/index.ts` — nothing in the gateway,
pipeline, or API routes knows which backend is live.

Schema details worth knowing: `received_at` + `id` index for newest-first
queries; `device_id`/`status` indexes for the message viewer filters; nullable
`org_id`/`facility_id` columns on `devices`/`messages` are tenancy scaffolding
for the cloud platform (plan §5.2 — RLS policies arrive with multi-tenancy in
M4, not before).

## Scaffold boundaries (what is intentionally not here)

- No durable queue with retry/backoff or a dead-letter queue yet (PRD §21–23)
  — that workstream runs over Redis (already provisioned in compose on host
  port 6380) with the outbox pattern (plan §13.1.5).
- No HL7 v2, DICOM, FHIR, webhooks, authn/RBAC, TLS, or multi-tenancy yet —
  those are the natural next layers (PRD §13–15, §34–37, §41).
- No patient matching against an external LIS master (PRD §27) — validation is
  structural for now.
