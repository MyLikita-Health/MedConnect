# Installer skeleton (W2)

Input artifacts for the real installer build (MSI / MSIX / NSIS decision is a
W2.5 pass — the building blocks are settled, see
`docs/windows-desktop-installer.md` §7.1 and `docs/windows-service.md`).

## What's here (generated at control time)

`scripts/service-cli.ts install` writes per-platform service definitions into
`generated/`:

| Platform | File | Registers via |
| --- | --- | --- |
| Windows | `generated/install-service.ps1` | `sc.exe create … start= auto` + failure-recovery restarts (run as Administrator) |
| macOS | `generated/io.integration-hub.local.plist` | launchd (`KeepAlive` + `RunAtLoad`) |
| Linux | `generated/integration-hub.service` | systemd (`Restart=always`) |

All three run the same entry (`packages/server/src/service-cli.ts`), which
drives `HubSupervisor` with local defaults (SQLite under the data dir, signed-
update state, file logging, first-boot setup surface).

## W2.5 packaging checklist (deferred)

- [ ] Pick installer tech (MSI via WiX vs NSIS vs MSIX) + code-signing cert path.
- [ ] Bundle the hub runtime (Node 22 + compiled packages) — no external deps.
- [ ] Data dir under the OS app-data location; `hub.sqlite`, `state/`, `logs/`.
- [ ] Firewall rule for the device listener port (conservative default: LAN only).
- [ ] Uninstall: service unregister → backup prompt → data-dir removal.
- [ ] First-boot smoke: service starts → console reachable → setup wizard →
      admin key minted once → simulated analyzer message lands.
- [ ] Update delivery story on top of the signed-update supervisor (W4).
