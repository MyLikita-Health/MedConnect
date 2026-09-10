# Installer skeleton (W2) → real build (W2.5)

**W2.5 resolved: the installer is NSIS** (`packaging/installer/hub.nsi`, built by
`packaging/installer/build.sh` / `npm run installer:build`). Rationale recorded in
`docs/windows-desktop-installer.md` §W2.5: NSIS compiles cross-platform (`makensis`
has an official macOS/Linux build — no Windows host required for CI-style builds),
while MSI/WiX is Windows-only to author and MSIX assumes a certificate/store story
this product does not have yet. Code signing (Authenticode) remains a
distribution-time step (W4/delivery), not a build gate.

## What the installer does

`IntegrationHub-<version>-setup.exe`:

1. Installs the payload to `C:\Program Files\IntegrationHub` (node.exe + workspace
   sources + prod node_modules with the **win32-x64 better-sqlite3 prebuild** — the
   hub runs from source via tsx exactly like the Docker image).
2. Writes the service wrapper to the payload dir: `IntegrationHub.exe` (**WinSW**,
   the service control shim) + `IntegrationHub.yaml` (service definition: node
   command, env contract, `startmode: automatic`, restart-on-failure). WinSW exists
   because a bare `sc.exe binPath=node.exe` service cannot answer the SCM control
   handshake — it dies with error 1053 at start.
3. Registers the Windows service (`integration-hub`) and starts it.
4. Creates the inbound firewall rule for the ASTM device listener port (default
   5000, profile `private` — conservative LAN default, never `public`).
5. Data dir `%ProgramData%\IntegrationHub` (`hub.sqlite`, `state\`, `logs\`) is
   created by the service entry on first boot; the console then runs the W2 setup
   wizard (facility → domains → admin key shown once).
6. Uninstall: stop + delete the service FIRST, remove the payload, then prompt for
   the data dir (export/backup vs delete) — the W2 uninstall contract.

## Build

```bash
npm run installer:build          # stages payload + compiles the NSIS script
# → packaging/installer/build/IntegrationHub-<version>-setup.exe

bash packaging/installer/build.sh --stage --orthanc   # + W3 imaging bundle
npm run installer:build -- --orthanc                  # same, + compile
# → the installer registers a SECOND service (integration-hub-orthanc) and
#   carries ORTHANC_URL in the hub's service env — see below.
```

`build.sh` fetches node.exe, WinSW and the sqlite win32 prebuild into
`build/dl/` (git-ignored) — run it on a machine with network access. It stages
into `build/stage/` and compiles with `makensis` when available (macOS:
`brew install makensis`; Windows: the NSIS distribution; Linux: the `nsis`
package or `makensis` from the NSIS site).

## Service control CLI (W2, dev parity)

`scripts/service-cli.ts install` still generates per-platform service definitions
into `generated/` — now matching the installer's mechanism on Windows (WinSW
files, not raw `sc.exe`):

| Platform | File | Registers via |
| --- | --- | --- |
| Windows | `generated/IntegrationHub.exe` + `generated/IntegrationHub.yaml` | WinSW shim → SCM (`startmode: automatic`, failure restart) |
| macOS | `generated/io.integration-hub.local.plist` | launchd (`KeepAlive` + `RunAtLoad`) |
| Linux | `generated/integration-hub.service` | systemd (`Restart=always`) |

All three run the same entry (`packages/server/src/service-cli.ts`), which drives
`HubSupervisor` with local defaults (SQLite under the data dir, signed-update
state, file logging, first-boot setup surface). Supervision semantics stay in
`HubSupervisor` — the OS keeps exactly ONE process alive.

## W3 imaging bundle (`--orthanc`, optional)

`build.sh --orthanc` stages the **official Orthanc Windows build**
(`Orthanc.exe`, pinned version) + the prebuilt **ModalityWorklists.dll** (the
MWL plugin) from `orthanc.uclouvain.be` beside the hub payload. The installer
then:

- installs `Orthanc.exe` + `OrthancHub.exe` (a second WinSW shim) under
  `<install>\orthanc`, with `orthanc.json` written at install time;
- registers its OWN service `integration-hub-orthanc` (adjacent AGPL process —
  the §3.2 boundary is unchanged: REST-only contact, never embedded/linked);
- keeps REST localhost-only (`RemoteAccessAllowed: false`, auth disabled — the
  hub is the only client) and opens DICOM `4242` for modalities on the
  private-profile firewall (never public);
- puts Orthanc data under `%ProgramData%\IntegrationHub\orthanc` (deleted only
  with the data-dir prompt's explicit consent at uninstall);
- adds `ORTHANC_URL=http://127.0.0.1:8042` to the hub's service env, so the
  MWL + modality monitors wire up on first boot (M3.2/C6) and Orthanc shows in
  the Devices panel like any other device.

## Remaining checklist (W4)

- [x] Orthanc bundling as a separate Windows process (W3 — `--orthanc`; AGPL boundary: out-of-process, REST-only).
- [x] LAN device-connectivity polish (W3 — private-profile firewall rules for the device + DICOM ports; wizard network/imaging settings apply on restart).
- [ ] Authenticode code signing + the distribution story (W4/delivery).
- [ ] Update delivery on top of the signed-update supervisor (W4).
- [ ] First-boot smoke on a real Windows box: install → service starts → console
      setup wizard → admin key minted once → simulated analyzer message lands.
