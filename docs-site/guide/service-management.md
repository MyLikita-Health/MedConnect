# Service management

How the hub runs as an OS service and what it keeps on disk — for operators
who install, back up, upgrade or uninstall the Windows service (and the
identical code path on macOS/Linux dev machines). Installation steps are in
[Installation](/guide/installation); env-var details in
[Configuration](/reference/configuration).

## Process model

```
OS service manager (SCM / launchd / systemd)
  └─ service entry                     ← the service process
       └─ HubSupervisor                ← crash restart + health gate + rollback
            └─ hub (Fastify API + console, ASTM/HL7 listeners)
```

Supervision semantics live in **one** place (`HubSupervisor`): restart on
crash, health-gated boots, and rollback to the last-good release on repeated
failures. The service layer only decides how the OS keeps the supervisor
process alive — it never implements its own restart policy.

## Data directory

`HUB_DATA_DIR` (default `./hub-data`; the installer pins it under the app
data location):

```
<dataDir>/
  hub.sqlite        the embedded store (WAL: hub.sqlite-wal/-shm alongside)
  state/            signed-update state: current.json, last-good.json,
                    desired.json, history.jsonl, supervisor.json
  logs/hub.log      service-mode log (console output is mirrored here)
```

::: warning Backup
Back up by copying the data directory **while the service is stopped**.
Uninstall leaves the data dir in place; removing it is a separate, explicit
step with a backup prompt.
:::

## Controlling the service

Generate + register (per platform) with the control CLI:

```bash
npx tsx scripts/service-cli.ts install --data-dir hub-data --port 3000 --device-port 5000
npx tsx scripts/service-cli.ts status
npx tsx scripts/service-cli.ts uninstall
```

- **Windows** — `install` writes a **WinSW** service definition
  (`IntegrationHub.yaml`: automatic start mode, restart-on-failure delays,
  baked-in install dir + data dir + env contract) alongside the
  **IntegrationHub.exe** shim. Run `IntegrationHub.exe install` as
  Administrator, then `IntegrationHub.exe start`.
  Why a shim: the Windows SCM starts the service process and waits for it to
  report status via the service-control protocol — `node.exe` never does
  that, so the SCM gives up (error **1053**). WinSW is the tiny shim that
  owns that protocol; service stop maps to SIGTERM, which drains the
  supervisor (final outbox flush + clean SQLite close).
- **macOS** — a launchd plist (`KeepAlive`, `RunAtLoad`) is generated; load
  it with `launchctl load -w`.
- **Linux** — a systemd unit (`Restart=always`, `RestartSec=5`).

## First boot

1. Service starts → SQLite store created at `<dataDir>/hub.sqlite`.
2. Console (`http://127.0.0.1:<PORT>/`) shows the **setup wizard** (facility
   name, org slug, domains) instead of the dashboard (`GET
   /api/v1/setup/status` → `firstBoot: true`).
3. Completing setup mints the **admin API key — shown exactly once** — and
   flips the hub to configured; the dashboard renders after that. See
   [Setup](/guide/setup).
4. **LAN note:** analyzers connect to `DEVICE_PORT`; the installer opens that
   port in the Windows firewall for the local-network profile (never
   public). The setup wizard's stored network host (e.g. `0.0.0.0`) applies
   on the next restart — env still wins.

## Orthanc sidecar service (optional `--orthanc` bundle)

The installer can bundle the official Orthanc Windows build as its **own**
Windows service (`integration-hub-orthanc`):

- REST on `127.0.0.1:8042` (localhost-only — the hub is the only client, so
  no auth is needed); DICOM on `4242` (private-profile firewall rule;
  modalities C-STORE/C-FIND here); worklists plugin included for MWL.
- Data under `%ProgramData%\IntegrationHub\orthanc`.
- The hub gets `ORTHANC_URL=http://127.0.0.1:8042` in its service env; the
  MWL monitor + modality health monitor wire up automatically, and Orthanc
  appears in the Devices panel like any other device.

Related env vars: `ORTHANC_URL`, `ORTHANC_USER` / `ORTHANC_PASSWORD` (only
for remote Orthanc instances with auth), `MWL_POLL_MS` (default `60000`) —
all in [Configuration](/reference/configuration). The licensing boundary for
this bundle is described in [Licensing](/reference/licensing).
