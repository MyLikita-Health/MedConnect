# Integration Hub — MVP scaffold

> Full-platform roadmap: see [`docs/implementation-plan.md`](docs/implementation-plan.md) — architecture decisions, workstream plans, phased milestones M0–M5, risks, and the scaffold→production evolution map.

A working skeleton of the healthcare interoperability platform described in
[`docs/prd.txt`](docs/prd.txt): a hub that connects laboratory analyzers to LIS/HIS
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
API and persistence; M1 added the durable delivery core (`@integration-hub/core`);
M2 added the clinical gate — patient/order matching, result validation, the
HELD exception queue — plus alerting, config-first **device profiles** and the
golden-message **conformance harness** that certifies them, a security
review milestone: **API-key authn with per-role scopes** over the whole v1 API
and an **audit log** of every mutating action (PRD §30, §34), and the last M2
gate item: the facility **installer** (Docker image) plus **signed remote
updates** with supervisor-driven apply, health-gate and rollback (PRD §42–43).
Tests use Node's built-in test runner.

**Workstream B — the HL7 v2 lab engine** is complete (inbound ORU/ADT/ORM +
outbound ORM/ORU over MLLP, PRD §13–15): the inbound leg (ORU over MLLP →
`Hl7Gateway` → dispatcher), the **ORM order feed** (B2c — the LIS seam that
replaces manual `POST /api/v1/orders`), the outbound store-and-forward leg
(B3.1–B3.3: `canonicalToOru`/`canonicalToOrm`, the `hl7` destination kind +
config/migration, `deliverHl7` with AA/AR/AE → retry/DLQ, and a held-open
outbound connection manager), and **generalized HL7 segment-level profile
layouts** (B4 — per-vendor PID/OBR/OBX position + delimiter overrides wired
through `resolveLayout`), all with the parser buy resolved as D7. Kickoff
survey + status: plan §13.15. Goldens-in-CI for real vendor profiles arrive
with field access (risk R2). After B: imaging/DICOM (M3), then
FHIR/webhooks and multi-tenancy.

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

**The API is authenticated by default** (M2 security): on first boot the hub
prints a generated admin key (or pin one with `HUB_ADMIN_KEY=ihk_…`). The
console asks for it when you open <http://127.0.0.1:3000/>; `curl` needs
`-H "Authorization: Bearer <key>"`. Set `AUTH_DISABLED=1` to open the API
(dev only).

Without `DATABASE_URL` the hub uses in-memory stores (the scaffold default).

## Security (M2 — API keys, per-role scopes, audit)

Every `/api/v1` route (except `health`) requires `Authorization: Bearer <key>`.
Only a SHA-256 hash of each key secret is stored; the plaintext is returned
exactly once, at creation. Keys map to one role; roles grant scopes (PRD §34
personas mapped onto the scaffold):

| Role | Grants | Persona (PRD §34) |
| --- | --- | --- |
| `viewer` | read everything | monitoring, read-only audit |
| `operator` | + replay, DLQ discard, HELD release | lab bench / exception queue |
| `engineer` | + register devices, configure destinations/routes/orders/alert rules/profiles | Integration Engineer |
| `admin` | + manage API keys, view audit log | Facility / IT Admin, Super Admin |

Every mutating action by an identified key is written to the **audit log**
(who/what/when/where/result + context — PRD §30); denied attempts are
recorded too, unauthenticated ones are not (nothing to attribute).

```bash
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:3000/api/v1/me
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"name":"night shift","role":"operator"}' \
     http://127.0.0.1:3000/api/v1/keys        # secret shown once
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:3000/api/v1/audit?limit=20"
```

`DELETE /api/v1/keys/:id` revokes (you cannot delete the key in use). The route
→ scope table is centralized in `ROUTE_SCOPES` (packages/api/src/security.ts)
and fail-closed: an unscoped v1 route is denied until it is added there.

### Key lifecycle (rotation ergonomics)

