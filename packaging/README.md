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

## Remaining checklist (W4 → W5, decision D13)

- [x] Orthanc bundling as a separate Windows process (W3 — `--orthanc`; AGPL boundary: out-of-process, REST-only).
- [x] LAN device-connectivity polish (W3 — private-profile firewall rules for the device + DICOM ports; wizard network/imaging settings apply on restart).
- [x] Update delivery on top of the signed-update supervisor (W4 — `!ifdef UPDATES` wires `UPDATE_SOURCE`/`UPDATE_PUBLIC_KEY` into the service env; the supervised agent swaps the hub child with health gate + rollback).
- [x] W5: env-driven signing wrapper (`installer:sign`, SHA-256 + RFC-3161, loud no-op when unsigned) + release workflow (tag → both exes + `SHA256SUMS.txt` + Ed25519-signed update manifest on GitHub Releases) + `update-cli release` manifest generation — **built, without a certificate** (D13).
- [ ] W5: certificate purchase + CI secrets when the first pilot demands it (Azure Artifact Signing preferred, OV token fallback — D13); signing then activates by configuration (`vars.SIGN_COMMAND_TEMPLATE` + the cert secrets; the wrapper enforces the rest).
- [ ] First-boot smoke on a real Windows box: install → service starts → console
      setup wizard → admin key minted once → simulated analyzer message lands —
      extended with the signature story (Digital Signatures tab when signed;
      record the unsigned SmartScreen baseline as the D13 comparison point).

## Release procedure (W5 — `.github/workflows/release.yml`)

1. Once: `npx tsx scripts/update-cli.ts keygen --dir keys` — the Ed25519
   private key stays with release managers (GitHub secret
   `UPDATE_SIGNING_KEY` for CI, local for hotfixes); the public key is the
   `UPDATE_PUBLIC_KEY` every edge pins.
2. Tag `v<version>` (or dispatch the workflow for a hotfix) — CI compiles both
   installer variants, signs them when `vars.SIGN_COMMAND_TEMPLATE` + cert
   secrets exist (via `packaging/installer/sign.sh`), writes
   `SHA256SUMS.txt`, generates + signs the update manifest
   (`update-cli release`), and publishes everything as a GitHub Release.
3. A pilot edge installed with the W4 update build points `UPDATE_SOURCE` at
   the release manifest URL; the agent polls, verifies the Ed25519 signature,
   stages, and swaps the hub child in-place (health gate + rollback).

`SIGN_COMMAND_TEMPLATE` is a printf-style signing command with one `%s` (the
file), e.g. `signtool sign /fd SHA256 /tr https://timestamp.digicert.com
/td SHA256 /a /n "My Company" %s` — it MUST carry the RFC-3161 `/tr` flag
(`sign.sh` refuses the command otherwise).
