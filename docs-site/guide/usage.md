---
title: Usage
description: The console, configuration reference, REST API, routing, queue operations, alerting and demo tooling.
outline: [2, 3]
---

# Usage

## The console

Open `http://<hub-host>:3000/` (https when TLS is on) and sign in with an
API key. The console auto-refreshes every 3 s. The left column is the
status/config side; the right column is the message side.

| Panel | Shows / lets you do |
| --- | --- |
| **Dashboard** | Metric counters (totals by status: received, mapped, routed, failed, dup, held, dlq) |
| **Devices** | Registered devices (protocol, transport, state, last seen). Wire gateways auto-register; you can register manually. With Orthanc configured: the `orthanc` device row (from the standing poll) and **one row per configured DICOM modality** (from C-ECHO probes) |
| **Device profiles** | Profile list with certified (green) / draft (amber) badges; add/replace/delete profiles; per-profile conformance view re-running the stored config against its recorded goldens |
| **Admissions** | Patient-admission registry — the ADT^A01 feed |
| **Alerts** | Firing/resolved alerts from the rule engine; rule management |
| **Radiology** *(only when `ORTHANC_URL` is set)* | **Orthanc worklist** — sync totals (created/queued/performed), poll cadence, live worklist items, poll errors in red. **Imaging studies** — per-status counts (ROUTED/DUPLICATE/FAILED) and each performed study; FAILED rows have **↩ Retry**; any row opens its full routing view |
| **Software updates** *(only when configured)* | Signed-update state (current/desired/last-good/history); check / apply / rollback for admins |
| **Access keys** *(admin only)* | Per-key status, expiry, last use (with a *never used* marker); inline rename / disable / enable / expiry / re-issue / delete |
| **Messages** | The message viewer: newest first, filterable by status/device; click a row for the detail view |
| **Message detail** | Status pill, timeline (RECEIVED → … → ROUTED/FAILED), raw + parsed + canonical payload, match outcome, profile stamp, replay / release / retry / discard actions per status. For **imaging** messages: the full study + routing view (performed-study metadata, storage link into Orthanc, resolved destinations, routing timeline, Retry from DLQ on FAILED) |

## Configuration

Every environment variable, CLI flag, port and endpoint — including the
SQLite edge vars, the TLS material and the update-agent settings — lives
in the [Configuration reference](/reference/configuration).

