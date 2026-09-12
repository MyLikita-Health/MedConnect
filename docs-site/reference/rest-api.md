---
title: REST API reference
description: Every /api/v1 route with auth requirements, plus the OpenAPI spec, webhook events and FHIR types.
outline: [2, 3]
---

# REST API reference

Base: `http://<hub-host>:3000/api/v1`

**Auth** — every route requires `Authorization: Bearer <key>` except
`/health` (liveness) and `/openapi.json` (public by design). Keys map to
one role; roles grant scopes. See
[Setup → API keys and roles](/guide/setup#api-keys-and-roles) for the
role table and lifecycle.

## Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/health` | Liveness; reports `storage: memory\|postgres\|sqlite` + version |
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
| GET/POST/DELETE | `/api/v1/profiles` | Device profiles |
| GET | `/api/v1/profiles/:id/conformance` | Re-run a profile's current config against its recorded goldens |
| GET/POST/DELETE | `/api/v1/alert-rules` | Alert rules |
| GET | `/api/v1/alerts?firing=&limit=` | Derived alerts: fire/resolve history |
| GET | `/api/v1/mwl` | MWL study monitor: status + live Orthanc worklist (404 without `ORTHANC_URL`) |
| GET | `/api/v1/imaging` | Performed-study messages by status (404 without `ORTHANC_URL`) |
| GET/POST/DELETE | `/api/v1/keys` | API keys (admin; secret shown once at creation) |
| PATCH/POST/DELETE | `/api/v1/keys/:id` | Rename / disable / expiry / revoke (admin) |
| POST | `/api/v1/keys/:id/rotate` | Mint a new secret for the same key identity (admin) |
| GET | `/api/v1/audit` | Audit log (admin) |
| GET/POST/PATCH/DELETE | `/api/v1/webhooks` | Webhook subscriptions |
| GET | `/api/v1/webhooks/deliveries` | Delivery log |
| POST | `/api/v1/webhooks/deliveries/:eventId/replay` | Replay a delivery |
| POST | `/api/v1/webhooks/test` | Test ping to a subscription |
| GET | `/api/v1/updates/status` | Signed-update agent state (admin; only when configured) |
| POST | `/api/v1/updates/check` / `apply` / `rollback` | Signed-update operations (admin) |

## OpenAPI spec

`GET /api/v1/openapi.json` serves an **OpenAPI 3.1** spec covering every
route with request/response schemas, auth requirements and tags — public,
so developers can discover the API without a key. Point Swagger UI,
Postman or Insomnia at it. `npm run demo:sandbox` seeds a demo dataset and
prints a curl walkthrough of every endpoint.

## Webhook events

The signed event bus (`X-IntegrationHub-Signature`, HMAC-SHA256) fires at
the hub's real seams:

| Event | Fired when |
| --- | --- |
| `result.received` | A message is recorded |
| `message.failed` | A message lands in the DLQ |
| `device.connected` / `device.disconnected` | Device state flips |
| `order.received` | An order is registered (ORM feed or API) |

## FHIR R4

`GET /api/v1/fhir/:type` projects hub data as FHIR resources (two-way
translator, round-trip tested). Base: `<hub>/api/v1/fhir`.

| Type | Projected from |
| --- | --- |
| `Patient` | Admission registry / canonical patients |
| `ServiceRequest` | Expected-order registry |
| `DiagnosticReport` | Messages with results |
| `Observation` | Canonical result rows |
| `ImagingStudy` | Performed-study metadata |
| `Device` | Device registry |