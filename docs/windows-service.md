# Integration Hub — local service & data layout (W2)

> Companion to `docs/windows-desktop-installer.md` §8.2. This captures the
> hub's own service behavior and on-disk layout — the installer skeleton's
> source of truth. The MSI/MSIX/NSIS packaging decision is deferred (W2.5).

## Process model

```
OS service manager (SCM / launchd / systemd)
  └─ packages/server/src/service-cli.ts     ← the service entry
       └─ HubSupervisor (core/updates)      ← crash restart + health gate + rollback
            └─ packages/server/src/cli.ts   ← the hub (SQLite local mode)
                 └─ startHub() → Fastify API + console, ASTM/HL7 listeners
```

Supervision semantics live in **one** place (`HubSupervisor`): restart on crash,
health-gated boots, and rollback to the last-good release on repeated failures.
The service layer only decides how the OS keeps the supervisor process alive —
it never implements its own restart policy.

## Data directory

`HUB_DATA_DIR` (default `./hub-data`; the installer pins it under the app data
location):

```
<dataDir>/
  hub.sqlite        the W1 embedded store (WAL: hub.sqlite-wal/-shm alongside)
  state/            signed-update state dir (HUB_STATE_DIR): current.json,
                    last-good.json, desired.json, history.jsonl, supervisor.json
  logs/hub.log      service-mode log (console output is mirrored here)
```

Backup = copy the data directory while the service is stopped. Uninstall leaves
the data dir in place; removal is a separate, explicit step with a backup prompt
(the installer skeleton documents this; `scripts/service-cli.ts uninstall`
prints the reminder).

## Service control

Generate + register (per platform) with the control CLI:

```bash
npx tsx scripts/service-cli.ts install --data-dir hub-data --port 3000 --device-port 5000
npx tsx scripts/service-cli.ts status
npx tsx scripts/service-cli.ts uninstall
```

- **Windows** — `install` writes `packaging/generated/IntegrationHub.yaml` (a
  **WinSW** service definition: `startmode: automatic`, restart-on-failure
  delays, baked-in install dir + data dir + env contract) alongside the
  **IntegrationHub.exe** shim (WinSW-x64.exe renamed; pass `--winsw <file>` to
  copy one you already downloaded, or fetch it from
  github.com/winsw/winsw/releases). Run `IntegrationHub.exe install` as
  Administrator, then `IntegrationHub.exe start`.

  Why not plain `sc.exe`: the SCM starts the `binPath=` process and waits for
  it to report status via the service-control protocol — `node.exe` never
  calls `StartServiceCtrlDispatcher`, so the SCM gives up and tears the
  service down (error **1053**). WinSW is the tiny shim that owns that
  protocol; supervision semantics stay in `HubSupervisor` (the OS keeps
  exactly ONE process alive — the shim's child is the supervisor).
  Service stop maps to SIGTERM in the entry, which drains the supervisor
  (final outbox flush + clean SQLite close). The W2.5 installer embeds the
  same mechanism (`packaging/installer/hub.nsi`).
- **macOS** — a launchd plist (`KeepAlive`, `RunAtLoad`) is generated; load it
  with `launchctl load -w`. Dev machines exercise the identical code path.
- **Linux** — a systemd unit (`Restart=always`, `RestartSec=5`).

## Env contract

| Variable | Default | Purpose |
| --- | --- | --- |
| `HUB_DATA_DIR` | `./hub-data` | data dir (SQLite + state + logs) |
| `PORT` | `3000` | console/API port |
| `DEVICE_PORT` | `5000` | ASTM listener |
| `HL7_PORT` | unset | optional HL7 MLLP listener |
| `HUB_LOCAL_SETUP` | auto (on for SQLite) | first-boot setup surface |
| `HUB_ADMIN_KEY` | unset | pin the admin key (else minted at setup completion) |
| `HUB_TLS_CERT` / `HUB_TLS_KEY` | unset | optional TLS on API + device listeners |
| `UPDATE_SOURCE` / `UPDATE_PUBLIC_KEY` | unset | signed releases (W4 pairing) |

## First boot

1. Service starts → SQLite store created at `<dataDir>/hub.sqlite` (W1).
2. Console (`http://127.0.0.1:<PORT>/`) shows the **setup wizard** (facility
   name, org slug, domains) instead of the dashboard (`GET
   /api/v1/setup/status` → `firstBoot: true`).
3. Completing setup mints the **admin API key — shown exactly once** — and
   flips the hub to configured; the dashboard renders after that.
4. LAN note: analyzers connect to `DEVICE_PORT`; the W2.5 installer opens
   that port in the Windows firewall for the local-network profile (never
   public). The setup wizard's stored network host (e.g. `0.0.0.0`) applies on
   the next restart — env still wins.

## W3 imaging (optional `--orthanc` bundle)

- The installer can bundle the official Orthanc Windows build as its OWN
  service (`integration-hub-orthanc`): REST on `127.0.0.1:8042`
  (localhost-only, no auth needed — the hub is the only client), DICOM on
  `4242` (private-profile firewall rule; modalities C-STORE/C-FIND here),
  worklists plugin included for MWL. Data under
  `%ProgramData%\IntegrationHub\orthanc`.
- The hub gets `ORTHANC_URL=http://127.0.0.1:8042` in its service env; the
  MWL monitor + modality health monitor wire up automatically (M3.2/C6), and
  Orthanc appears in the Devices panel like any other device.
- The AGPL boundary (§3.2) is unchanged: Orthanc is an adjacent, separate
  process the hub drives over REST — never embedded or linked.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORTHANC_URL` | unset (or the bundle's `http://127.0.0.1:8042`) | imaging engine REST endpoint |
| `ORTHANC_USER` / `ORTHANC_PASSWORD` | unset | only for remote Orthanc instances with auth |
| `MWL_POLL_MS` | `60000` | MWL sync+poll cadence |