Keys can be **renamed**, **disabled without deleting** (the record + audit
trail survive), given **expiry dates**, and **re-issued** — all admin-only,
each mutation audited (target = key id):

- `PATCH /api/v1/keys/:id` with `{name}`, `{enabled}` or
  `{expiresAt}` (ISO, future-only; `null` clears the expiry). You cannot
  disable the key you are using (lockout guard), and an expired or disabled
  key refuses authn while staying listed.
- `POST /api/v1/keys/:id/rotate` mints a **new secret** for the same key
  (identity/name/role/status preserved; the old secret is revoked
  immediately). The response carries a **warning when the outgoing secret
  was never used since it was issued** — rotating may strand whoever holds
  it, or retire a key nobody ever used. Per-secret tracking (`secretIssuedAt`
  vs `lastUsedAt`, monotonic so same-millisecond bursts stay ordered) makes
  the warning accurate even after earlier rotations; a key is "never used"
  only when its *current* secret has never authenticated.
- The console shows an **Access keys** panel (admin only): per-key status
  (active/disabled/expired), expiry, last use with a *never used* marker, and
  inline rename / disable / enable / expiry / re-issue / delete; created and
  rotated secrets appear in a copy-once box with the warning.
- The `hub-key` CLI drives the same surface from the terminal:
  `npx tsx scripts/key-cli.ts list|create|rename|disable|enable|expiry|rotate|delete`
  (point it at a hub with `HUB_URL` + `HUB_API_KEY`). Secrets print exactly
  once; the never-used warning prints on rotate.

Migration `0009` adds `api_keys.expires_at` + `secret_issued_at` (additive;
hand-applied to dev databases alongside the file).

## Installer + signed remote updates (M2 gate item)

**Installer.** The facility unit is the Docker image (`Dockerfile`, tag = the
release the update machinery swaps):

```bash
npm run image:build     # docker build -t medconnect-hub:0.1.0 .
npm run up:stack        # compose: Postgres + hub (API :3000, devices :5001 —
                        #   host 5000 is taken by macOS AirPlay)
curl http://127.0.0.1:3000/api/v1/health        # { storage: postgres, version }
curl -H "Authorization: Bearer ihk_docker_demo_001" http://127.0.0.1:3000/api/v1/version
```

**Signed updates.** A release is an Ed25519-signed manifest (`schemaVersion 1`:
release id/version/platform + `minHubVersion`/`maxHubVersion` range + env
payload). The hub polls an outbound-only source, verifies the signature
against `UPDATE_PUBLIC_KEY`, and stages; a **supervisor** process owns the hub
lifecycle and performs the swap with a health gate — rolling back
automatically when the new release fails to come up:

```bash
# Operator side: generate keys, sign a manifest (scripts/update-cli.ts)
npm run update-cli -- keygen
npm run update-cli -- sign manifest.json --key keys/update-key.pem -o manifest.signed.json
npm run update-cli -- verify manifest.signed.json --pub keys/update-key.pub.pem

# Hub side: run under the supervisor with the update source + public key
HUB_STATE_DIR=.hub-state UPDATE_SOURCE=… UPDATE_PUBLIC_KEY="$(cat keys/update-key.pub.pem)" \
  npm run start:supervised
# API (admin only): POST /api/v1/updates/{check,apply,rollback}, GET …/status
npm run demo:update     # full loop: signed check → apply → swap to v0.2.0 → rollback
```

Version state (current / desired / last-good / history) lives in the state
dir (`HUB_STATE_DIR`); the console's **Software updates** panel shows it and
offers check/apply/rollback to admins. Release identity is surfaced on
`/health` and `/api/v1/version`. Run the hub under `npm start` without a state
dir and the update endpoints report the agent as not configured.

## TLS for device + LIS connections (PRD §42, §45)

Set `HUB_TLS_CERT` / `HUB_TLS_KEY` (PEM files) and **both** the REST API
(`https://…:3000`) and the ASTM device listener (TLS) terminate TLS. Generate
on-prem material — a facility CA plus a hub cert signed by it — with:

```bash
npm run tls:gen -- hub-hostname.internal lab-lan          # extra SANs optional
# → tls/ca.pem (TRUST THIS), tls/hub.pem + tls/hub-key.pem (serve these)
HUB_TLS_CERT=./tls/hub.pem HUB_TLS_KEY=./tls/hub-key.pem npm start
```

**CA trust flow.** Keep `tls/ca-key.pem` offline after issuance; `ca.pem` is
the facility root of trust:

- **Analyzers / LIS software** — import `tls/ca.pem` into the device/LIS
trust store, then connect to the hub host:port over TLS. The hub presents a
cert that chains to `ca.pem`, so it verifies (no per-device key shipping).
- **Console / curl** — `curl --cacert ./tls/ca.pem https://host:3000/api/v1/health`;
browsers: install `ca.pem` in the OS trust store (or accept the prompt).
- **Supervisor** — `npm run start:supervised` detects TLS and probes the
`https` health endpoint, skipping verification for self-signed on-prem certs
(export `HUB_TLS_VERIFY_PROBE=1` once the CA is in the supervisor's store).
- Node integration clients: `NODE_EXTRA_CA_CERTS=tls/ca.pem`.

Without env vars the hub listens plain HTTP/TCP (the scaffold default); TLS
tests pin the committed `test-fixtures/` cert. Mutual TLS (client certs for
devices) is the Phase-3 edge hardening (plan G3).

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

Run the DB-backed test suite (everything again against a live Postgres):

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
npm test           # 267 tests: codec, sessions, pipeline, matching/validation,
                   #   alerts (incl. profile-drift), profiles/conformance +
                   #   version stamping, HL7 MLLP framing + ACK + inbound
                   #   Hl7Gateway + ORM order feed + ORU/ORM serializer +
                   #   outbound deliverHl7 + connection pool, HL7 segment
                   #   profile layouts (B4), dispatcher/DLQ, API, security
                   #   (roles/scopes + authz + audit), signed updates +
                   #   supervisor (apply/rollback/crash) (17 DB-gated skip)
npm run test:db    # 267 tests: same + PostgreSQL integration (needs db:up)
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
  hl7/        @integration-hub/hl7      HL7 v2 (workstream B): MLLP framing +
                                        sessions/ACK, ORU translator + ORM order
                                        feed, ORU/ORM serializer, inbound
                                        Hl7Gateway + outbound deliverHl7
  gateway/    @integration-hub/gateway  TCP listener, per-connection ASTM session,
                                        pipeline: parse → validate → map → route,
                                        default test-code mappings (PRD §17–18)
  core/       @integration-hub/core     Integration core: message lifecycle (plan §5.3),
                                        dedup (PRD §29), patient/order matching (PRD §27,
                                        E6) + result validation (PRD §28, E5), DB-driven
                                        routing, delivery dispatcher with retry/backoff +
                                        DLQ (PRD §21–23), order registry (LIS seam)
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
`astm` + `shared`; `core` depends on `shared` (delivery, dedup, routing); `api`
depends on `shared` + `core`; `server` wires gateway, core and API through
interfaces (`MessageSink`, `replayHandler`, `onDeviceState`), so a durable
store (Postgres/Redis/BullMQ per PRD §49) or an HL7 adapter can be dropped in
without touching the protocol layer.

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
5. **Deliver** (`packages/core/src/dispatcher.ts`) — the dispatcher owns the
   rest of the lifecycle (plan §5.3): duplicates within the window are marked
   `DUPLICATE`; patient/order **matching** (PRD §27) tries the configured key
   strategies (patient id + order id, then patient id + sample id) against the
   expected-order registry (the LIS seam); **validation** (PRD §28) applies
   per-rule checks (patient matched, order exists, test known, unit
   recognized, result plausible, device authorized). Anything that does not
   uniquely match or fails an error-severity rule is parked in the **HELD
   exception queue** — never silently auto-assigned, never delivered. Route
   rules resolve destinations; delivery runs with per-destination
   retry/backoff and every attempt is recorded. Success ends `ROUTED`;
   exhausted retries (or pipeline-validation failures) go to the
   **dead-letter queue** (`FAILED` + `dlqAt`) — never dropped. The viewer
   shows the whole timeline; DLQ messages can be replayed with
   `POST /api/v1/messages/:id/replay` or retired with `…/discard` (PRD §23);
   HELD messages are reviewed and released with
   `POST /api/v1/messages/:id/release`.

## REST API (PRD §36)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Web console (dashboard, devices, message viewer) |
| GET | `/api/v1/health` | Liveness |
| GET | `/api/v1/stats` | Totals by status (PRD §31) |
| GET | `/api/v1/mappings` | Active test-code mapping table |
| GET/POST | `/api/v1/devices` | List / register devices (PRD §11) |
| GET | `/api/v1/messages?status=&deviceId=&dlq=&limit=` | Messages, newest first (PRD §24) |
| GET | `/api/v1/messages/:id` | Message detail incl. raw, parsed, canonical, timeline |
| POST | `/api/v1/messages/:id/replay` | Re-run a message through the pipeline |
| POST | `/api/v1/messages/:id/discard` | Retire a DLQ message (terminal `DISCARDED`) |
| GET | `/api/v1/dlq` | Dead-letter queue (PRD §23) |
| GET | `/api/v1/held` | Exception queue: messages held for review (PRD §27–28) |
| POST | `/api/v1/messages/:id/release` | Release a HELD message into delivery |
| GET/POST/DELETE | `/api/v1/orders` | Expected-order registry — the LIS seam (PRD §27) |
| GET/POST/DELETE | `/api/v1/alert-rules` | Alert rules (PRD §33) |
| GET | `/api/v1/alerts?firing=&limit=` | Derived alerts: fire/resolve history |
| GET/POST/DELETE | `/api/v1/destinations` | Outbound destinations + retry policies; `kind` incl. `hl7` (MLLP host/port + MSH fields, PRD §19) |
| GET/POST/DELETE | `/api/v1/routes` | Route rules: device/status → destination |
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

## Durable delivery (M1)

Messages flow through the plan §5.3 lifecycle:
`RECEIVED → PARSED → VALIDATED → MAPPED → QUEUED → DELIVERING → ROUTED`, with
`FAILED (+DLQ)` / `DUPLICATE` / `DISCARDED` / `HELD` as the other states.

- **Dedup (PRD §29)** — SHA-256 of protocol + device + raw wire text, retained
  24 h (configurable). A device resending a result (e.g. reconnect that lost
  the ACK) becomes `DUPLICATE` with a link to the original. Replays bypass it.
- **Routing (PRD §19)** — DB-driven `destinations` (HTTP endpoints with
  retry policies) and `route_rules` (device/status match + priority). With no
  matching rule, the built-in `console` destination completes the lifecycle.
- **Retry + DLQ (PRD §21–23)** — per-destination exponential backoff with
  jitter; every attempt lands in `message_attempts`; exhaustion marks the
  message `FAILED` with `dlqAt`. DLQ workflow: view → replay → discard.
- **Delivery is processed in-process** (the edge-outbox pattern, plan §4.2);
  the `Dispatcher` consumes the same `MessageSink` seam the store used, so the
  Redis/BullMQ worker (cloud side) swaps in behind the same contract.

## Clinical correctness (M2 — matching, validation, HELD review)

Before anything is delivered, results must be safely associated (PRD §27–28).
The clinical gate lives in the dispatcher, behind the same seam:

- **Expected-order registry** — the LIS tells the hub which orders to expect
  (`POST /api/v1/orders`); this is the interface seam an HL7 ORM feed (or a
  manual registration UI) will fill. In-memory and Postgres implementations
  (`order_registry` table, migration `0003`).
- **Matching (E6)** — configurable key strategies (patient id + order id,
  then patient id + sample/accession id). Exactly one unique hit =
  `MATCHED`; several = `AMBIGUOUS`; a matching cancelled order = `REJECTED`;
  nothing = `UNMATCHED`. Everything except a unique match is **HELD for
  operator review** — no silent auto-assign. The outcome (`match` on the
  message: status, matched order/patient, strategy) is persisted and shown in
  the console.
- **Validation (E5)** — per-rule checks with severity config: patient
  matched? order exists? test known (canonical catalog)? unit recognized?
  result plausible (numeric range seeds; unit-convention dependent — per-site
  config)? device authorized? Error-severity findings hold the message;
  warnings are recorded on the timeline and delivered.
- **HELD exception queue** — `GET /api/v1/held`; the console shows held
  messages with their reason; `POST /api/v1/messages/:id/release` re-enters
  a reviewed message into delivery (`QUEUED → … → ROUTED`). Like the DLQ,
  held messages are never dropped.

Try the full loop in one command — `npm run demo` registers the expected
order (LIS seam), sends two matched results and one stray unmatched sample,
releases the held one, and prints the summary. The HL7 variants:
`npm run demo:hl7` (inbound ORU over MLLP, same HELD→release loop) and
`npm run demo:outbound` (results store-and-forward to a mock LIS over MLLP
via an `hl7` destination + route rule).

## Alerting (M2 — PRD §33)

Rules watch the events the hub already produces and fan out to channels
(`console` = the API/UI alert list, `webhook` = HTTP POST). Five rule kinds,
evaluated by `packages/core/src/alerts.ts`:

- **device-offline** — a device connection drops (fires) and returns
  (resolves).
- **destination-down** — consecutive failed deliveries to one destination
  reach the threshold; any success clears it.
- **dlq / held-backlog** — the dead-letter or exception queue sits at/above a
  count; checked on each transition, resolves when the queue drains.
- **profile-drift** — a bound device delivers a message under a profile whose
  stored version no longer matches its golden-recorded certification baseline
  (fires once per device on the first drifted delivery; any later
  non-drifted delivery — a clean stamp, or the device unbound — resolves).
  The message is still delivered and stamped `drift: true` with a `FLAGGED`
  timeline entry; this rule makes that annotation operational, so operators
  are paged (add a `webhook` channel) instead of noticing red markers later.
  The `profile-drift` rule is seeded by default; delete it to mute.

A rule+subject fires at most once until resolved (or until its cooldown
elapses), so operators are not spammed per event. Rules are seeded with
sensible defaults and are configurable via `GET/POST/DELETE
/api/v1/alert-rules`; the console lists firing alerts. Webhooks post a JSON
payload `{ rule, kind, status: FIRING|RESOLVED, ... }` — failures are logged,
never thrown. The demo shows the full lifecycle: a held result fires
`held-backlog`, and the alert resolves the moment an operator reviews and
releases it.

## Device profiles & conformance (M2 — PRD §39–40, plan §6.3)

Certified device support is **configuration, not code**. A profile turns the
generic ASTM pipeline into a device adapter: 1-based record-layout field
positions (P/O/R records), per-model test-code mappings, capabilities and
transport/session options (`packages/shared/src/profiles.ts`). A vendor whose
O record swaps accession and sample-id positions gets a profile, and the same
pipeline canonicalizes correctly for both it and the reference layout.

- **Config service** — `device_profileSchema` (zod) validates every profile at
  the API boundary and whenever stored JSON is read back, so a corrupt
  profile fails loudly instead of silently mis-parsing results. Stores:
  in-memory and Postgres (`device_profiles` table, migration `0006`).
- **API + seeds** — `GET/POST/GET/DELETE /api/v1/profiles`; the server seeds
  the generic `astm-reference` profile plus the fictional `acme-chem-200`
  (a vendor whose accession/sample fields swap — mis-associated under the
  reference profile, correct under its own).
- **Golden-message conformance (workstream K)** — `goldens/*.json` pair a
  certified profile with recorded ASTM transcripts and the canonical payload
  it must produce, including negative cases. `runConformance`
  (`packages/core/src/conformance.ts`) replays them through the real pipeline
  and asserts the canonical output; `packages/core/src/goldens.test.ts` runs
  every golden file in CI — a profile is only as good as its recorded
  conformance run — and proves an Acme transcript *fails* under the
  reference profile (profiles matter).
- **Adapter binding (A4 seam)** — a *registered device* carries an optional
  `profileId`; when set, the gateway canonicalizes that device's ASTM stream
  with the profile's layout + code mappings (per-device mappings override the
  global table). Register: `POST /api/v1/devices` with `profileId`
  (validated against the profile store; migration `0008` adds the FK, and
  deleting a profile detaches devices rather than deleting them). Unbound
  devices and the simulator keep the generic reference behavior.
