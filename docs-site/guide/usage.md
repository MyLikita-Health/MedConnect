---
title: Usage
description: The console, REST API, everyday workflows, alerts and integrations.
outline: [2, 3]
---

# Usage

## The console

Open `http://<hub-host>:3000/`. Panels:

| Panel | What it shows |
| --- | --- |
| **Dashboard** | Live status + totals by status |
| **Devices** | Wire devices + Orthanc/modality health, register devices |
| **Messages** | Viewer with raw + parsed + canonical payload and the full pipeline timeline; replay, DLQ retry/discard, HELD release |
| **Radiology** *(imaging only)* | Orthanc worklist sync + performed-study routing with per-study retry |
| **Alerts** | Firing/resolved alerts; rule management |
| **Access keys** *(admin)* | Create/rename/disable/rotate/revoke API keys |
| **Software updates** *(admin)* | Check/apply/rollback signed releases |
| **Device profiles** | Certified (green) vs draft (amber) profiles + per-profile conformance view |
| **Webhooks** | Subscriptions, delivery log, replay, test ping |

## The REST API

Base: `http://<hub-host>:3000/api/v1` — every route (except `health`)
requires `Authorization: Bearer <key>`. The complete, generated reference
is the hub's own **OpenAPI 3.1 spec**: `GET /api/v1/openapi.json` (public —
point Swagger UI or Postman at it). Key routes:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/health` | Liveness + storage backend + release identity |
| GET | `/api/v1/stats` | Totals by status |
| GET/POST | `/api/v1/devices` | List / register devices |
| GET | `/api/v1/messages?status=&deviceId=&dlq=&limit=` | Messages, newest first |
| GET | `/api/v1/messages/:id` | Detail: raw, parsed, canonical, timeline |
| POST | `/api/v1/messages/:id/replay` | Re-run through the pipeline |
| POST | `/api/v1/messages/:id/retry` | Retry a DLQ'd message under current route rules |
| POST | `/api/v1/messages/:id/discard` | Retire a DLQ message |
| GET | `/api/v1/held` | Exception queue |
| POST | `/api/v1/messages/:id/release` | Release a HELD message into delivery |
| GET/POST/DELETE | `/api/v1/orders` | Expected-order registry (LIS seam) |
| GET | `/api/v1/mwl` | MWL study monitor (404 without `ORTHANC_URL`) |
| GET/POST/DELETE | `/api/v1/destinations` | Outbound destinations (HTTP, `hl7`) |
| GET/POST/DELETE | `/api/v1/routes` | Route rules: device/status → destination |
| GET/POST/DELETE | `/api/v1/alert-rules` | Alert rules |
| GET | `/api/v1/alerts?firing=&limit=` | Derived alerts |
| GET/POST/PATCH/DELETE | `/api/v1/webhooks` | Webhook subscriptions |
| GET | `/api/v1/fhir/:type` | FHIR R4: Patient, ServiceRequest, DiagnosticReport, Observation, ImagingStudy, Device |

## Everyday workflows

### Review the exception queue (operator)

1. Console → **Messages** → HELD filter (or `GET /api/v1/held`).
2. Inspect the message's timeline + match outcome (why it was held).
3. Fix the cause (register the expected order, correct the patient id)
   and **Release** — it re-enters delivery.

### Retire or retry dead letters

DLQ messages never drop. Retry re-queues under the **current** route rules
(a fixed destination now routes); discard retires it terminally. Every
attempt is recorded on the message timeline.

### Replay anything

`POST /api/v1/messages/:id/replay` re-runs any message through the
pipeline (dedup bypassed) — useful when profiles or mappings change.

### Send results to a LIS

1. Register an outbound destination (`POST /api/v1/destinations`, `kind`
   `http` or `hl7`).
2. Add a route rule (`POST /api/v1/routes`, device/status → destination).
3. Results flow store-and-forward with retry/backoff; failures land in
   the DLQ and `destination-down` alerts fire.

## Alerting

Rules watch hub events and fan out to **console** (the API/UI alert list)
and **webhook** channels. Six kinds:

| Kind | Fires when |
| --- | --- |
| `device-offline` | A device connection drops (resolves on return) |
| `destination-down` | Consecutive failed deliveries reach the threshold |
| `orthanc-down` | Consecutive failed MWL polls reach the threshold |
| `dlq` | The dead-letter queue sits at/above a count |
| `held-backlog` | The exception queue sits at/above a count |
| `profile-drift` | A bound device delivers under a drifted profile version |

A rule+subject fires at most once until resolved (or cooldown), so nobody
is spammed per event. Rules are seeded with sensible defaults
(`orthanc-down`, `profile-drift`) and configurable via
`GET/POST/DELETE /api/v1/alert-rules`.

Webhooks post `{ rule, kind, status: FIRING\|RESOLVED, ... }` as JSON.

## Webhook event bus

Domain events (signed with HMAC-SHA256 in `X-IntegrationHub-Signature`),
per-subscription retry, a delivery log with replay, and a test ping.
Events: `result.received`, `message.failed`,
`device.connected/disconnected`, `order.received`.

## FHIR R4

`GET /api/v1/fhir/:type` projects hub data as FHIR resources — two-way
translator, round-trip tested. Base: `<hub>/api/v1/fhir`.