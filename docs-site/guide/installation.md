---
title: Installation
description: Install the hub from the Windows installer, Docker, or from source.
outline: [2, 3]
---

# Installation

Three ways to install, by deployment shape:

| You are deploying… | Install with |
| --- | --- |
| A clinic/lab single-box edge | [Windows installer](#windows-desktop-edge) |
| A server / evaluation stack | [Docker](#docker) |
| Developing the hub itself | [From source](#from-source) |

## Windows desktop edge

Download the installer from the
[GitHub Releases](https://github.com/MyLikita-Health/MedConnect/releases)
page: `IntegrationHub-<version>-setup.exe` (base) or
`IntegrationHub-<version>-orthanc-setup.exe` (base + imaging bundle), plus a
`SHA256SUMS.txt` you should verify before running:

```bash
sha256sum -c SHA256SUMS.txt        # or: shasum -a 256 -c SHA256SUMS.txt (macOS)
```

### Silent install (unattended)

```powershell
.\IntegrationHub-0.1.0-rc.7-setup.exe /S
```

The installer:

- stages the Node runtime and payload under `C:\Program Files\IntegrationHub`
- registers the **`integration-hub`** Windows service (WinSW) and starts it
- adds a **private-profile firewall rule** for the device port
- writes data + logs under `%ProgramData%\IntegrationHub`
- with `--orthanc`: additionally registers the `integration-hub-orthanc`
  service (REST localhost-only, DICOM on 4242)

### First-boot checklist (edge)

1. Open `http://<hub-host>:3000/` — the **setup wizard** appears on first
   boot.
2. Complete it: the hub mints the **admin API key** — shown **exactly
   once** — and stores it in the keychain-equivalent local store. Store it
   in your password manager now.
3. Check `Settings` in the console for the device (ASTM) port and the
   network host the hub binds. The hub applies stored settings at every
   boot; env vars still win.
4. Optional: point `UPDATE_SOURCE` + `UPDATE_PUBLIC_KEY` at your release
   manifest (see [Infrastructure → Remote updates](/guide/infrastructure#remote-updates-signed)).

### Uninstall

The uninstaller removes the service and payload but **keeps the data
directory** — silent mode never deletes clinical data unattended. Delete
`%ProgramData%\IntegrationHub` manually if you truly want everything gone.

## Docker

```bash
npm run image:build     # docker build -t medconnect-hub:0.1.0 .
npm run up:stack        # compose: Postgres + hub
curl http://127.0.0.1:3000/api/v1/health   # {"storage":"postgres",...}
```

The compose `hub` serves the console on `:3000` and devices on host port
**5001 → 5000** (host 5000 collides with macOS AirPlay). For imaging, also
bring up Orthanc: `docker compose up -d orthanc` (and `pacs` for the
archive). Service ports are in
[Infrastructure → Docker services](/guide/infrastructure#docker-services).

## From source

Requirements: **Node 22** (`.nvmrc`) and npm. Docker is needed only for the
Postgres dev stack and the imaging demos.

```bash
git clone https://github.com/MyLikita-Health/MedConnect.git
cd MedConnect
npm install           # links workspaces; dev deps only
npm run db:up         # optional: Postgres 16 on :5434 + Redis on :6380
npm run demo          # one-command end-to-end demo (in-memory stores)
```

Then a real run:

```bash
npm start             # http://127.0.0.1:3000 + devices on :5000
# second terminal:
npm run simulate      # sends 3 analyzer messages
```

Without `DATABASE_URL` the hub uses in-memory stores — perfect for a
look, gone on restart.

## Tests and verification

```bash
npm test              # full suite (in-memory + SQLite); DB tests skip without Postgres
npm run test:db       # full suite + PostgreSQL integration (needs db:up)
npm run build         # tsc -b — also the typecheck
```

DB tests use a dedicated `hub_test` database — they never touch the dev
`hub` database.