- **Version stamping + drift enforcement** — every message parsed through a
  binding carries `profile: {id, version, certifiedVersion?, drift?}`
  (provenance: exactly which config produced it, preserved on replay). The
  hub reads `certifiedVersion` from the profile's golden file (cached per
  process); when the stored version differs — the profile was edited after
  its certification, or rolled back — messages are stamped `drift: true` with
  a `FLAGGED` timeline entry naming both versions. Drift is an annotation:
  results still flow, and the console marks them (a red *⚠ drift* marker in
  the message list; the detail view shows the parsing profile badge vs its
  certified version).
- **Console Device profiles section** — the console lists profiles with
  certified (green) vs draft (amber) badges and a per-profile **conformance
  view**: `GET /api/v1/profiles/:id/conformance` re-runs a stored profile's
  *current* config against its recorded golden transcripts, showing passed ✓
  n/m expanded to per-case failures when an edit has drifted the profile
  away from what it was certified for. Profiles without recorded goldens
  report "no goldens" (a draft, not a failure). Engineer/admin can add,
  replace (paste profile JSON) or delete profiles. Golden files are loaded
  from `goldens/` (or `HUB_GOLDENS_DIR`), embedded with the profile they
  certify.
- **Certification runbook** — the full field procedure for onboarding a real
  analyzer (session bring-up, transcript capture, profile + golden
  authoring, the CI gate, device binding, soak, version discipline) is
  [`docs/analyzer-certification-runbook.md`](docs/analyzer-certification-runbook.md).

