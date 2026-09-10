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

- **Windows** — `install` writes `packaging/generated/install-service.ps1`
  (generated `sc.exe create` with `start= auto` + `failure … actions= restart/…`).
  Run it as Administrator. Service stop maps to SIGTERM in the entry, which
  drains the supervisor (final outbox flush + clean SQLite close).
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
4. LAN note: analyzers connect to `DEVICE_PORT`; open that port in the Windows
   firewall for the local network profile when the installer asks (W3 polish:
   first-boot firewall guidance).
