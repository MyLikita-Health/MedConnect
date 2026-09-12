---
title: Configuration reference
description: Every environment variable, CLI flag, port and endpoint the hub understands.
outline: [2, 3]
---

# Configuration reference

## Environment variables

| Env var | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address for all listeners |
| `PORT` | `3000` | REST API + web console port |
| `DEVICE_PORT` | `5000` | ASTM device listener port |
| `HL7_PORT` | *(unset — HL7 off)* | Inbound HL7 v2 MLLP listener port. Set it and the hub also speaks HL7 v2 |
| `DATABASE_URL` | *(unset — in-memory)* | PostgreSQL connection string. Set → durable store, migrations auto-apply |
| `DB` | *(unset)* | `sqlite` selects the embedded SQLite edge backend (single-box local mode) |
| `HUB_SQLITE_FILE` | *(data dir default)* | SQLite database file location |
| `HUB_ADMIN_KEY` | *(generated at boot)* | Fixed admin API key secret. Pin it to keep the same key across restarts |
| `AUTH_DISABLED` | *(unset)* | `1` turns off API auth entirely (dev only) |
| `HUB_TLS_CERT` / `HUB_TLS_KEY` | *(unset — plain TCP/HTTP)* | PEM files; both the REST API (https) and the device listener terminate TLS |
| `HUB_STATE_DIR` | *(unset)* | State dir for signed updates; set → update agent + `/api/v1/updates/*` live (run under the supervisor) |
| `UPDATE_SOURCE` | *(unset)* | Signed-manifest source: https URL, `.json` path, or a directory |
| `UPDATE_PUBLIC_KEY` | *(unset)* | PEM public key that must sign update manifests |
| `ORTHANC_URL` | *(unset — imaging off)* | Orthanc REST base URL (e.g. `http://127.0.0.1:8042`). Set → MWL monitor, imaging router, modality monitor |
| `ORTHANC_USER` / `ORTHANC_PASSWORD` | *(unset)* | Orthanc basic-auth credentials |
| `MWL_POLL_MS` | `60000` | Worklist sync + performed-study poll cadence |
| `MODALITY_POLL_MS` | `30000` | Modality C-ECHO health-probe cadence |
| `ORTHANC_FORWARD_PEER` | *(unset)* | Orthanc peer name to forward performed studies to (PACS/archive) |
| `HUB_GOLDENS_DIR` | `goldens/` | Directory of golden-message conformance files |
| `HUB_VERSION` | *(from package)* | Override the reported hub version |

> Without `HUB_ADMIN_KEY`, the hub **generates a new admin key at every
> boot** and prints it once — the most common first-run stumbling block
> (see [Troubleshooting](/guide/troubleshooting#console-api)).

## CLI flags

The port vars have CLI-flag mirrors:

```bash
npm start -- --http-port 8080 --device-port 5001 --hl7-port 6661 --host 0.0.0.0
```

## Ports & endpoints

| Listener | Default | Purpose |
| --- | --- | --- |
| TCP `:5000` | ASTM | Analyzer device connections (ENQ/ACK framing) |
| TCP `:6661` *(when `HL7_PORT` set)* | MLLP | Inbound HL7 v2 from a LIS/sending application |
| HTTP `:3000` | REST + console | `/api/v1/*` + web console at `/` |
| Orthanc REST `:8042` / DICOM `:4242` | external | The Orthanc container the hub drives over REST |
| PACS/archive REST `:8043` / DICOM `:4243` | external | Second Orthanc used as the forwarding-peer archive in demos |

Compose host-port notes: the dev stack maps Postgres to **5434** (avoids
clashing with other local Postgres on 5432) and the hub's device listener
to **5001** (host 5000 collides with macOS AirPlay). See
[Infrastructure → Docker services](/guide/infrastructure#docker-services).