## Scaffold boundaries (what is intentionally not here)

- Alerting channels beyond console/webhook (email, SMS) and alert *actions*
  (auto-pause a destination) are future work; per-subject backlog rules exist
  in the engine but the wiring evaluates backlog checks globally. No alert
  history retention policy yet (retention controls are PRD §44 work).
- The in-process delivery worker is not yet a durable external queue — if the
  process dies mid-queue, queued jobs are re-visible as `QUEUED` but not
  auto-resumed. Redis/BullMQ (compose: host port 6380) closes that for the
  cloud deployment; the edge keeps the SQL-outbox shape (plan §4.2, §13.1.5).
- User *accounts* with passwords/JWT sessions, LDAP, 2FA and per-facility
  scoping are future RBAC layers (API keys + roles are the v1 surface, PRD
  §34–35).
- **HL7 segment-level profiles are live (workstream B4)** — a profile's
  `hl7` config pins per-vendor PID/OBR/OBX positions + delimiter overrides;
  `Hl7Gateway.resolveLayout` applies them from the MSH sender identity, and
  both translators read against them. Outbound MLLP delivery now runs over a
  held-open connection pool (`MllpConnectionPool` — reuse, replace-on-dead-
  peer, idle close). Goldens-in-CI for real vendor profiles are deferred
  until a real vendor's variant requirements exist (plan §13.15).
- The expected-order registry now fills from the wire: inbound **ORM^O01**
  registers orders (B2c, closes the "real LIS master feed" gap);
  ADT patient-admission feeds are still open. A hub without the HL7 port
  still uses manual `POST /api/v1/orders`. Result-plausibility seeds assume
  the reference simulator's unit conventions (mg/dL): a facility using SI
  units must configure its own bounds.
