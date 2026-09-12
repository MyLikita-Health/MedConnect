---
title: Project overview
description: What Integration Hub is, the architecture, and where the project stands.
outline: [2, 3]
---

# Project overview

Integration Hub is a healthcare interoperability platform: a hub that connects
**laboratory analyzers** to **LIS/HIS systems** over ASTM and HL7, translates
everything into a canonical internal model, validates it clinically, and
exposes it through a REST API and a web console. The desktop edition bundles
an **imaging path** (DICOM via Orthanc) and runs as a supervised Windows
service with embedded SQLite — a single-box edge for a clinic or lab.

```
Analyzer (simulator) ──ASTM/TCP──▶ Edge gateway ──pipeline──▶ REST API + console UI
                                     ENQ/ACK frames            parse → validate → map → route
                                     checksums, NAK/retry      message viewer, replay
```

## What it does

- **Ingests** analyzer results (ASTM E1381/E1394), HL7 v2 messages (ORU/ORM/ADT
  over MLLP) and imaging studies (DICOM through Orthanc).
- **Validates** every result before delivery: expected-order matching, test
  catalog, units, plausibility, device authorization. Anything that does not
  uniquely match is parked in the **HELD exception queue** for an operator —
  never silently auto-assigned, never dropped.
- **Delivers** to configured destinations (HTTP webhooks, HL7 LIS, the console)
  with retry/backoff, a dead-letter queue and full audit timelines.
- **Monitors** devices and destinations with six alert rule kinds, and exposes
  FHIR R4 resources and signed webhook events for downstream systems.

## Architecture

An **npm-workspaces TypeScript monorepo**. The protocol layer is
zero-dependency; everything else wires through small interfaces, so a durable
store or a new protocol adapter can be dropped in without touching the
pipeline.

| Package | Responsibility |
| --- | --- |
| `@integration-hub/shared` | Canonical data model, message envelope, statuses, `MessageSink` contract |
| `@integration-hub/astm` | ASTM E1381 framing + checksums, E1394 records, TCP sessions |
| `@integration-hub/hl7` | HL7 v2: MLLP framing, ORU/ORM/ADT translators, golden conformance runner |
| `@integration-hub/dicom` | Orthanc REST client, MWL worklist client, modality/peer store |
| `@integration-hub/gateway` | TCP listener, per-connection ASTM session, pipeline: parse → validate → map → route |
| `@integration-hub/core` | Message lifecycle, dedup, matching, validation, routing, dispatch, alerts |
| `@integration-hub/api` | Fastify + zod REST API, stores, embedded web console |
| `@integration-hub/simulator` | Analyzer simulator for realistic result messages |
| `@integration-hub/server` | Edge-gateway process wiring it all together |

Layering: `gateway` depends only on `astm` + `shared`; `core` depends on
`shared`; `api` depends on `shared` + `core`; `server` wires everything
through interfaces.

## Message lifecycle

```
RECEIVED → PARSED → VALIDATED → MAPPED → QUEUED → DELIVERING → ROUTED
```

With `FAILED` (+DLQ), `DUPLICATE`, `DISCARDED` and `HELD` as the other
states. Every message keeps a timeline of every step — the console viewer
shows it all.

## Where the project stands

- **M0–M4 foundations**: Postgres persistence, clinical gate, alerting,
  device profiles + conformance, FHIR, webhooks, OpenAPI, outbox sync,
  fleet/pairing surface — shipped.
- **Workstream B (HL7 v2 lab engine)**: inbound ORU/ORM/ADT, outbound
  store-and-forward, vendor-variant profiles — shipped.
- **M3 (imaging)**: Orthanc adapter, MWL worklist, storage routing, radiology
  console, modality health — shipped, with a certification exit drill.
- **W1–W5 (Windows desktop track)**: SQLite edge, NSIS installer, supervised
  service, signed update delivery, and a required post-publish smoke drill on
  real Windows — shipped.
- **Remaining**: certificate purchase + Authenticode signing (decision D13),
  M4-gate cloud criteria, and the M5 ecosystem milestone.

The authoritative roadmap is
[`docs/implementation-plan.md`](https://github.com/MyLikita-Health/MedConnect/blob/main/docs/implementation-plan.md)
in the repository. The full product requirements live in `docs/prd.txt`.

## Reading the rest of this guide

| Guide | What it covers |
| --- | --- |
| [Infrastructure](/guide/infrastructure) | Storage backends, Docker services, TLS, updates, cloud pairing |
| [Installation](/guide/installation) | From source, Docker, the Windows desktop installer |
| [Setup](/guide/setup) | First boot, API keys, roles, pairing |
| [Devices & connections](/guide/devices) | ASTM, HL7, DICOM/Orthanc, device profiles |
| [Usage](/guide/usage) | Console, API, everyday workflows, alerts |
| [Troubleshooting](/guide/troubleshooting) | Common problems and their fixes |