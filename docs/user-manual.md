# Integration Hub — User Manual

> **Audience:** operators, integration engineers, and facility IT who install, configure, operate, or troubleshoot the hub.
> **Scope:** everything in the current scaffold — setup, configuration, the console, the REST API, device connectivity (ASTM + HL7 v2), imaging/DICOM via Orthanc, routing, alerting, profiles, updates, and troubleshooting.
> **Living document:** this manual is updated with every feature slice. See [Keeping this manual current](#keeping-this-manual-current) for the update rule. The full product roadmap lives in [`docs/implementation-plan.md`](implementation-plan.md); this manual describes what exists **today**.

---

## Table of contents

1. [What the hub is](#1-what-the-hub-is)
2. [Architecture at a glance](#2-architecture-at-a-glance)
3. [Installation & first boot](#3-installation--first-boot)
4. [Configuration reference (env vars)](#4-configuration-reference-env-vars)
5. [Ports & endpoints](#5-ports--endpoints)
6. [Security: API keys, roles, TLS](#6-security-api-keys-roles-tls)
7. [The web console](#7-the-web-console)
8. [REST API reference](#8-rest-api-reference)
9. [Device connectivity: ASTM](#9-device-connectivity-astm)
10. [Device connectivity: HL7 v2 (MLLP)](#10-device-connectivity-hl7-v2-mllp)
11. [Imaging & DICOM (Orthanc)](#11-imaging--dicom-orthanc)
12. [How a message flows through the pipeline](#12-how-a-message-flows-through-the-pipeline)
13. [Routing & destinations](#13-routing--destinations)
14. [The DLQ, HELD queue & replay operations](#14-the-dlq-held-queue--replay-operations)
15. [Alerting](#15-alerting)
16. [Device profiles & conformance](#16-device-profiles--conformance)
17. [Persistence: PostgreSQL](#17-persistence-postgresql)
18. [Signed remote updates & the supervisor](#18-signed-remote-updates--the-supervisor)
19. [Simulators & demos](#19-simulators--demos)
20. [Troubleshooting](#20-troubleshooting)
21. [Keeping this manual current](#keeping-this-manual-current)

---

## 1. What the hub is

The Integration Hub is an edge gateway that connects **laboratory analyzers** and **imaging modalities** to LIS/HIS/EHR systems. It:

- Speaks **ASTM E1381/E1394** (and **HL7 v2** over MLLP) with devices on the lab floor.
- Translates every vendor's message into a single **canonical internal model** (patient / order / results).
- Maps vendor test codes to canonical codes, **validates** results, and **matches** them against expected orders.
- Routes results to destinations (message viewer, HTTP webhook, or an outbound HL7 v2 LIS) with **retry, backoff, and a dead-letter queue** — nothing is silently dropped.
- Exposes everything through a **REST API** and a **web console**.
- Connects to **Orthanc** for imaging: pushes RIS orders onto a DICOM worklist, watches for performed studies, and routes study metadata to PACS/archive.

The hub runs as a single Node.js process (`npm start`), with optional PostgreSQL persistence and an optional Docker-based dev stack.

---

## 2. Architecture at a glance

```
Analyzer (ASTM) ──TCP──▶ ┌────────────────────────────────────────────┐
LIS (HL7 ORM/ORU) ─MLLP─▶ │   Hub process (packages/server)           │
Orthanc (REST) ◀────────▶ │   gateway ─ pipeline ─ dispatcher ─ store  │
                          │   (parse→validate→map→match→route→deliver) │
                          └──────────┬──────────────────────┬─────────┘
                                     │ REST /api/v1         │ web console /
                                     │                      │ message viewer
                        PostgreSQL (optional, durable)      HTTP webhook
                                                            HL7 out (MLLP)
                                                            Orthanc / PACS peer
```

The codebase is an npm-workspaces TypeScript monorepo. Layering (each layer depends only on the ones below it):

| Package | Role |
| --- | --- |
| `@integration-hub/shared` | Canonical data model, message envelope, statuses, contracts (`MessageSink`) |
| `@integration-hub/astm` | ASTM E1381 framing/checksums, E1394 records, session (host) + client (device) |
| `@integration-hub/hl7` | HL7 v2: MLLP framing + ACK, ORU/ORM/ADT translators + serializers, inbound gateway, outbound delivery, conformance runner |
| `@integration-hub/gateway` | TCP listener, per-connection ASTM session, pipeline: parse → validate → map |
| `@integration-hub/core` | Message lifecycle, dedup, matching, validation, routing, dispatcher + retry/DLQ, order + admission registries, alerting |
| `@integration-hub/dicom` | Orthanc REST client: studies, worklists (MWL), peers/modalities, echo |
| `@integration-hub/api` | Fastify REST API, message store (memory or Postgres), device registry, embedded web console, migrations |
| `@integration-hub/simulator` | Analyzer + HL7 simulators (test traffic) |
| `@integration-hub/server` | Wires everything together (`startHub`); also the supervisor for signed updates |

---

## 3. Installation & first boot

### 3.1 Prerequisites

- **Node.js ≥ 20** and `npm`.
- **Docker + docker compose** — only for the PostgreSQL-backed dev stack and the Orthanc containers (optional; the hub runs fine without them).
- macOS note: host port **5000** is used by AirPlay — the compose stack maps the device listener to **5001** for this reason.

### 3.2 Install and run the demo (no services needed)

```bash
npm install        # links workspaces
npm run demo       # starts the hub, sends 3 analyzer messages, prints the API summary
```

`npm run demo` exercises the full loop in one command: it registers an expected order (the LIS seam), sends two matched results and one stray unmatched sample, parks the unmatched one in the HELD queue, releases it, and prints the summary.

### 3.3 Start the hub yourself

```bash
npm start          # hub on tcp://127.0.0.1:5000 (devices) + http://127.0.0.1:3000 (API + console)
```

In a second terminal, send it test traffic:

```bash
npm run simulate   # ASTM analyzer simulator: 3 result messages
```

**The API is authenticated by default.** On first boot the hub prints a generated admin key:

```
[api] API auth enabled — generated admin API key:
      ihk_09009e16532d869f2fa9afc6252cd81ce68fc912e5e358c7
```

The web console asks for that key when you open <http://127.0.0.1:3000/>; `curl` calls need `-H "Authorization: Bearer <key>"`. To pin a stable key across restarts (recommended for anything but a throwaway), set `HUB_ADMIN_KEY=ihk_…` — see [the key troubleshooting entry](#the-api-key-does-not-work).

To disable auth entirely (local/dev only): `AUTH_DISABLED=1 npm start`.

### 3.4 Running with PostgreSQL

```bash
npm run db:up      # docker compose: PostgreSQL 16 on host port 5434 (plus Redis on 6380)
npm run demo:db    # end-to-end demo persisting to Postgres (migrations auto-applied)
DATABASE_URL=postgres://hub:hub@localhost:5434/hub npm start   # durable hub
```

Without `DATABASE_URL`, the hub uses in-memory stores (the no-config default — fine for demos, tests, and evaluation; everything resets on restart).

### 3.5 Running with Orthanc (imaging)

```bash
docker compose up -d --build orthanc   # Orthanc REST :8042, DICOM :4242 (+ Worklists plugin)
ORTHANC_URL=http://127.0.0.1:8042 ORTHANC_USER=orthanc ORTHANC_PASSWORD=orthanc npm start
```

With `ORTHANC_URL` set, the hub runs the MWL study monitor (pushes orders onto the worklist, watches for performed studies), the imaging router (routes study metadata through the dispatcher), and the modality health monitor (C-ECHOes configured modalities into the Devices panel). See [Imaging & DICOM](#11-imaging--dicom-orthanc).

---

## 4. Configuration reference (env vars)

| Env var | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address for all listeners |
| `PORT` | `3000` | REST API + web console port |
| `DEVICE_PORT` | `5000` | ASTM device listener port |
| `HL7_PORT` | *(unset — HL7 off)* | Inbound HL7 v2 MLLP listener port. Set it and the hub also speaks HL7 v2 |
| `DATABASE_URL` | *(unset — in-memory)* | PostgreSQL connection string (`postgres://user:pass@host:port/db`). Set → durable store, auto-applied migrations |
| `HUB_ADMIN_KEY` | *(generated at boot)* | Fixed admin API key secret. Pin to keep the same key across restarts |
| `AUTH_DISABLED` | *(unset)* | `1` turns off API auth entirely (dev only) |
| `HUB_TLS_CERT` / `HUB_TLS_KEY` | *(unset — plain TCP/HTTP)* | PEM files; both the REST API (https) and the device listener terminate TLS |
| `HUB_STATE_DIR` | *(unset)* | State dir for signed updates; set → update agent + `/api/v1/updates/*` live (run under the supervisor) |
| `UPDATE_SOURCE` | *(unset)* | Signed-manifest source: https URL, .json path, or a directory |
| `UPDATE_PUBLIC_KEY` | *(unset)* | PEM public key that must sign update manifests |
| `ORTHANC_URL` | *(unset — imaging off)* | Orthanc REST base URL (e.g. `http://127.0.0.1:8042`). Set → MWL monitor, imaging router, modality monitor |
| `ORTHANC_USER` / `ORTHANC_PASSWORD` | *(unset)* | Orthanc basic-auth credentials |
| `MWL_POLL_MS` | `60000` | Worklist sync + performed-study poll cadence |
| `MODALITY_POLL_MS` | `30000` | Modality C-ECHO health-probe cadence |
| `ORTHANC_FORWARD_PEER` | *(unset)* | Orthanc peer name to forward performed studies to (PACS/archive) |
| `HUB_GOLDENS_DIR` | `goldens/` | Directory of golden-message conformance files |
| `HUB_VERSION` | *(from package)* | Override the reported hub version |

CLI flags mirror the port vars: `npm start -- --http-port 8080 --device-port 5001 --hl7-port 6661 --host 0.0.0.0`.

---

## 5. Ports & endpoints

| Listener | Default | Purpose |
| --- | --- | --- |
| TCP `:5000` | ASTM | Analyzer device connections (ENQ/ACK framing) |
| TCP `:6661` *(when `HL7_PORT` set)* | MLLP | Inbound HL7 v2 from a LIS/sending application |
| HTTP `:3000` | REST + console | `/api/v1/*` + web console at `/` |
| Orthanc REST `:8042` / DICOM `:4242` | external | The Orthanc container the hub drives over REST |
| PACS/archive REST `:8043` / DICOM `:4243` | external | Second Orthanc used as the forwarding-peer archive in demos |

---

## 6. Security: API keys, roles, TLS

### 6.1 API keys and roles

Every `/api/v1` route (except `/health` and the console UI) requires `Authorization: Bearer <key>`. Only a SHA-256 **hash** of each key is stored; the plaintext secret is shown exactly once, at creation.

Keys map to one role; roles grant scopes (the route→scope table lives in `ROUTE_SCOPES` in `packages/api/src/security.ts` and **fails closed** — a new v1 route is denied until it is added there):

| Role | Grants | Typical persona |
| --- | --- | --- |
| `viewer` | Read everything | Monitoring, read-only audit |
| `operator` | + replay, DLQ discard, HELD release | Lab bench / exception queue |
| `engineer` | + register devices, configure destinations/routes/orders/alert-rules/profiles | Integration engineer |
| `admin` | + manage API keys, view audit log, updates | Facility / IT admin |

Key lifecycle (admin-only, each mutation audited):

- **Create** — `POST /api/v1/keys` `{name, role}` → secret printed once.
- **Rename / disable / expiry** — `PATCH /api/v1/keys/:id` with `{name}`, `{enabled}`, or `{expiresAt}` (ISO, future-only; `null` clears expiry). You cannot disable the key you are using (lockout guard).
- **Rotate** — `POST /api/v1/keys/:id/rotate` mints a new secret for the same key identity; the old secret is revoked immediately. A warning is returned when the outgoing secret was never used.
- **Delete/revoke** — `DELETE /api/v1/keys/:id` (cannot delete the key in use).

The console's **Access keys** panel (admin) does all of this inline; the `key-cli` does it from the terminal:

```bash
HUB_URL=http://127.0.0.1:3000 HUB_API_KEY=ihk_… npx tsx scripts/key-cli.ts list
npx tsx scripts/key-cli.ts create --name "night shift" --role operator
npx tsx scripts/key-cli.ts rotate <key-id>
```

(`create` takes `--name` + `--role` flags, optional `--days <n>` / `--expires <ISO>` / `--id <slug>`; the secret prints exactly once.)

Every mutating action by an identified key is written to the **audit log** (who/what/when/where/result); denied attempts are recorded too. `GET /api/v1/audit?limit=20` (admin).

### 6.2 TLS for device and LIS connections

Set `HUB_TLS_CERT` / `HUB_TLS_KEY` (PEM files) and **both** the REST API (`https://…:3000`) and the device listener terminate TLS. Generate on-prem material — a facility CA plus a hub cert signed by it:

```bash
npm run tls:gen -- hub-hostname.internal lab-lan
# → tls/ca.pem (facility root of trust), tls/hub.pem + tls/hub-key.pem (serve these)
HUB_TLS_CERT=./tls/hub.pem HUB_TLS_KEY=./tls/hub-key.pem npm start
```

Trust flow:

- **Analyzers / LIS software** — import `tls/ca.pem` into the device/LIS trust store and connect over TLS; the hub presents a cert chaining to `ca.pem`.
- **Console / curl** — `curl --cacert ./tls/ca.pem https://host:3000/api/v1/health`; browsers: install `ca.pem` in the OS trust store.
- **Node integration clients** — `NODE_EXTRA_CA_CERTS=tls/ca.pem`.
- Keep `tls/ca-key.pem` offline after issuance. Mutual TLS (device client certs) is future Phase-3 hardening.

---

## 7. The web console

Open <http://127.0.0.1:3000/> (https when TLS is on) and sign in with an API key. The console auto-refreshes every 3 s. Left column is the status/config side; right column is the message side.

| Panel | Shows / lets you do |
| --- | --- |
| **Dashboard** | Metric counters (totals by status: received, mapped, routed, failed, dup, held, dlq) |
| **Devices** | Registered devices (protocol, transport, state, last seen). Wire gateways auto-register; you can register manually. With Orthanc configured: the `orthanc` device (DICOM · api, from the standing poll) and **one row per configured DICOM modality** (from C-ECHO probes) |
| **Device profiles** | Profile list with certified/draft badges; add/replace/delete profiles; per-profile conformance view re-running the stored config against its recorded goldens |
| **Admissions** | Patient-admission registry — the ADT^A01 feed (B2c) |
| **Alerts** | Firing/resolved alerts from the rule engine; configure rules (see [Alerting](#15-alerting)) |
| **Radiology** *(only when `ORTHANC_URL` set)* | **Orthanc worklist** — sync totals (created/queued/performed), poll cadence, live worklist items, poll errors in red. **Imaging studies** — per-status counts (ROUTED/DUPLICATE/FAILED) and each performed study; FAILED rows have **↩ Retry**; any row opens its full routing view |
| **Software updates** *(only when configured)* | Signed-update state (current/desired/last-good/history); check / apply / rollback for admins |
| **Access keys** *(admin only)* | Per-key status, expiry, last use (with *never used* marker); inline rename / disable / enable / expiry / re-issue / delete |
| **Messages** | The message viewer: newest first, filterable by status/device; click a row for the **detail view** (raw text, parsed records, canonical payload, pipeline timeline, match outcome, profile stamp) |
| **Message detail** | Status pill, timeline (RECEIVED → … → ROUTED/FAILED), raw + parsed + canonical, replay / release / retry / discard actions per status. For **imaging** messages: the full study + routing view (performed study metadata, storage link into Orthanc, resolved destinations, routing timeline, Retry from DLQ on FAILED) |

---

## 8. REST API reference

All `/api/v1` routes (except `health`) require `Authorization: Bearer <key>`. `GET /` serves the console.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/health` | Liveness; reports `storage: memory\|postgres` + version |
| GET | `/api/v1/version` | Release identity |
| GET | `/api/v1/me` | Current key + role |
| GET | `/api/v1/stats` | Totals by status |
| GET | `/api/v1/mappings` | Active test-code mapping table |
| GET/POST | `/api/v1/devices` | List / register devices (optional `profileId` binds a device profile) |
| GET | `/api/v1/messages?status=&deviceId=&dlq=&limit=` | Messages, newest first |
| GET | `/api/v1/messages/:id` | Message detail (raw, parsed, canonical, timeline) |
| POST | `/api/v1/messages/:id/replay` | Re-run a message through the pipeline (lab correction flow) |
| POST | `/api/v1/messages/:id/retry` | Retry a **DLQ'd** message under current route rules (409 if not DLQ'd) |
| POST | `/api/v1/messages/:id/discard` | Retire a DLQ message (terminal `DISCARDED`) |
| GET | `/api/v1/dlq` | Dead-letter queue |
| GET | `/api/v1/held` | HELD exception queue |
| POST | `/api/v1/messages/:id/release` | Release a HELD message into delivery |
| GET/POST/DELETE | `/api/v1/orders` | Expected-order registry (the LIS seam) |
| GET/POST/DELETE | `/api/v1/admissions` | Patient-admission registry (the ADT feed) |
| GET/POST/DELETE | `/api/v1/destinations` | Outbound destinations + retry policies (`kind`: `console` / `http` / `hl7`) |
| GET/POST/DELETE | `/api/v1/routes` | Route rules: device/status → destination |
| GET | `/api/v1/results` | Flattened canonical result rows |
| GET/POST/DELETE | `/api/v1/profiles` | Device profiles; `GET /api/v1/profiles/:id/conformance` re-runs goldens |
| GET/POST/DELETE | `/api/v1/alert-rules` | Alert rules |
| GET | `/api/v1/alerts?firing=&limit=` | Derived alerts: fire/resolve history |
| GET | `/api/v1/mwl` | MWL study monitor: status + live Orthanc worklist (404 without `ORTHANC_URL`) |
| GET | `/api/v1/imaging` | Performed-study messages by status (404 without `ORTHANC_URL`) |
| GET/POST/DELETE | `/api/v1/keys` | API keys (admin; secret shown once at creation) |
| PATCH/POST/DELETE | `/api/v1/keys/:id` (+ `/rotate`) | Rename / disable / expiry / rotate / revoke (admin) |
| GET | `/api/v1/audit` | Audit log (admin) |
| GET | `/api/v1/updates/status` | Signed-update agent state (admin; only when configured) |
| POST | `/api/v1/updates/check` / `apply` / `rollback` | Signed-update operations (admin) |

---

## 9. Device connectivity: ASTM

The ASTM listener accepts TCP connections from analyzers and runs the E1381 session protocol: `ENQ` → host `ACK` → one frame per record (`STX … ETX/ETB` + 2-hex checksum) → host `ACK` each frame (or `NAK` a corrupted one; the device retries) → `EOT` ends the session. Records accumulate across `ETB` frames; the `ETX` frame completes the message.

**Simulator:**

```bash
npm run simulate -- --count 10 --interval 200   # 10 messages, 200 ms apart
npm run simulate -- --corrupt-rate 0.5          # inject corrupt frames → NAK + retry on the wire
```

**Real-device notes** (documented extension points in `packages/astm/`):

- **Checksum** — mod-256 sum from `STX` through `ETX`/`ETB` inclusive, two uppercase hex digits. Some devices exclude `STX`; the codec exposes `checksumIncludesStx` as a per-device config point.
- **ACK/NAK** — the session acknowledges with a bare `ACK` and tolerates stray padding bytes; frame-number echoing (required by some analyzers) is a documented extension point.
- **Record layouts** — the hub uses a configurable per-device **profile** for field offsets (`H/P/O/R/L`); see [Device profiles](#16-device-profiles--conformance). A device whose O record swaps fields gets a profile, not a code change.
- **Serial transport** — the session/client take a minimal `DuplexLike` interface, so swapping TCP for RS-232 only changes how bytes arrive.

---

## 10. Device connectivity: HL7 v2 (MLLP)

Set `HL7_PORT` and the hub listens for **inbound HL7 v2 over MLLP** (in addition to ASTM). Supported message types:

| Message | Effect |
| --- | --- |
| **ORU^R01** (results) | Translated to canonical results and pushed through the full pipeline (validate → match → route) |
| **ORM^O01** (orders) | Registers the order in the **order registry** — the LIS seam; the RIS/imaging side consumes the same registry for the worklist |
| **ADT^A01 / A04 / A08** (admissions) | Registers the patient in the **admission registry** (used to enrich worklist items with patient names) |

Every inbound message receives an application ACK (`MSA|AA…`) on success.

The outbound side (`kind: 'hl7'` destinations) **serializes canonical messages to HL7 v2 (ORU/ORM)** and delivers them over MLLP to a LIS, awaiting the application ACK: `AA` → delivered; `AR`/`AE` → treated as a failed delivery (retry → DLQ). Outbound MLLP runs over a held-open connection pool (reuse, replace-on-dead-peer, idle close).

**Simulators:**

```bash
npm run simulate:hl7                                   # inbound ORU over MLLP
npm run simulate:hl7 -- --kind orm                     # ORM order feed
npm run simulate:hl7 -- --variant pid6-name --kind oru   # vendor-variant transcripts for profile testing
```

The variant simulator emits `oru` or `orm` wire with B4 vendor-variant layouts — variants `pid6-name`, `obx-swap`, `delimiters` (see `VARIANT_DEFS`). ADT admission messages have no simulator yet — the ADT golden corpus (`goldens/hl7-adt-admissions.json`) runs in CI, and the ADT feed itself is exercised through the demo/test suite.

HL7 **segment-level profiles** (workstream B4) let a device profile pin per-vendor PID/OBR/OBX field positions + delimiter overrides; the gateway resolves the layout from the MSH sender identity.

---

## 11. Imaging & DICOM (Orthanc)

The hub **does not speak DICOM networking** — it drives Orthanc (a separate AGPLv3 process, never embedded) over its REST API.

### 11.1 Enabling imaging

```bash
docker compose up -d --build orthanc    # builds the derived image (adds the Worklists plugin)
ORTHANC_URL=http://127.0.0.1:8042 ORTHANC_USER=orthanc ORTHANC_PASSWORD=orthanc npm start
```

The compose `orthanc` image is derived (`docker/orthanc/Dockerfile`, M3.5): a **version-pinned, multi-arch** base (`orthancteam/orthanc:26.8.2` — amd64 **and** arm64, replacing the amd64-only `jodogne/orthanc:latest`) plus the REST-based **Worklists plugin** (0.9.2, AGPLv3+) **source-built in the image** (the prebuilt binaries are x86_64-only; `STATIC_BUILD` keeps the .so self-contained) and the plugin config enabling DB-backed worklists. Upgrades are a one-line version bump + rebuild; the AGPL boundary policy is `docs/orthanc-agpl-boundary.md` (§7.5.5).

### 11.2 What runs when `ORTHANC_URL` is set

1. **MWL study monitor** (`hub.mwl`, every `MWL_POLL_MS`): pushes the order registry's active orders onto the Orthanc worklist (idempotently, joined with the admission registry's patient name), then polls for performed studies (accession match). Performed studies are retired from the worklist and surfaced on `hub.mwl`.
2. **Imaging router** (`hub.imaging`): each performed study becomes a hub **message** (envelope `imaging` field — canonical study metadata + storage URLs only; **pixels never enter the hub**) and flows through the dispatcher: dedup → DB-driven route rules → `console`/`http` delivery → ROUTED/DUPLICATE/FAILED, in the same message viewer as lab results.
3. **Modality health monitor** (`hub.modalities`, every `MODALITY_POLL_MS`): lists Orthanc's configured DICOM modalities and **C-ECHOes** each one; every outcome flips that modality's device row (protocol DICOM) and feeds `device-offline` alerting. Rows auto-drop when a modality is removed from Orthanc's config.
4. **Storage routing to PACS** — with `ORTHANC_FORWARD_PEER` set to a peer configured in Orthanc, each performed study is also forwarded Orthanc→peer (pixels move Orthanc→PACS; the hub only triggers + records the routing). The compose stack includes a `pacs` archive Orthanc for this.

### 11.3 Observing imaging in the console

- **Radiology panel** — worklist sync totals + live items, and per-study routing status with Retry on FAILED.
- **Devices panel** — the `orthanc` device row (connected/disconnected + lastSeen) and one row per configured modality.
- **Alerts** — the seeded `orthanc-down` rule (threshold 3) fires on consecutive failed polls, resolves on the first successful one.
- **REST** — `GET /api/v1/mwl` (monitor status + live worklist) and `GET /api/v1/imaging` (performed-study messages by status).

### 11.4 Demos

```bash
docker compose up -d --build orthanc && npm run demo:dicom     # adapter + worklist client against a real container
docker compose up -d --build orthanc && npm run demo:mwl       # the real hub's monitor: wire order → worklist → performed → ROUTED
docker compose up -d pacs && npm run demo:routing              # M3.3: metadata routed + pixels archived to the PACS peer
```

---

## 12. How a message flows through the pipeline

Lifecycle (plan §5.3): `RECEIVED → PARSED → VALIDATED → MAPPED → QUEUED → DELIVERING → ROUTED`, with `FAILED (+DLQ)` / `DUPLICATE` / `DISCARDED` / `HELD` as the other states.

1. **Transport** — a device/LIS connects; the ASTM session or the MLLP session delivers the wire message.
2. **Parse** — the protocol layer splits the message into records/segments and fields (`@integration-hub/astm`, `@integration-hub/hl7`), using the bound device profile's layout when one exists.
3. **Validate** — patient identifier, order identifier, and at least one result with a value are required. Failures are recorded `FAILED` with the issues — never dropped.
4. **Map** — vendor test codes become canonical codes via the mapping table (per-device profile mappings override the global table); `originalTestCode` is kept for the viewer. Unmapped codes pass through.
5. **Match + validate clinically** (in the dispatcher) — the patient/order **matching** engine tries the configured key strategies (patient id + order id, then patient id + sample/accession id) against the expected-order registry. Exactly one unique hit = `MATCHED`; several = `AMBIGUOUS`; a cancelled order = `REJECTED`; none = `UNMATCHED`. Anything but a unique match is **HELD for operator review** — no silent auto-assign. Validation rules then run (patient matched? order exists? test known? unit recognized? result plausible? device authorized?) — error-severity findings hold the message, warnings are recorded on the timeline.
6. **Route** — route rules resolve destinations (see below); delivery runs with per-destination retry/backoff, every attempt recorded.
7. **Terminal** — success ends `ROUTED`; exhausted retries go to the **dead-letter queue** (`FAILED` + `dlqAt`) — never dropped. `DUPLICATE` when the 24 h dedup key hits; `DISCARDED` when an operator retires a DLQ message; `HELD` waits in the review queue.

**Dedup** — SHA-256 of protocol + device + raw wire text, retained 24 h (configurable). A device resending a result (e.g. reconnect that lost the ACK) becomes `DUPLICATE` with a link to the original. Operator-initiated replays/retries bypass it.

The console shows the whole timeline for every message; DLQ and HELD messages are visible at `GET /api/v1/dlq` and `GET /api/v1/held`.

---

## 13. Routing & destinations

Routing is **DB-driven** (or in-memory without Postgres):

- **Destinations** — an outbound endpoint with a retry policy. Kinds:
  - `console` — the built-in message viewer (default when no rule matches; delivery is a no-op because the message is already persisted).
  - `http` — `POST` the canonical message JSON to a URL (`AbortSignal.timeout(5000)`); non-2xx throws → retry.
  - `hl7` — serialize to HL7 v2 and deliver over MLLP to a LIS (host/port + MSH fields), awaiting the application ACK.
- **Route rules** — match by `deviceId` and/or `status`, ordered by `priority` (lower = higher). The highest-priority matching rules select destinations.
- **Retry policy** — per destination: `maxAttempts` (default 3), `backoffMs` (250), `backoffFactor` (2), `jitter` (±20% to avoid thundering herd).

```bash
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:3000/api/v1/destinations   # list
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"id":"lis-1","kind":"hl7","name":"Lab LIS","hl7":{"host":"10.0.0.5","port":6661,"receivingApp":"LIS"}}' \
     http://127.0.0.1:3000/api/v1/destinations
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"id":"r1","destinationId":"lis-1","priority":10}' \
     http://127.0.0.1:3000/api/v1/routes
```

An `hl7` destination with no deliverer wired throws on delivery → retry → DLQ (never silent).

---

## 14. The DLQ, HELD queue & replay operations

### 14.1 Dead-letter queue (DLQ)

Exhausted retries (or pipeline-validation failures) land in the DLQ: status `FAILED` + `dlqAt`, visible at `GET /api/v1/dlq` and in the console. An operator can:

- **Retry** — `POST /api/v1/messages/:id/retry`: requeues the message **under the current route rules**. Fix the broken destination/rule first, then retry — the message re-runs and (now) routes. The DLQ marker clears on requeue; a still-broken destination re-DLQs with a fresh attempt budget. Returns 409 when the message is not DLQ'd; 404 when unknown. Imaging messages retry through the imaging dispatcher; lab messages through the main dispatcher.
- **Discard** — `POST /api/v1/messages/:id/discard`: retires the message (terminal `DISCARDED`, stays visible for audit).

### 14.2 HELD exception queue

Messages that fail matching (UNMATCHED/AMBIGUOUS/REJECTED) or error-severity validation are parked `HELD` — never silently delivered, never dropped. Review them at `GET /api/v1/held` (the console shows the reason), then:

- **Release** — `POST /api/v1/messages/:id/release`: re-enters a reviewed message into delivery (`QUEUED → … → ROUTED`).

### 14.3 Replay (lab correction flow)

`POST /api/v1/messages/:id/replay` re-runs a message through the pipeline (bypasses dedup). Used for corrections/retransmission; requeues under the current route rules.

---

## 15. Alerting

Rules watch events the hub already produces and fan out to channels: `console` (the API/UI alert list) and `webhook` (HTTP POST of `{ rule, kind, status: FIRING|RESOLVED, ... }` — delivery failures are logged, never thrown).

**Six rule kinds** (`GET/POST/DELETE /api/v1/alert-rules`):

| Kind | Fires | Resolves |
| --- | --- | --- |
| `device-offline` | a device connection drops | the device reconnects |
| `destination-down` | consecutive failed deliveries to one destination reach the threshold | any successful delivery |
| `orthanc-down` | consecutive failed MWL polls reach the threshold (subject = Orthanc base URL; seeded by default, threshold 3) | any successful poll |
| `dlq` | the dead-letter queue sits at/above a count | the queue drains |
| `held-backlog` | the HELD queue sits at/above a count | the queue drains |
| `profile-drift` | a bound device delivers under a profile whose stored version no longer matches its certified baseline (fires once per device on the first drifted delivery) | any later non-drifted delivery (or the device unbinds) |

Rule shape: `{ id, kind, name, subject?, threshold (default 1), cooldownMs?, channels: ['console'|'webhook'], webhookUrl?, enabled }`. A rule+subject fires at most once until resolved (or cooldown elapses), so operators aren't spammed. Seeded defaults: `orthanc-down` and `profile-drift` — delete them to mute.

---

## 16. Device profiles & conformance

Certified device support is **configuration, not code**. A profile (`GET/POST /api/v1/profiles`) turns the generic pipeline into a device adapter: 1-based record-layout field positions (P/O/R records), per-model test-code mappings, capabilities, transport/session options — and, for HL7, per-vendor PID/OBR/OBX positions + delimiter overrides.

- **Validation** — every profile is zod-validated at the API boundary and whenever stored JSON is read back; a corrupt profile fails loudly instead of silently mis-parsing results. Stores: in-memory and Postgres (`device_profiles` table).
- **Binding (A4 seam)** — a registered device carries an optional `profileId`; when set, the gateway canonicalizes that device's stream with the profile's layout + mappings. Register: `POST /api/v1/devices` with `profileId`. Unbound devices and the simulator keep the generic reference behavior.
- **Golden-message conformance** — `goldens/*.json` pair a certified profile with recorded transcripts and the canonical output they must produce (including negative cases). `runConformance` replays them through the real pipeline; the CI suite runs every golden file. A profile is only as good as its recorded conformance run — the `GET /api/v1/profiles/:id/conformance` view re-runs the profile's *current* config against its goldens and shows per-case failures when an edit drifted it away from certification.
- **Version stamping + drift** — every message parsed through a binding carries `profile: {id, version, certifiedVersion?, drift?}`. When the stored profile version differs from the golden-recorded `certifiedVersion` (edited after certification), messages are stamped `drift: true` with a `FLAGGED` timeline entry — results still flow, the console marks them red, and the `profile-drift` alert can page.
- **Field procedure** — onboarding a real analyzer (session bring-up, transcript capture, profile + golden authoring, CI gate, device binding, soak, version discipline) is documented in [`docs/analyzer-certification-runbook.md`](analyzer-certification-runbook.md).

---

## 17. Persistence: PostgreSQL

With `DATABASE_URL` set, the hub persists everything durably:

- `messages` — envelope + raw + parsed records + canonical payload + timeline (+ `imaging` jsonb for study events), with canonical `patients` / `orders` / `results` tables. One message lands in the DB **atomically** — envelope + clinical rows in a single transaction, so a crash cannot leave a half-persisted result.
- `devices`, `device_profiles`, `order_registry`, `admission_registry`, `alert_rules` + `alerts`, `api_keys`, `test_mappings`, `destinations` + `route_rules`, audit log.
- Migrations live in `packages/api/migrations/` (0012 currently) and **apply automatically at startup**. The compose dev DB: `postgres://hub:hub@localhost:5434/hub`.

```bash
npm run db:up        # compose: Postgres 16 (host 5434) + Redis (6380)
npm run test:db      # full suite against a live Postgres (dedicated hub_test DB, migrations re-run)
```

Backend choice is a wiring decision in `packages/server/src/index.ts` — set `DATABASE_URL` and everything (gateway sink, device registry, mappings) is durable. The gateway awaits async sinks and surfaces persistence failures as session errors rather than dropping messages silently.

Note: delivery is processed **in-process** (edge-outbox shape, plan §4.2). If the process dies mid-queue, queued jobs remain visible as `QUEUED` but are not auto-resumed; the Redis/BullMQ worker (compose has Redis on 6380) is the cloud-side replacement behind the same contract.

---

## 18. Signed remote updates & the supervisor

A release is an Ed25519-signed manifest (`schemaVersion 1`: release id/version/platform + `minHubVersion`/`maxHubVersion` range + env payload). The hub polls an outbound-only source, verifies the signature against `UPDATE_PUBLIC_KEY`, and stages; a **supervisor** process owns the hub lifecycle and performs the swap with a health gate — rolling back automatically when the new release fails to come up.

```bash
# Operator side: generate keys, sign a manifest (scripts/update-cli.ts)
npm run update-cli -- keygen
npm run update-cli -- sign manifest.json --key keys/update-key.pem -o manifest.signed.json
npm run update-cli -- verify manifest.signed.json --pub keys/update-key.pub.pem

# Hub side: run under the supervisor with the update source + public key
HUB_STATE_DIR=.hub-state UPDATE_SOURCE=… UPDATE_PUBLIC_KEY="$(cat keys/update-key.pub.pem)" \
  npm run start:supervised
```

API (admin): `POST /api/v1/updates/{check,apply,rollback}`, `GET …/status`. Version state lives in `HUB_STATE_DIR`; the console's **Software updates** panel shows it. Release identity is surfaced on `/health` and `/api/v1/version`. Run the hub under plain `npm start` without a state dir and the update endpoints report the agent as not configured. Full loop: `npm run demo:update`.

---

## 19. Simulators & demos

| Command | What it does |
| --- | --- |
| `npm run demo` | Full lab loop in memory: expected order → matched results + a stray sample → HELD → release → summary |
| `npm run demo:hl7` | Same loop with inbound ORU over MLLP |
| `npm run demo:outbound` | Results store-and-forward to a mock LIS over MLLP (`hl7` destination + route rule) |
| `npm run demo:dicom` | DICOM adapter + MWL worklist client against a real Orthanc container |
| `npm run demo:mwl` | The real hub's MWL monitor: wire ORM order → worklist → performed study → ROUTED message |
| `npm run demo:routing` | M3.3 storage routing against two Orthanc containers: metadata routed to a webhook + pixels forwarded to the PACS peer |
| `npm run demo:db` | In-memory demo but persisted to Postgres (`DATABASE_URL` preset) |
| `npm run demo:update` | Signed-update loop: check → apply → swap → rollback |
| `npm run simulate` | ASTM analyzer simulator (`--count`, `--interval`, `--corrupt-rate`) |
| `npm run simulate:hl7` | HL7 simulator (`--kind oru\|orm\|adt`, `--variant <name>` for B4 vendor variants) |

---

## 20. Troubleshooting

### The API key does not work

This is the most common first-run issue. Causes, in order of likelihood:

1. **The key changed between restarts.** Unless you set `HUB_ADMIN_KEY`, the hub **generates a new admin key at every boot** and prints it once. A key from a previous session is no longer valid. Fix: pin the key —
   `HUB_ADMIN_KEY=ihk_your_key npm start` — and reuse that exact value.
2. **The pasted key has surrounding whitespace or was truncated.** The console input is exact-match; paste the full `ihk_…` string.
3. **The key's role lacks the scope.** E.g. a `viewer` key cannot call mutating routes. Check the role at `GET /api/v1/me` and the route-scope table (§6.1).
4. **The key was disabled, expired, or rotated.** Disabled/expired keys refuse authn while staying listed; rotating revokes the old secret immediately. Re-issue or create a new key.
5. **Auth is disabled on one side only.** If the server runs with `AUTH_DISABLED=1`, it ignores keys entirely (still accepts anything); conversely a `401` means auth is on and the presented key is unknown. When in doubt, check the boot log: it prints whether auth is enabled and the current admin key.

### The console shows the Sign-in modal on every refresh

The stored key was rejected (`401` clears it). Re-paste the current key (see above — it regenerates each boot without `HUB_ADMIN_KEY`).

### The hub starts but no HL7 traffic works

`HL7_PORT` is **opt-in**. Set it (`HL7_PORT=6661 npm start`) and confirm the boot log prints `[gateway] HL7 v2 (MLLP) listening on tcp://…`.

### The Radiology panel / `/api/v1/mwl` returns 404

Imaging is off. Set `ORTHANC_URL` (plus user/password when Orthanc requires them) and restart. 404 is the designed "not configured" response.

### The Devices panel shows Orthanc/imaging devices but they never update

Check `ORTHANC_URL` reachability from the hub host (`curl http://127.0.0.1:8042/`). The `orthanc` device row flips with each MWL poll outcome; modality rows update per `MODALITY_POLL_MS` C-ECHO. A down Orthanc reports nothing new and the last-known rows stand.

### A message is stuck FAILED in the DLQ

1. `GET /api/v1/messages/:id` and read the timeline + `errors` to find the failing step (validation vs delivery).
2. Delivery failure → inspect the destination (`GET /api/v1/destinations`): wrong URL/host/port, destination down, or an `hl7` destination without a reachable LIS.
3. Fix the destination/rule, then `POST /api/v1/messages/:id/retry` — the message requeues under the current rules. 409 means it isn't DLQ'd (it may be HELD — release it instead).
4. If retries re-fail immediately with a validation error, the message itself is the problem — discard it after review, and fix the mapping/profile that caused the invalid parse.

### A result is stuck HELD

HELD means matching or validation could not safely proceed (no silent auto-assign). Open `GET /api/v1/held`, read the `match` outcome + validation errors, fix the cause (e.g. register the expected order via `POST /api/v1/orders`, or the device/profile binding), then `POST /api/v1/messages/:id/release`.

### An alert never fires (or never resolves)

- Check the rule's `threshold`, `enabled`, and `cooldownMs` (`GET /api/v1/alert-rules`). `device-offline`/`destination-down`/`orthanc-down` need *consecutive* events to reach the threshold — a single flake won't fire.
- `webhook` channel configured? The console channel only shows in the UI alert list; to page, add a `webhookUrl`.
- Alerts are per-subject and fire at most once until resolved — a resolved history entry is expected after recovery (`GET /api/v1/alerts`).

### Nothing appears in Postgres

- Confirm the hub actually runs with `DATABASE_URL` set (boot log, or `GET /api/v1/health` → `storage: postgres`).
- Migrations auto-apply at startup (`packages/api/migrations/`); a fresh DB should get 0012 on first boot.
- The imaging `payload`/`imaging` distinction: lab messages persist `payload`; performed-study events persist in the `imaging` jsonb column (migration 0012). Both are visible in the message viewer.

### Port conflicts on startup

- macOS: port **5000** is often taken by AirPlay — use `--device-port 5001` or the compose stack (which already maps 5001).
- Postgres 5432 clashes with other local projects — the compose dev DB deliberately uses host port **5434**.

### TLS: the console shows a cert warning

The on-prem CA isn't trusted by the OS yet. Install `tls/ca.pem` into the OS trust store (or accept the prompt). Node integration clients need `NODE_EXTRA_CA_CERTS=tls/ca.pem`. The supervisor probes https with verification skipped for self-signed on-prem certs (set `HUB_TLS_VERIFY_PROBE=1` once the CA is trusted).

### Where do I look when something is wrong?

1. The **console message detail** — timeline + errors for the specific message.
2. The **hub console output** — structured `[gateway]` / `[mwl]` / `[modality]` / `[alerts]` log lines.
3. `GET /api/v1/alerts?firing=true` — active alert state.
4. The audit log (`GET /api/v1/audit`) — who changed what (config changes are audited).
5. The DLQ / HELD endpoints — nothing should ever be silently dropped; both queues are the "exception" surface.

---

## 21. Keeping this manual current

**Update rule:** every slice that lands must update this manual in the same change. Concretely, when you touch:

- **Env vars or CLI flags** → §4, §5.
- **API routes** → §8 (and `ROUTE_SCOPES` in code — a new route is denied until it's listed there).
- **Console panels** → §7.
- **Protocol support / device connectivity** → §9–§11.
- **Pipeline behavior, statuses, DLQ/HELD semantics** → §12–§14.
- **Alert kinds or rule shape** → §15.
- **Profiles / conformance / goldens** → §16.
- **Persistence or migrations** → §17.
- **Updates / supervisor** → §18.
- **Simulators / demos / npm scripts** → §19.
- **New failure modes** → §20 (troubleshooting is a first-class deliverable, not an afterthought).
- **Known future work** → keep the roadmap pointer in §1's note; the plan (`docs/implementation-plan.md`) holds forward-looking detail, this manual holds what exists today.

Verification: after a feature change, re-read the sections you touched against the running hub — `npm run demo` + `npm start` + a signed-in console pass is the fastest smoke, plus `npm test` / `npm run test:db` for behavior.