---
title: Infrastructure
description: Storage backends, Docker services, TLS, remote updates and cloud pairing.
outline: [2, 3]
---

# Infrastructure

Integration Hub runs in one of two shapes:

- **Edge (single box)** — the Windows desktop installer with embedded SQLite.
  Everything local, no Docker, works fully offline. This is the clinic/lab
  deployment.
- **Cloud (server)** — the Docker image with PostgreSQL, ready to be paired
  with many edges. This is the hosted platform shape.

## Storage backends

The hub picks its backend from environment at startup — nothing in the
gateway, pipeline or API routes knows which one is live:

| Backend | When | How |
| --- | --- | --- |
| **In-memory** | Scaffold default, tests | No config; data is lost on restart |
| **PostgreSQL** | Cloud/server | Set `DATABASE_URL`; migrations auto-apply at startup |
| **SQLite** | Windows edge | `DB=sqlite` (or `sqlite: { file }` in `startHub`); WAL + `synchronous=FULL` for crash-safe local durability |

`DATABASE_URL` defaults to `postgres://hub:hub@localhost:5434/hub` (matches
`docker-compose.yml`). Migrations live in `packages/api/migrations/` and are
applied automatically by a tiny zero-dependency runner.

## Docker services

`docker compose up -d` brings up the dev stack:

| Service | Image | Host ports |
| --- | --- | --- |
| `db` | `postgres:16-alpine` | **5434** → 5432 |
| `redis` | `redis:7-alpine` | **6380** → 6379 |
| `hub` | `medconnect-hub:0.1.0` | **3000** (API/console), **5001 → 5000** (devices) |
| `orthanc` | `medconnect-orthanc:0.2.0` (bundles the Worklists plugin) | **8042** (REST), **4242** (DICOM) |
| `pacs` | `orthancteam/orthanc:26.8.2` (archive) | **8043** (REST), **4243** (DICOM) |

> **Port note:** host port **5001** maps to the hub's device port **5000**
> because macOS AirPlay occupies 5000. On other hosts use `5000` directly.

## Ports and listeners

| Port | Listener | Env / flag |
| --- | --- | --- |
| `3000` | REST API + web console | `PORT` / `--http-port` |
| `5000` | ASTM device listener | `DEVICE_PORT` / `--device-port` |
| *(unset by default)* | HL7 v2 MLLP listener | `HL7_PORT` — the HL7 gateway only starts when set |
| `8042` / `4242` | Orthanc REST / DICOM (imaging bundle) | — |
| `5434` / `6380` | Dev Postgres / Redis (compose only) | — |

All listeners bind `127.0.0.1` by default; set `HOST` (or `--host`) to bind
the LAN.

## TLS for device + LIS connections

Set `HUB_TLS_CERT` / `HUB_TLS_KEY` (PEM files) and **both** the REST API
(`https://…:3000`) and the ASTM device listener terminate TLS. Generate
on-prem material — a facility CA plus a hub cert signed by it — with:

```bash
npm run tls:gen -- hub-hostname.internal lab-lan   # extra SANs optional
# → tls/ca.pem (TRUST THIS), tls/hub.pem + tls/hub-key.pem (serve these)
HUB_TLS_CERT=./tls/hub.pem HUB_TLS_KEY=./tls/hub-key.pem npm start
```

**CA trust flow.** Keep `tls/ca-key.pem` offline after issuance; `ca.pem` is
the facility root of trust:

- Analyzers / LIS software import `tls/ca.pem` into their trust store and
  connect over TLS — the hub presents a cert chaining to `ca.pem`, so it
  verifies without per-device key shipping.
- Browsers: install `ca.pem` in the OS trust store (or accept the prompt).
- Curl: `curl --cacert ./tls/ca.pem https://host:3000/api/v1/health`.
- Node clients: `NODE_EXTRA_CA_CERTS=tls/ca.pem`.

Mutual TLS (client certs for devices) is planned edge hardening, not yet in.

## Remote updates (signed)

A release is an **Ed25519-signed manifest** (`schemaVersion 1`: release
id/version/platform + `minHubVersion`/`maxHubVersion` range + env payload).
The hub polls an outbound-only source, verifies the signature against
`UPDATE_PUBLIC_KEY`, and stages; a **supervisor** process owns the hub
lifecycle and performs the swap with a health gate — rolling back
automatically when the new release fails to come up.

```bash
# Operator side: generate keys, sign a manifest (scripts/update-cli.ts)
npm run update-cli -- keygen
npm run update-cli -- sign manifest.json --key keys/update-key.pem -o manifest.signed.json
npm run update-cli -- verify manifest.signed.json --pub keys/update-key.pub.pem

# Hub side: run under the supervisor with the update source + public key
HUB_STATE_DIR=.hub-state UPDATE_SOURCE=… UPDATE_PUBLIC_KEY="$(cat keys/update-key.pub.pem)" \
  npm run start:supervised
```

Version state (current / desired / last-good / history) lives in the state
dir (`HUB_STATE_DIR`); the console's **Software updates** panel shows it and
offers check/apply/rollback to admins. Release identity is surfaced on
`/health` and `/api/v1/version`.

## Windows service (edge)

The desktop installer registers the hub as a **WinSW** Windows service named
`integration-hub` (plus `integration-hub-orthanc` for the imaging bundle).
The OS keeps the process alive; `HubSupervisor` owns crash/health/rollback.
Service logs are written to `%ProgramData%\IntegrationHub\logs\` (`hub.log` +
the WinSW wrapper log) — console output is unreliable under a service
context.

## Cloud pairing

A local edge can pair to the cloud platform later: the W1 **outbox** (D11)
stores every message locally, and on boot the hub applies a stored pairing
bundle and runs the same `OutboxSyncer` the PG edge uses — one code path.
Pairing uses an `ihp_…` claim code; the gateway key (`ihk_gw_…`) is stored
at rest and **never echoed** over the API. See [Setup → Pairing](/guide/setup#pairing).