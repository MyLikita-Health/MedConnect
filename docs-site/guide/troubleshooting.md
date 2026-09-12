---
title: Troubleshooting
description: Common symptoms, causes and fixes — service, devices, imaging, console, updates.
outline: [2, 3]
---

# Troubleshooting

Quick map: **[Install & service](#install-service) ·
[Devices & results](#devices-results) · [Imaging](#imaging) ·
[Console & API](#console-api) · [Updates](#updates)**

## Install & service

### The service is not running

| Symptom | Cause | Fix |
| --- | --- | --- |
| `sc query integration-hub` shows no service | Service registration failed | Re-run the installer; check for errors during install. The installer fails loudly if service registration fails. |
| Service exists but stops right after start | Service XML or payload problem | Check `%ProgramData%\IntegrationHub\logs\` — the WinSW wrapper log (`integration-hub.*.log`) and `hub.log` |
| "Invalid character in the given encoding" in the WinSW log | Old build: non-ASCII in the service XML | Upgrade to ≥ `v0.1.0-rc.7` (fixed); or re-run the fixed installer |

The **hub child is supervised**: if the node process dies at boot, the
service stays up but the child is swapped/rolled back by the supervisor.
Look at `hub.log` for the boot failure, not just the SCM status.

### The uninstaller hangs or leaves files

| Symptom | Cause | Fix |
| --- | --- | --- |
| Silent uninstall (`/S`) never finishes | Old build: data-dir prompt in silent mode | Use ≥ `v0.1.0-rc.7`. As a rule: **silent uninstall never deletes clinical data** — delete `%ProgramData%\IntegrationHub` manually if you truly want it gone |
| Files remain after uninstall | The shim was locked while NSIS deleted | Fixed in ≥ rc.7 (uninstaller force-kills stray shims first). Re-run the uninstaller |

### Silent install produced no service

With `/S`, the installer's own error dialogs are suppressed. Re-run
**without** `/S` to see the actual failure, or check
`%ProgramData%\IntegrationHub\logs\` after the fact.

## Devices & results

### Analyzer messages never arrive

| Check | How |
| --- | --- |
| Hub is listening | `netstat -ano \| findstr :5000` (Windows) or `lsof -i :5000` — the ASTM listener binds `127.0.0.1` unless `HOST` is set |
| Firewall | The installer adds a private-profile rule; on other shapes open `DEVICE_PORT` manually |
| Device row state | `GET /api/v1/devices` — `connected/disconnected` + `lastSeen`; check the Devices panel |
| Analyzer config | Host = hub IP, port = your `DEVICE_PORT` (5000), protocol ASTM |
| Wire trouble | `npm run simulate -- --corrupt-rate 0.5` exercises NAK + retry locally to prove the hub side |

### Messages arrive but are HELD

That is the **clinical gate working as designed** — the hub never
silently auto-assigns. Inspect the match outcome on the message
(patient/order/strategy), fix the cause (register the expected order via
the ORM feed or `POST /api/v1/orders`, correct the patient id), then
**Release**. Ambiguous matches stay held until unique.

### Messages FAILED with issues

Open the message detail — the timeline lists exact validation issues
(missing patient id, unknown test, implausible value, unauthorized
device). Fix and **replay** the message.

### HL7 results do not arrive

1. Is the HL7 gateway even on? It starts **only when `HL7_PORT` is set** —
   an ASTM-only hub speaks ASTM only.
2. `netstat` for the `HL7_PORT`; LIS sending to the right host/port?
3. Sender identity matters: per-vendor HL7 layouts resolve from the MSH
   sender; an unknown sender falls back to the reference layout. Bind an
   [HL7 profile](/guide/devices#device-profiles-certified-vendor-support).

### Results are parsed but mapped to wrong test codes

Test-code mappings are DB-driven (`GET /api/v1/mappings`). Bind a
certified [device profile](/guide/devices#device-profiles-certified-vendor-support)
for the model — per-device mappings override the global table. Check
`profile.drift` on the message: a profile edited after certification
stamps `drift: true` and fires the `profile-drift` alert.

### Result values look implausible

Plausibility bounds seed from the reference simulator's conventions
(**mg/dL**). A facility on **SI units** must configure its own bounds —
per-site config, not a bug.

## Imaging

### `GET /api/v1/mwl` returns 404

`ORTHANC_URL` is not set — the imaging path is off. Set
`ORTHANC_URL` (+ `ORTHANC_USER`/`ORTHANC_PASSWORD` if auth is enabled) and
restart.

### Worklist sync fails / `orthanc-down` alert

1. `curl http://127.0.0.1:8042/system` — is Orthanc itself up?
2. On the Windows imaging bundle, the `integration-hub-orthanc` service
   should be running; REST is **localhost-only** by design — the hub is
   the only client.
3. Wrong credentials → check `ORTHANC_USER`/`ORTHANC_PASSWORD`.
4. A single flake does not page: the rule fires at **3 consecutive**
   failed polls by default and **resolves automatically** on the first
   success.

### Modality shows offline

Modalities are probed with **C-ECHO** on a standing poll
(`MODALITY_POLL_MS`). Offline means: the modality is down, the network
path is broken, or the DICOM port (4242 on the imaging bundle) is
blocked. The console Devices panel shows each modality's state +
lastSeen.

### Performed study is FAILED / stuck in DLQ

Retry re-queues under **current** route rules
(`POST /api/v1/messages/:id/retry`) — imaging events go through
`hub.imaging`, lab results through the main dispatcher. If the pixels
were supposed to reach the PACS peer, check `ORTHANC_FORWARD_PEER` and
the Orthanc peer config.

## Console & API

### 401 on every API call

Every `/api/v1` route (except `health`) needs
`Authorization: Bearer <key>`. If you lost the admin key from first boot:
create a new admin key from the console with an existing admin key, or
(only if truly locked out) re-image the data directory — clinical data
means you should not lose the key.

### The console shows the setup wizard again

The wizard shows while `firstBoot` is true — it closed after setup
completed. If it reappears, the hub is looking at an empty/different data
directory (new `HUB_SQLITE_FILE`, different `%ProgramData%` profile, or a
fresh volume in Docker). Point it back at the data directory that
completed setup.

### Setup routes return 403

By design: setup routes are public **only while unconfigured** —
fail-closed in the route and the auth hook. They are closed for good
after completion.

### Port already in use

| Port | Usual culprit | Fix |
| --- | --- | --- |
| 3000 | Another web app | Set `PORT` |
| 5000 | **macOS AirPlay** | Set `DEVICE_PORT` (compose maps host 5001 → 5000 for this reason) |
| 5432/5434 | Other local Postgres | Compose uses 5434; set `DATABASE_URL` to match |
| 8042 | Another Orthanc | Stop it or map different host ports in compose |

### After a restart, settings are gone

Stored first-boot settings are applied on every restart (env still wins).
If behavior changed after a restart: check which env vars are set on the
service (WinSW `<env>`) — **env beats stored settings**. On the Windows
service, env changes require a service restart; `integration-hub` reads
its env from the service definition.

## Updates

### "Agent not configured" on the Software updates panel

The hub runs without a state dir — update endpoints report the agent as
not configured. Run under the supervisor with `HUB_STATE_DIR` +
`UPDATE_SOURCE` + `UPDATE_PUBLIC_KEY` (see
[Infrastructure → Remote updates](/guide/infrastructure#remote-updates-signed)).

### Apply failed and rolled back

That is the **health gate + auto-rollback doing its job**. The previous
release stays current; check the update status/history in the console
panel and the supervisor's log for the failed release's boot error before
retrying.

### The manifest signature fails verification

The edge pins `UPDATE_PUBLIC_KEY` — it must be the **public half** of the
private key that signed the manifest (`update-cli release` /
`update-cli sign`). After key rotation, edges must be re-pinned. Note:
releases published **unsigned** (no `UPDATE_SIGNING_KEY` configured) are
**refused by edges that pin a key** — by design (decision D13).