> Without `HUB_ADMIN_KEY`, the hub **generates a new admin key at every
> boot** and prints it once — the most common first-run stumbling block
> (see [Troubleshooting](/guide/troubleshooting#console-api)).

## How a message flows

Lifecycle:
`RECEIVED → PARSED → VALIDATED → MAPPED → QUEUED → DELIVERING → ROUTED`,
with `FAILED` (+DLQ), `DUPLICATE`, `DISCARDED` and `HELD` as the other
states.

1. **Transport** — a device/LIS connects; the ASTM or MLLP session
   delivers the wire message.
2. **Parse** — the protocol layer splits records/segments and fields,
   using the bound device profile's layout when one exists.
3. **Validate** — patient identifier, order identifier and at least one
   result with a value are required. Failures are recorded `FAILED` with
   the issues — never dropped.
4. **Map** — vendor test codes become canonical codes via the mapping
   table (per-device profile mappings override the global table);
   `originalTestCode` is kept for the viewer. Unmapped codes pass
   through.
5. **Match + validate clinically** (in the dispatcher) — matching tries
   the configured key strategies (patient id + order id, then patient id
   + sample/accession id) against the expected-order registry. Exactly
   one unique hit = `MATCHED`; several = `AMBIGUOUS`; a cancelled order =
   `REJECTED`; none = `UNMATCHED`. Anything but a unique match is **HELD
   for operator review** — no silent auto-assign. Validation rules then
   run (patient matched? order exists? test known? unit recognized?
   result plausible? device authorized?) — error-severity findings hold
   the message; warnings are recorded on the timeline.
6. **Route** — route rules resolve destinations; delivery runs with
   per-destination retry/backoff, every attempt recorded.
7. **Terminal** — success ends `ROUTED`; exhausted retries go to the
   **dead-letter queue** (`FAILED` + `dlqAt`) — never dropped.

**Dedup** — SHA-256 of protocol + device + raw wire text, retained 24 h
(configurable). A device resending a result (e.g. a reconnect that lost
the ACK) becomes `DUPLICATE` with a link to the original. Operator-initiated
replays/retries bypass it.

## The REST API

Base: `http://<hub-host>:3000/api/v1` — every route (except `health`)
requires `Authorization: Bearer <key>`. The complete route table lives in
the [REST API reference](/reference/rest-api); the generated **OpenAPI
3.1** spec is served by the hub itself at `GET /api/v1/openapi.json`
(public — point Swagger UI or Postman at it).

The routes operators touch daily:

| Task | Route |
| --- | --- |
| What's running? | `GET /api/v1/health`, `GET /api/v1/stats` |
| Watch messages | `GET /api/v1/messages`, `GET /api/v1/messages/:id` |
| Clear the exception queues | `GET /api/v1/held` + release; `GET /api/v1/dlq` + retry/discard |
| Register what the LIS expects | `GET/POST /api/v1/orders` |
| Send results onward | `/api/v1/destinations` + `/api/v1/routes` |
| Check the imaging pipeline | `GET /api/v1/mwl`, `GET /api/v1/imaging` |

## Routing & destinations

Routing is **DB-driven** (or in-memory without Postgres):

- **Destinations** — an outbound endpoint with a retry policy. Kinds:
  - `console` — the built-in message viewer (default when no rule
    matches; delivery is a no-op because the message is already
    persisted).
  - `http` — `POST` the canonical message JSON to a URL (5 s timeout);
    non-2xx throws → retry.
  - `hl7` — serialize to HL7 v2 and deliver over MLLP to a LIS
    (host/port + MSH fields), awaiting the application ACK.
- **Route rules** — match by `deviceId` and/or `status`, ordered by
  `priority` (lower = higher). The highest-priority matching rules select
  destinations.
- **Retry policy** — per destination: `maxAttempts` (default 3),
  `backoffMs` (250), `backoffFactor` (2), `jitter` (±20% to avoid a
  thundering herd).

```bash
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:3000/api/v1/destinations   # list
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"id":"lis-1","kind":"hl7","name":"Lab LIS","hl7":{"host":"10.0.0.5","port":6661,"receivingApp":"LIS"}}' \
     http://127.0.0.1:3000/api/v1/destinations
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"id":"r1","destinationId":"lis-1","priority":10}' \
     http://127.0.0.1:3000/api/v1/routes
```

## DLQ, HELD & replay operations

Nothing is ever silently dropped — the two queues plus replay are the
operator's exception surface.

### Dead-letter queue

Exhausted retries (or pipeline-validation failures) land in the DLQ:
status `FAILED` + `dlqAt`, visible at `GET /api/v1/dlq` and in the
console.

- **Retry** — `POST /api/v1/messages/:id/retry`: requeues the message
  **under the current route rules**. Fix the broken destination/rule
  first, then retry. The DLQ marker clears on requeue; a still-broken
  destination re-DLQs with a fresh attempt budget. Returns 409 when the
  message is not DLQ'd. Imaging messages retry through the imaging
  dispatcher (`hub.imaging`); lab messages through the main dispatcher.
- **Discard** — `POST /api/v1/messages/:id/discard`: retires the message
  (terminal `DISCARDED`, stays visible for audit).

### HELD exception queue

Messages that fail matching (UNMATCHED/AMBIGUOUS/REJECTED) or
error-severity validation are parked `HELD` — never silently delivered,
never dropped. Review at `GET /api/v1/held` (the console shows the
reason), then **Release** — `POST /api/v1/messages/:id/release` re-enters
the reviewed message into delivery.

### Replay (lab correction flow)

`POST /api/v1/messages/:id/replay` re-runs a message through the pipeline
(bypasses dedup) under the current route rules — for corrections and
retransmissions after mapping/profile changes.

## Alerting

Rules watch events the hub already produces and fan out to channels:
`console` (the API/UI alert list) and `webhook` (HTTP POST — delivery
failures are logged, never thrown).

**Six rule kinds** (`GET/POST/DELETE /api/v1/alert-rules`):

| Kind | Fires | Resolves |
| --- | --- | --- |
| `device-offline` | a device connection drops | the device reconnects |
| `destination-down` | consecutive failed deliveries to one destination reach the threshold | any successful delivery |
| `orthanc-down` | consecutive failed MWL polls reach the threshold (subject = the Orthanc base URL; seeded by default, threshold 3) | any successful poll |
| `dlq` | the dead-letter queue sits at/above a count | the queue drains |
| `held-backlog` | the HELD queue sits at/above a count | the queue drains |
| `profile-drift` | a bound device delivers under a profile whose stored version no longer matches its certified baseline (fires once per device on the first drifted delivery) | any later non-drifted delivery (or the device unbinds) |

Rule shape: `{ id, kind, name, subject?, threshold (default 1),
cooldownMs?, channels: ['console'|'webhook'], webhookUrl?, enabled }`. A
rule+subject fires **at most once until resolved** (or its cooldown
elapses), so operators are not spammed per event. Seeded defaults:
`orthanc-down` and `profile-drift` — delete them to mute.

Webhook payloads are `{ rule, kind, status: "FIRING"|"RESOLVED", ... }`.

## Simulators & demos

| Command | What it does |
| --- | --- |
| `npm run demo` | Full lab loop in memory: expected order → matched results + a stray sample → HELD → release → summary |
| `npm run demo:hl7` | Same loop with inbound ORU over MLLP |
| `npm run demo:outbound` | Results store-and-forward to a mock LIS over MLLP (`hl7` destination + route rule) |
| `npm run demo:dicom` | DICOM adapter + MWL worklist client against a real Orthanc container |
| `npm run demo:mwl` | The real hub's MWL monitor: wire ORM order → worklist → performed study → ROUTED message |
| `npm run demo:routing` | Storage routing against two Orthanc containers: metadata routed to a webhook + pixels forwarded to the PACS peer |
| `npm run demo:m3-exit` | The M3 exit drill: a pynetdicom fake modality drives the full imaging chain with failure injection (see [Devices](/guide/devices#the-m3-exit-drill-imaging-certification-gate)) |
| `npm run demo:db` | The demo persisted to Postgres (`DATABASE_URL` preset) |
| `npm run demo:update` | Signed-update loop: check → apply → swap → rollback |
| `npm run demo:sandbox` | Seeds a rich demo dataset and prints a curl walkthrough of every endpoint |
| `npm run simulate` | ASTM analyzer simulator (`--count`, `--interval`, `--corrupt-rate`) |
| `npm run simulate:hl7` | HL7 simulator (`--kind oru\|orm`, `--variant <name>` for vendor variants) |

## Webhook event bus

Signed domain-event delivery with HMAC-SHA256 signatures
(`X-IntegrationHub-Signature`), per-subscription retry, a delivery log
with replay, and a test ping. Events fire at the hub's real seams:
`result.received`, `message.failed`, `device.connected/disconnected`,
`order.received`. Subscriptions persist across restarts. REST surface:
`GET/POST/PATCH/DELETE /api/v1/webhooks`,
`GET /api/v1/webhooks/deliveries`,
`POST /api/v1/webhooks/deliveries/:eventId/replay`,
`POST /api/v1/webhooks/test`. Console: **Webhooks** panel.

## FHIR R4

`GET /api/v1/fhir/:type` projects hub data as FHIR resources — Patient,
ServiceRequest, DiagnosticReport, Observation, ImagingStudy, Device. The
translator is two-way and round-trip tested (the serializer doubles as a
conformance oracle). Base: `<hub>/api/v1/fhir`.