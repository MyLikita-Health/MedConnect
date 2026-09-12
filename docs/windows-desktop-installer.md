# Windows Desktop Installer — Local Deployment & Packaging Track

> **Status:** Proposed workstream · to be folded into the main implementation plan
> **Scope:** single-machine Windows deployments where Docker is **not** required at install or run time
> **Relationship to the main plan:** this is the Windows-flavored expression of the edge-gateway architecture already in the repo — §3.2 build/buy, §4.2/§4.3 edge packaging, §5.2 tenancy, §7.G edge resilience, §7.H cloud, and the existing API/security/migrations. It does **not** replace any of that; it selects and packages the parts that make sense for a single-facility Windows box, with a path to cloud later.

---

## 1. Objective

Make Integration Hub deployable on a Windows machine as a **self-contained desktop application**: a single installer that sets up everything internally, runs without Docker, lets the end user do the initial configuration, connects to other devices on the local network or directly attached, and can optionally reach a remote LIS/HIS/EMR over the network — with a later path to cloud sync.

This is the **edge-first, cloud-optional** story the PRD already wants (PRD §10, §42, §43). The desktop installer is the end-user packaging of that story for Windows.

---

## 2. What "local Windows desktop" means here

A local Windows deployment is:

- **One machine**, one hub process, one embedded data store, one console the end user opens in the browser.
- **No Docker required** to install or run. The installer does all setup internally: program files, data directory, services, shortcuts, firewall notes, first-boot config.
- **Runs as a local app/service**, not as a cloud instance. It is a single-tenant edge by default: one facility on one box.
- **Optional network reach**: it can talk to analyzers/modalities on the LAN, and it can talk out to a remote LIS/HIS/EMR. Outbound is fine; inbound from the internet is not required for the local case.
- **Later cloud pairing**: it can start standalone and later be paired to a cloud platform, at which point it becomes a cloud-connected edge with the same outbound-only secure-channel model from §7.G3.

This is **edge mode**, not cloud mode. Cloud mode (multi-tenant, org/facility, RLS, Postgres, BullMQ sync) is a different deployment shape and stays on Postgres.

---

## 3. Resolved decision D2 — local Windows database shape

**D2 — Edge local DB: bundled Postgres container vs SQLite+outbox**

- **Windows local edge → SQLite + durable outbox.** Single-file embedded SQLite, managed by the hub itself, no separate DB service, no port management, no firewall dance for the database. This is the simplest desktop story and the easiest thing to back up, restore, and move for a non-technical end user.
- **Cloud/central → PostgreSQL.** The cloud platform and any multi-tenant central installation keep Postgres, with the org/facility tenancy model from §5.2 and the RLS policies from H1.
- **Why this split works with the existing code:** the hub already abstracts storage behind `StoreBackend` / `DeviceBackend` (`packages/api/src/backend.ts`), and the PG stores are in `packages/api/src/pg/*.ts`. The gap to close is a **SQLite edge backend** behind the same contracts, plus a **durable outbox** that is the basis for both local crash recovery and future cloud sync.
- **In-memory stays as the test/dev fallback** exactly as it is today — that's already the scaffold default and it's fine for demos and tests.
- **Other D decisions unchanged:** D1 (ORM/migrations), D3 (first certified vendors), D4 (edge hardware baseline), D5 (tenancy escalation), D6 (cloud hosting), D7 (HL7 parser — resolved), D8 (licensing/commercial model), D9 (marketplace timing), D10 (Orthanc bundled-by-default + customer-provided). Nothing here overrides those.

**Implication for the desktop installer:** the installer's "local data" story is a single SQLite file under the app data directory, not a separate Postgres install. If the user later pairs to cloud, the cloud side is Postgres and the sync worker ships outbox rows; the local SQLite remains the edge store.

---

## 4. What the installer must do internally

The installer is the one-time bootstrap. After it, the hub runs as a local Windows app/service and the user configures it through a first-boot UI.

### 4.1 Program installation

- Install hub runtime + console + simulator/tooling into `Program Files` (or the chosen install dir).
- Install a **Windows service** (or a supervised local process) so the hub starts on boot and restarts on crash. This is the Windows expression of the existing supervisor/edge-watchdog story in §7.G2.
- Create the data directory under the user/system app data location: `data/` with the SQLite DB file, config, logs, and any Orthanc data if imaging is enabled.
- Create Start Menu / desktop shortcuts for the console and for any admin tooling.
- Register/uninstall cleanly; support repair and uninstall removing the service + data (with a data-backup prompt on uninstall).

### 4.2 Embedded SQLite + first-boot data

- On first boot with no existing data, seed the **default local config**: reference device profile, default mappings, default alert rules — the same seed story the PG path already has, just into SQLite.
- No Docker, no DB server install, no port prompting for the database. The SQLite file **is** the store.

### 4.3 Device/network setup for the local LAN

- Ask for or discover the host's LAN address so analyzers/modalities on the network can reach the hub's ASTM/HL7 listeners.
- Include firewall guidance in the installer + first-boot flow: open the device listener port(s) on the local network profile as needed. The default should be sensible and conservative.
- Remember the existing device listeners already run on configurable TCP ports with TLS optionally enabled (the hub already supports `HUB_TLS_CERT`/`HUB_TLS_KEY` for the API and device endpoints). For a local Windows box, TLS on device endpoints is optional and can be deferred; the installer can generate a local self-signed material if the user wants it.

### 4.4 Imaging (optional at install)

- Imaging is **optional at install time**, off by default. If the user wants it, the installer bundles/hooks Orthanc as a **separate Windows service/process**, because the AGPL boundary policy (§7.5.5) already says Orthanc stays out-of-process and integrated over REST only.
- If Orthanc is enabled, the installer provisions it locally (its own data dir + ports), wires `ORTHANC_URL` into the hub, and the hub's existing DICOM adapter + MWL monitor + modality health story works the same as in the Docker compose case — just as local processes.
- If the user already runs Orthanc elsewhere, they can enter an existing `ORTHANC_URL` instead — same boundary, same REST-only integration.

### 4.5 First-boot configuration UI (end user does this)

After install and first start, the user opens the console and completes first-boot setup:

1. **Facility name** (and optional org slug if they anticipate cloud pairing later).
2. **Which domains to enable**: Lab only / Imaging only / Both. This is the install-time choice the user asked for; it changes what listeners/features are active.
3. **Device/network basics**: host network address, device listener port(s), TLS on/off.
4. **Local destinations**: where results go locally or over the network (HTTP webhook, HL7 MLLP to a remote LIS/HIS/EMR, console, etc.).
5. **Admin API key**: generated and shown once, the same "shown exactly once" pattern the API already uses.
6. **Cloud pairing (later)**: if they anticipate cloud sync, the installer/first-boot can optionally create the pairing artifact now (a pairing code/cert) that the H3 provisioning flow consumes later.

This is the end-user configuration surface for local Windows. It reuses the existing API + stores + profiles; the new work is the installer + first-boot flow + the SQLite backend + the Windows service wrapper.

---

## 5. What it must do at run time

- Start on boot, survive crashes, restart with backoff — the supervisor/edge-watchdog behavior from §7.G2, Windows-flavored.
- Accept analyzer/modal connections on the LAN and process them through the same pipeline: parse → canonicalize → match → validate → HELD/route → retry/DLQ.
- Route results to configured destinations, including remote LIS/HIS/EMR over HL7 MLLP or HTTP/FHIR, with retry and DLQ.
- Expose the same API + console the user already has, now as the local desktop console.
- Support TLS on API + device endpoints if the user wants it; if not, run plain on the local network.
- Keep an outbox so that if cloud pairing happens later, the edge already has the durable local queue to sync from.

---

## 6. Offline + network reach concerns

### 6.1 Offline operation

The local Windows box must keep working when it can't reach anything else — analyzers on the LAN still work, local routing still works, the console still works. This is the edge-autonomy requirement from PRD §43 and §7.G1. SQLite + in-process dispatch already give that; the remaining work is just making sure no cloud/remote dependency is required at run time.

### 6.2 Reaching a remote LIS/HIS/EMR

Since the user said there's a possibility of reaching a remote LIS/HIS/EMR over the network, the local install must support **outbound** connections to those systems: HL7 MLLP destinations, HTTP/FHIR destinations, with retry, DLQ, and the appointment of sending-facility fields. This already exists in the codebase; the desktop story just ensures it works in a pure-local install with no Docker/Postgres dependency.

### 6.3 Later cloud sync

When the user later pairs to a cloud platform, the local box becomes a cloud-connected edge:

- The outbox (durable local queue) is what syncs to the cloud; the cloud side is Postgres.
- Pairing uses the H3 remote-provisioning flow: pairing code/cert → link facility to cloud org → secure outbound channel from §7.G3.
- The local SQLite remains the edge store; sync is outbound-only from the edge, matching §4.2/§7.G and PRD §42.

---

## 7. Packaging + updates

### 7.1 Installer shape

- A Windows installer (MSI / MSIX / NSIS / WiX, to be picked during implementation) that bundles the hub, the console, the SQLite runtime/connector, optional Orthanc, and first-boot config.
- The goal: **download, run, next/next/finish, open console, configure, go**, with no Docker and no separate DB install.

### 7.2 Signed updates

The signed-update path already exists (plan G3 / §7.G3, supervisor rollback). For Windows local, the same semantics apply: the hub checks for a signed release, stages it, and the supervisor swaps it with a health gate and rollback on failure. The packaging detail is how the release artifact is delivered locally (downloaded release package, local file, or cloud-provided) — that's an implementation detail to settle during packaging, not a new architecture.

---

## 8. Scope split across tracks

To avoid blocking the current M4 cloud work, the Windows desktop track should be phased as its own thing:

### 8.1 Phase W1 — decide + validate the local baseline (this is where to start)

- Record D2 as resolved for Windows local: SQLite + durable outbox; Postgres stays for cloud.
- Add a SQLite edge backend behind `StoreBackend`/`DeviceBackend` (at least the store + device registry surfaces the hub actually uses locally), with the durable outbox that doubles as local crash recovery and future sync basis.
- Prove a fully-local, no-Docker run on Windows (or cross-platform where the same code path is used): SQLite store, listeners, routing, HELD, console, admin key, first-boot config.
- Define "local mode" vs "cloud mode" vs "hybrid later" clearly in the plan.

#### W1 implementation plan (recorded 2026-09-10, before coding)

This is the concrete W1 build plan the implementation follows. It is recorded here so the
code review and the plan-log (§13) can be checked against an intent, not reconstructed after.

**Library: `better-sqlite3`** (dependency already added at W1 kickoff). It is synchronous,
which is a feature here: an embedded single-writer store wants simple serialized access, and
sync methods satisfy the `StoreBackend`/`DeviceBackend` contracts (`void | Promise<void>` —
the API layer awaits everything either way). Prepared statements are reused; the DB handle is
opened once per hub process.

**Where the code lives: `packages/api/src/sqlite/`** — mirroring `packages/api/src/pg/` — with
one deliberate asymmetry: core keeps several *Postgres* store impls (`PostgresRouteStore`,
`PostgresDedupStore`, …) because they predate the split, but all *SQLite* impls are
centralized in the api package so `@integration-hub/core` stays dependency-light domain logic
(a native module like better-sqlite3 must not leak into it). SQLite impls:

| Seam (contract) | SQLite class | File |
| --- | --- | --- |
| `StoreBackend` + `MessageSink` + mappings | `SqliteMessageStore` | `sqlite-store.ts` |
| `DeviceBackend` | `SqliteDeviceRegistry` | `sqlite-devices.ts` |
| `RouteStore` | `SqliteRouteStore` | `sqlite-core-stores.ts` |
| `DedupStore` | `SqliteDedupStore` | `sqlite-core-stores.ts` |
| `OrderRegistry` + `AdmissionRegistry` | `SqliteOrderRegistry` / `SqliteAdmissionRegistry` | `sqlite-core-stores.ts` |
| `AlertStore` | `SqliteAlertStore` | `sqlite-core-stores.ts` |
| `ProfileStore` | `SqliteProfileStore` | `sqlite-core-stores.ts` |
| `WebhookSubscriptionStore` | `SqliteWebhookStore` | `sqlite-core-stores.ts` |
| `OutboxReader` + `OutboxWriter` (D11) | `SqliteOutbox` | `sqlite-outbox.ts` |
| `KeyStore` + `AuditStore` (M2) | `SqliteKeyStore` / `SqliteAuditStore` | `sqlite-security.ts` |
| schema + migrations | `openSqliteDatabase` / `runSqliteMigrations` | `schema.ts` |

**Schema:** SQLite-dialect DDL in `schema.ts` (the PG migration files are not valid SQLite —
`jsonb`, `now()`, `timestamptz`), tracked in a `schema_migrations` table with the same
apply-in-order / record-version runner pattern as the PG runner. Table and column names mirror
the PG schema (0001–0015) so the mental model is identical: `messages`, `message_attempts`,
`devices`, `orders`, `admissions`, `route_destinations`, `route_rules`, `dedup_keys`,
`alert_rules`, `alerts`, `profiles`, `api_keys`, `audit_log`, `webhook_subscriptions`,
`outbox`, `config` (JSON columns are TEXT holding JSON). `org_id`/`facility_id` columns exist
from day one (null on a single-tenant edge) so the W4 cloud-pairing write-through is a
data change, not a schema change.

**Durability pragmas:** `journal_mode = WAL` (crash-safe, readers don't block the writer),
`synchronous = FULL` (an acknowledged write survives power loss — the edge-resilience §7.G2
bar; NORMAL is the tempting-but-wrong default for clinical results), `foreign_keys = ON`,
`busy_timeout` set. One file under the state dir (`hub.sqlite`), created on first boot.

**D11 outbox on SQLite:** same shape as `PostgresOutbox` — AUTOINCREMENT `seq`, `acked`
flag, `listUnacked`/`markAcked`/`maxSeq`/`pendingCount`. `append` ignores the transaction
`client` handle (allowed by the `OutboxWriter` contract): because better-sqlite3 is
synchronous, the store methods wrap each write + outbox append in one
`db.transaction(...)` — the no-dual-write invariant holds by construction. `OutboxSyncer`
(core) drives it unchanged: the edge sync story is the same code path for PG and SQLite
edges.

**startHub wiring:** a third backend mode alongside PG and memory —
`opts.sqlite?: { file?: string }`, env fallback `DB=sqlite` (+ `HUB_SQLITE_FILE`).
Precedence: explicit `opts.sqlite` > `DB=sqlite` > `DATABASE_URL` (PG) > in-memory.
`Hub.db` reports `{ kind: 'postgres' | 'sqlite' }`. Profile/mapping/alert seeding and the
admin-key bootstrap run identically on all three backends (the seed paths already go through
the store seams). Auth, routing, dedup, matching, HELD, retry/DLQ, webhooks, console —
nothing else changes; that is the point of the seams.

**W1 exit proof (tests, all Docker-free so they run in CI everywhere):**

1. Store-contract parity suite (`packages/api/src/sqlite/sqlite.test.ts`): every seam above —
   lifecycle mark/attempts/DLQ, dedup expiry, matching, alerts fire/resolve, profile CRUD with
   read-back validation, key create/findBySecret/rotate, audit, webhook write-through, outbox
   append→ship-shaped read→ack, and **persistence across reopen** (close the handle, reopen,
   data intact, migrations not re-applied).
2. No-Docker e2e (`packages/server/src/sqlite-hub.test.ts`): `startHub` on a temp SQLite file,
   analyzer simulated end-to-end (parse → canonicalize → match → route → deliver), API auth
   with the generated admin key, webhook fire → stop → restart on the same file → state
   survived. That is the §8.1 "fully-local, no-Docker run" gate.

**Explicitly deferred (later W phases):** Windows service wrapper + installer (W2), Orthanc
bundling (W3), pairing artifact + update delivery (W4). W1 delivers the storage seam + the
local-run proof only.

#### W2.5 implementation plan (recorded 2026-09-10, before coding)

**Scope (§7.1 + the packaging/README checklist):** turn the W2 skeleton into a real
Windows installer build: pick the installer technology, bundle the runtime payload, and
wire the firewall rule — without touching the supervision semantics (they stay
`HubSupervisor`'s) or the first-boot setup flow (W2, already shipped).

**1. Installer technology: NSIS (resolved).**

- **Why not MSI/WiX:** authoring a trustworthy MSI needs the WiX toolset, which only runs
  on Windows — every build would require a Windows host. NSIS compiles cross-platform
  (`makensis` has an official macOS/Linux build), which matches the repo's dev-parity
  story (the W2 service CLI already emits launchd/systemd definitions from the same code
  path).
- **Why not MSIX:** MSIX identity/signing assumes a store or enterprise certificate
  distribution story this product does not have yet; a classic installer plus the existing
  signed-update machinery (G3) is the deploy path facilities actually use.
- **Consequence:** the installer is a single `IntegrationHub-<version>-setup.exe` that
  installs to `C:\Program Files\IntegrationHub`, writes the payload under
  `%ProgramData%\IntegrationHub`, registers the service, adds the firewall rule, and
  offers a data-backup prompt on uninstall.
- Code signing (Authenticode) stays a distribution-time step (W4/delivery), not a build
  gate here — `makensis` can pass a signing command when a cert exists.

**2. Runtime bundling (the payload).** The hub runs from source via tsx (the same way the
Docker image runs it), so the payload is: `node.exe` (Node 22, matching `.nvmrc` and
`better-sqlite3@13`), the npm workspace sources, a production `npm ci` **with tsx
retained** (it is the runtime loader, not just a dev tool), and the **win32-x64
better-sqlite3 prebuild** — a staging run on macOS would otherwise fetch the Darwin
binary. The service entry (`service-cli.ts`) runs unchanged on top of that payload.

**3. Service registration: WinSW, not bare `sc.exe`.** A `binPath=` pointing directly at
`node.exe` cannot serve the Windows SCM control protocol — the SCM starts it, waits for
`StartServiceCtrlDispatcher`, gets nothing, and kills the service (error 1053). W2.5
replaces the W2 `sc.exe create` template with the **WinSW** wrapper: `IntegrationHub.exe`
(WinSW-x64.exe renamed) + `IntegrationHub.yaml` (the service definition: the node command,
env contract, `startmode automatic`, failure `restart`), exactly the service-control
reponsibility split of W2 (the OS keeps ONE process alive; supervision semantics stay in
`HubSupervisor`). The `hub-service install` template and `docs/windows-service.md` are
updated to the same mechanism so dev-generated definitions match the installer.

**4. Firewall rule.** The installer creates an inbound rule for the ASTM device listener
port (default 5000, profile `private` — conservative LAN default; domain/private only,
no public) with `netsh advfirewall firewall add rule`. Scope per the installer README:
conservative default, and the user can tighten it further in Windows Firewall.

**5. Build pipeline (`packaging/installer/`).** `build.sh` stages `build/stage/` (payload
+ WinSW + node.exe) from a checkout (run it on a machine with network; it fetches node +
WinSW + the sqlite prebuild into `build/dl/`, git-ignored), then `makensis hub.nsi`
produces `build/IntegrationHub-<version>-setup.exe`. Uninstall behavior: service stop +
unregister, payload removal, and a data-backup prompt (export `%ProgramData%\IntegrationHub`
or delete it) — the W2 uninstall contract, now in the installer.

**W2.5 exit proof (Docker-free, machine-local):**

1. `npm run installer:build` compiles the NSIS script (when `makensis` is available; the
   staging half runs anywhere) and emits `IntegrationHub-<version>-setup.exe`.
2. `packaging/installer/installer.test.ts` pins the build inputs: hub.nsi references the
   real payload dirs, the service YAML/WinSW block matches the service-cli contract, the
   firewall rule targets the device listener port with a conservative profile, and the
   uninstall sequence stops the service BEFORE touching the data dir.

**Explicitly deferred:** Authenticode signing (distribution-time), Orthanc bundling (W3),
pairing artifact + update delivery (W4).

#### W2 implementation plan (recorded 2026-09-10, before coding)

**Scope (§8.2):** the OS service wrapper, the installer skeleton, and the first-boot config
flow. What already exists and is reused unchanged: the supervisor story (G2/G3) —
`HubSupervisor` (`packages/core/src/updates/supervisor.ts`) already spawns the hub, restarts
on crash, health-gates boots and rolls back — and the signed-update agent + state dir
(`HUB_STATE_DIR`). W2 packages that as a Windows service and adds the end-user setup flow.

**1. Service wrapper (`packages/server/src/service-cli.ts`) — cross-platform code,
Windows-flavored packaging.**

The service entry is a small headless launcher that runs the supervisor directly with
local-mode defaults: SQLite store under the data dir, `HUB_STATE_DIR` under the data dir,
service-mode logging to a file under the data dir (console logging is unreliable under a
service context), and first-boot detection. Signals (SIGINT/SIGTERM — the Windows service
host maps service-stop onto them) trigger `supervisor.stop()`.

A companion **service control CLI** (`scripts/service-cli.ts`, commands `install` /
`uninstall` / `status`) emits the platform service definition from a template + install
params (install dir, data dir, ports):
- **Windows:** generates `install-service.ps1`, which registers the hub under the Service
  Control Manager (sc.exe wrapper) with auto-start + restart-on-crash; the generated script
  bakes in the install dir + data dir + env contract.
- **macOS/Linux (dev + on-prem parity):** a launchd plist / systemd unit template using the
  same env contract, so the wrapper is exercised on every dev machine, not only Windows.

Templates live under `packaging/` (installer skeleton input). Supervision semantics stay
`HubSupervisor`'s — the service layer only decides **how the supervisor process is launched
and kept alive by the OS**, not how crashes are handled (duplicating restart policy would
risk divergent behavior).

**2. First-boot config (the end-user setup flow, §4.5).**

A local-mode hub boots **unconfigured** on first run and serves a setup flow that records
facility identity, enables the API key (minted at completion, shown once), and records the
chosen domains/network basics.

- **State:** a `local_settings` table in the SQLite store (`SqliteLocalSettingsStore`,
  key/value JSON rows) written through the store seam — same durability as everything
  else, no parallel file format. Keys: `facility` (name, optional org slug), `domains`
  (lab/imaging), `network` (host, device/hl7/http ports, TLS on/off), `firstBootComplete`
  (bool + completedAt).
- **API (`packages/api/src/setup.ts`, mounted by ApiServer when a `setup` option is wired):**
  - `GET /api/v1/setup/status` — public (added to PUBLIC_ROUTES): returns
    `{ firstBoot, configuredAt?, facility?, domains? }` — enough for the console to pick a
    screen, no secrets.
  - `POST /api/v1/setup/complete` — public ONLY while unconfigured. Validates (facility
    name required; domain flags; network basics; optional pinned admin key), writes
    settings + flips `firstBootComplete` in one transaction, and (when no key exists)
    creates the admin API key **returned exactly once** — the H3 pairing-bundle pattern.
    After completion the route 403s; a second concurrent POST sees the flag already true
    and 403s (the flip is the same transaction as the write).
  - Auth'd edits: `GET/PATCH /api/v1/setup/settings` under `config:write` (admin;
    local mode has exactly one privileged role by default).
- **Console (`ui.ts`):** on load the console calls setup status; when `firstBoot`, it
  renders the setup wizard panel (facility → domains → network → done, admin key shown
  once at the end) instead of the dashboard.
- **startHub wiring:** `opts.localSetup?: { enabled?: boolean }` (env `HUB_LOCAL_SETUP=1`;
  auto-on when the backend is SQLite unless explicitly disabled). When enabled and
  unconfigured, startHub skips the auto-generated admin key print (setup completion is the
  key-minting moment) but keeps auth ON for every other route.

**3. Installer skeleton (`packaging/`).**

Artifacts a W2.5 packaging pass turns into the real installer (MSI/MSIX/NSIS pick deferred):
the service-definition templates per platform, the env contract (ports, data dir, TLS,
update source), a first-boot smoke checklist, and the uninstall note (service unregister +
data-dir removal with backup prompt). `docs/windows-service.md` captures the hub's own
install/uninstall behavior and the data-dir layout (`hub.sqlite`, state dir, logs).

**W2 exit proof (tests, Docker-free):**

1. **First-boot flow** (`packages/api/src/setup.test.ts`): status starts `firstBoot: true`;
   anonymous completion mints the admin key (shown once) and flips status; re-completion
   403s; settings land in `local_settings` and survive reopen; every other route enforces
   auth throughout; the settings PATCH requires an admin key.
2. **Service entry** (`packages/server/src/service-cli.test.ts`): the local-service entry
   boots with local defaults (SQLite + state dir under the data dir), logs to a file, and
   stops cleanly on SIGTERM.
3. **No-Docker e2e** (extends `sqlite-hub.test.ts`): boot unconfigured → complete setup via
   the API → restart → still configured (persisted in SQLite).

**Explicitly deferred:** the real MSI/MSIX build + code signing (W2.5), Orthanc bundling
(W3), cloud pairing artifact (W4).

### 8.2 Phase W2 — Windows service + packaging skeleton

- Wrap the hub as a Windows service / supervised process: auto-start, crash recovery, safe shutdown, logs, uninstall.
- Build the installer skeleton: install dir, data dir, service registration, shortcuts, firewall notes, uninstall.
- First-boot config UI: facility name, domain choice, device/network basics, admin key, optional cloud pairing artifact.

### 8.3 Phase W3 — imaging + network reach polish

- Bundle/hook Orthanc locally when imaging is enabled; keep the AGPL boundary (out-of-process, REST-only).
- Harden LAN device connectivity: listen ports, TLS option, firewall guidance, analyzer/modal binding.
- Ensure outbound LIS/HIS/EMR reach works cleanly in local mode with retry/DLQ.

#### W3 resolution (implemented)

- **Orthanc bundling (`--orthanc`)**: `build.sh` stages the official Windows
  build (`Orthanc.exe` + prebuilt `ModalityWorklists.dll` for MWL) beside the
  hub payload; `hub.nsi` (`!ifdef ORTHANC`) registers it as its OWN Windows
  service (`integration-hub-orthanc` via WinSW), with its own config and data
  dirs under `%ProgramData%\IntegrationHub\orthanc`, REST bound localhost-only
  (`RemoteAccessAllowed=false`; the hub is the only client), DICOM 4242 on the
  private-profile firewall. The hub's service definition carries
  `ORTHANC_URL=http://127.0.0.1:8042`. The AGPL boundary is unchanged: adjacent
  process, REST-only (§3.2) — no DICOM stack in hub code.
- **First-boot network/imaging apply**: the setup wizard collects the Orthanc
  REST URL (and network host) at completion; a local hub re-applies stored
  settings on every restart (env still wins). The status route echoes the
  stored network/orthanc config plus the listeners this process actually bound
  (`runtime`), so the operator can verify LAN reach from the console.
- **LAN/firewall**: the installer's private-profile device-port rule (W2.5)
  carries to the DICOM port when imaging is bundled; TLS stays the existing
  `HUB_TLS_CERT/KEY` contract; outbound LIS/HIS/EMR reach keeps the dispatcher
  retry→DLQ machinery (B3.3) — no local-mode special casing needed.
- **Exit proof**: the extended SQLite e2e (`sqlite-hub.test.ts`) completes
  setup with imaging on, restarts, and proves the MWL monitor boots against
  the stored Orthanc URL (mock REST contract), the Orthanc device row flips
  connected, and the stored LAN host becomes the bind host.

### 8.4 Phase W4 — cloud-pairing readiness + update delivery

- Make the local install cloud-pairing-ready: outbox + tenant context + pairing artifact, so later pairing to a cloud org/facility is a controlled flow rather than a re-install.
- Settle Windows update delivery mechanics on top of the existing signed-update supervisor story.

#### W4 plan (recorded before coding)

1. **Pairing artifact (edge side)** — `packages/api/src/pairing.ts`: the H3
   claim flow driven FROM the edge console. Settings keys in the same
   `local_settings` store: `pairing` (state, gateway/facility/org identity,
   claimedAt) + `cloud.*` (baseUrl, gatewayId, gatewayKey — the gateway key
   is a credential at rest in the SQLite file, same trust domain as the
   already-at-rest admin key hash + data). Routes: `GET
   /api/v1/pairing/status` (public, no secrets), `POST /api/v1/pairing/claim`
   (public ONLY while unpaired — the W2 setup-completion pattern, fail-closed
   in the route AND the auth hook), `POST /api/v1/pairing/unpair`
   (config:write). The claim proxies to `<cloudBaseUrl>/api/v1/provision/claim`
   with the operator's pairing code, persists the returned bundle, and NEVER
   echoes the gateway API key back over the API (it is for the syncer, not
   the operator).
2. **Syncer on SQLite** — the D11 syncer currently gates on `pool` (PG only);
   the W1 outbox on a paired edge would grow forever. W4: when paired, the
   SQLite stores get the outbox + tenancy stamps (the W1-prepared seams) and
   `OutboxSyncer` runs against the stored cloud config. Precedence stays
   opts > env > stored pairing (the W3 pattern). Sync starts at pairing time
   — historical messages were never outboxed (no outbox attached before
   pairing) and stay local by design.
3. **Update delivery on Windows** — the service process IS the supervisor
   (W2 service-cli), so a staged signed release swaps the hub child in-place
   with health-gate + auto-rollback, without touching the SCM. W4 wires the
   installer: `UPDATE_SOURCE` + `UPDATE_PUBLIC_KEY` land in the service env
   (`!ifdef`), the agent becomes enabled on install, and docs record the
   keygen/sign/verify loop (`scripts/update-cli.ts`). Artifact download
   remains the existing manifest/env-level release mechanism (unchanged
   scope); Authenticode stays distribution-time.
4. **Exit proofs** — (a) pairing API tests: state machine + error mapping
   (401/409/410 from the cloud) + one-shot claim (re-claim 403/409) + no
   secret in any response; (b) SQLite e2e: claim against a mock cloud →
   restart → syncer ships outbox rows to the mock ingest → acks drain the
   backlog; unpair requires admin and survives restart; (c) installer
   invariants for the update env lines.

#### W4 resolution (implemented)

- **Pairing flow (`packages/api/src/pairing.ts`)**: `GET
  /api/v1/pairing/status` (public; identity + sync endpoint, never the key),
  `POST /api/v1/pairing/claim` (public ONLY while unpaired — the W2
  setup-completion pattern; the route checks fail-closed AND the auth hook
  bypasses only while unpaired, so once paired every caller 403s at the
  scope gate and re-pairing is unpair→claim), `POST /api/v1/pairing/unpair`
  (config:write). The claim proxies the operator's pairing code to
  `<cloudBaseUrl>/api/v1/provision/claim` (H3), maps cloud errors
  (410 expired / 401 invalid / 409 consumed / 501→502 / timeout→504),
  validates the returned bundle, and persists `pairing` + `cloud` settings
  (the gateway key at rest in the SQLite file; never echoed back).
- **Syncer on the paired edge**: `startHub` applies the stored bundle at
  boot (opts > env > stored, the W3 precedence), attaches the W1 SQLite
  outbox + H1 tenancy stamps, and runs `OutboxSyncer` against
  `SqliteOutbox` — the same syncer the PG edge uses, one code path. The
  outbox attaches at boot, so pairing at runtime takes effect on the next
  restart (the service model: pair once, the service picks it up). Acked
  rows drain; the outbox is never an endless backlog.
- **Update delivery**: the installer takes `!ifdef UPDATES` (+
  `UPDATE_SOURCE` / `UPDATE_PUBLIC_KEY` defines) and writes both into the
  hub service env; `startHub` reads the same env names, and the agent runs
  inside the supervised service — a staged signed release swaps the hub
  child in-place with health-gate + auto-rollback, never touching the SCM
  registration. Keygen/sign/verify stays `scripts/update-cli.ts`;
  Authenticode stays distribution-time.
- **Exit proofs**: (a) `pairing.test.ts` — full claim surface against a
  mock cloud (bundle persisted at rest, no secret in any response,
  fail-closed re-claim, RBAC'd unpair, restart persistence via store
  close/reopen); (b) the extended `sqlite-hub.test.ts` — pair → restart →
  the syncer boots from stored settings (no env), ships the device
  write-through with `x-hub-gateway` + the claimed key and the paired
  org/facility stamps, and acks drain the backlog; (c) `installer.test.ts`
  pins the `UPDATES` env lines on both   sides (NSIS writer + `startHub` reader).

### 8.5 Phase W5 — signed distribution + update delivery (the W4/delivery remainder)

- The last unchecked items of the W4 checklist: Authenticode signing and the
  distribution story. Decisions are recorded as **D13** (plan §12): the
  pipeline is built now with a **pluggable signing step** — no certificate
  purchase required to build — and the certificate itself is bought when the
  first pilot demands it. Expected route: **Azure Artifact Signing** (keys in
  Microsoft's cloud HSM, signing from CI with Entra credentials, no token or
  HSM hardware to manage; Basic tier $9.99/mo) with a CA-issued **OV** token
  cert as the fallback (EV's historical SmartScreen advantage no longer
  justifies its same token burden). Distribution = **GitHub Releases**;
  signing runs in **CI** (windows runner) with a local-script parity path for
  hotfix builds.

#### W5 implementation plan (recorded 2026-09-11, before coding)

**1. Signing seam (`packaging/installer/sign.sh`, `npm run installer:sign`) —
env-driven, no-op when unset.**

- After `makensis`, `build.sh` invokes the signing wrapper for BOTH artifacts
  (base + `--orthanc` variant). The wrapper reads its command from the
  environment — a `SIGN_COMMAND` template (a `signtool sign /fd SHA256 /tr
  <RFC-3161 TSA> /td SHA256 …` invocation for a CA cert, or the Azure Artifact
  Signing plugin invocation for the cloud route) — so adding a certificate
  later is configuration, not code.
- **RFC-3161 timestamping is mandatory** in any configured command: signatures
  must remain valid after the certificate expires, or every deployed edge
  breaks on cert rotation day.
- Without signing env, the wrapper prints a loud warning and skips (exit 0):
  unsigned CI builds and dev runs stay green; the release notes state the
  unsigned status.
- A verify pass follows whenever signing ran (`signtool verify /pa` or
  `osslsigncode verify`): a requested-but-failed signature fails the build.

**2. Release pipeline (`.github/workflows/release.yml`) — a tag produces
signed exes + checksums + a signed manifest.**

- Trigger: tag `v*` (+ manual dispatch for hotfixes). Jobs:
  1. **compile** (ubuntu — the W2.5 docker-makensis recipe): both installer
     variants, uploaded as job artifacts.
  2. **sign+publish** (windows-latest — signtool ships with the Windows SDK):
     download the artifacts, run the same env-driven signing wrapper (secrets
     supply the future cert credentials; absent secrets → documented unsigned
     publish), `sha256sum` → `SHA256SUMS.txt`, generate the update manifest
     (below), then create the **GitHub Release** with: base exe, orthanc exe,
     `SHA256SUMS.txt`, `manifest.signed.json`.
- The existing push/PR CI is untouched — signing/publishing happens only on
  release tags.

**3. Update-manifest generation (`scripts/update-cli.ts release`) — close the
G3 loop onto real assets.**

- A `release` subcommand builds the manifest the update agent already consumes
  (the update-cli manifest schema: `schemaVersion`, `release{ id, version,
  platform, minHubVersion, payload.env }`, `artifact`) from release inputs
  (`--version`, `--url` of the exe asset, `--sha256`, `--min-hub-version`),
  then signs it through the existing Ed25519 `sign` path — one
  keygen/sign/verify loop, now pointed at real release assets instead of a
  hand-written fixture.
- An edge installed with the W4 `!ifdef UPDATES` build points `UPDATE_SOURCE`
  at the release manifest URL; `UPDATE_PUBLIC_KEY` pins the Ed25519 key. No
  new agent architecture — the M2 signed-update machinery (health gate,
  rollback, in-place swap by the supervised service) is unchanged; W5 only
  automates manifest production.
- Release procedure (documented in `packaging/README.md`): keygen once → the
  Ed25519 private key lives with release managers (GitHub secret for CI,
  local for hotfixes) → tag → the workflow publishes everything.

**4. Exit proofs (Docker-free).**

1. `packaging/installer/release.test.ts` pins the invariants in the
   installer-test style: the workflow exists with the tag trigger, both
   variants, checksums and the manifest step; the sign wrapper uses SHA-256 +
   an RFC-3161 timestamp and no-ops loudly without env; a `release`-generated
   manifest round-trips `verifyManifestSignature` (the existing core path).
2. `npm run installer:sign` without env: warning + exit 0, artifacts
   untouched.
3. The update-agent suite consumes a `release`-generated manifest (not just a
   hand-written fixture) — the same apply/rollback path proven against the
   automated manifest shape.

**5. First-boot smoke drill — SCRIPTED AND GREEN (2026-09-12, `v0.1.0-rc.6`
→ `v0.1.0-rc.7`).**
The drill runs as a workflow (`.github/workflows/smoke-drill.yml`, dispatch
with a release tag) on a hosted x64 Windows runner: silent install → service
RUNNING → first-boot console → admin key minted once → simulator message
lands (before=0 → after=1, HELD) → Authenticode baseline (UNSIGNED, D13) →
silent uninstall (service gone, payload gone, data dir kept). It caught five
real installer bugs in sequence — ANSI em-dash in WinSW XML, unquoted
`%BASE%` arguments, the platform-optional esbuild missing from the payload,
the silent-uninstall MessageBox hang, and NSIS's temp-copy uninstall wait
semantics — each fixed and pinned by an invariant test; full story in
`packaging/README.md`. **Gated-release verification (2026-09-12):** the
drill then became the release workflow's required post-publish gate
(reusable-workflow call, `smoke-drill needs: publish`) and `v0.1.0-rc.7`
verified the whole chain in one run — compile → sign no-op → publish →
drill (15/15 steps green, run 34684592250 for the independent re-drill) —
plus the operator download path (released exe hash-verified against
`SHA256SUMS.txt`; manifest cross-checked against the published assets).
The superseded `v0.1.0-rc.1`–`rc.6` releases/tags were deleted afterward
(metadata + checksums archived first). **Still deferred:** the interactive SmartScreen /
Digital-Signatures observation on real pilot hardware — meaningful only once
a certificate exists (D13), so the purchase decision compares against this
recorded unsigned baseline.

**Explicitly deferred:** the certificate purchase + secret configuration (D13
— the only piece actually blocked on a purchase), MSIX/store distribution
(unchanged W2.5 rationale), macOS signing parity (dev-only launchd story
today), an installer-level self-updater (the supervisor story updates the hub
payload; the installer itself is re-run manually).

#### W5 resolution (implemented)

- **Signing wrapper (`packaging/installer/sign.sh`, `npm run
  installer:sign`)**: env-driven (`SIGN_FILES` + a `SIGN_COMMAND` printf
  template with one `%s`), with a VERIFY pass after every signed file
  (`signtool verify /pa` when present, `osslsigncode verify` on POSIX) — a
  requested-but-failed signature exits 1; missing files exit 1. The wrapper
  REFUSES a `SIGN_COMMAND` without an RFC-3161 timestamp flag (`-tr` / `/tr`
  / `-ts`) — signatures must outlive the certificate, or cert rotation day
  breaks every deployed edge. Without `SIGN_COMMAND`: loud boxed warning +
  exit 0 (unsigned dev/CI builds stay green; the release body states the
  unsigned status). `build.sh` invokes it after `makensis` (escape hatch:
  `SKIP_SIGN=1`).
- **Release workflow (`.github/workflows/release.yml`)**: tag `v*` (or
  manual dispatch for hotfixes) → compile job (the W2.5 docker-makensis
  recipe, BOTH variants) → sign-and-publish on **windows-latest** (signtool
  ships with the SDK): signs through the same `sign.sh` when
  `vars.SIGN_COMMAND_TEMPLATE` exists, writes `SHA256SUMS.txt`, generates the
  update manifest via `update-cli release` (Ed25519-signed when
  `secrets.UPDATE_SIGNING_KEY` exists — written to a private temp file, never
  echoed), and `gh release create` publishes both exes + checksums +
  `manifest.signed.json`, with an UNSIGNED-publish note in the body when
  configuration is absent. The push/PR CI is untouched.
- **`update-cli release`**: builds the release manifest from `--version`,
  `--url`, `--sha256`, `--size`, `--min-hub-version`, optionally signs in the
  same step (`--key`), and validates at the boundary via
  `updateManifestSchema` — an invalid manifest fails at release time, not at
  an edge's update poll. `buildReleaseManifest` is exported and the CLI
  module is import-guarded (runs `main()` only when invoked directly) so the
  tests exercise the same builder the workflow ships. The core manifest
  schema gained an optional `artifact.url` (backward compatible: the M2
  fixture manifests have no URL; release manifests always do).
- **Exit proofs** (`packaging/installer/release.test.ts`, 6 tests — all
  Docker-free): static invariants pin the wrapper (env contract, timestamp
  enforcement, loud unsigned no-op, verify pass, build.sh wiring), the
  workflow (tag trigger, both variants, windows signing host, checksums,
  manifest, GitHub Release, unsigned note) and the CLI subcommands; live
  checks round-trip a `release`-generated manifest through the REAL core
  signature path (keygen → build → sign → verify, tamper rejected). CLI smoke
  on disk: keygen → release+sign → verify all exit 0. Full suite: 422 tests,
  422 pass (with DB up).
- **What is NOT done (by design, D13)**: no certificate purchased, no
  signing secrets configured — signing activates by configuration when the
  first pilot demands it; until then releases publish unsigned with the
  checksums + the Ed25519 manifest as the integrity layer.

---

## 9. What is NOT in scope for the desktop track

- Multi-tenant cloud (that's H1–H5, separate track).
- Building new clinical or protocol capability — the desktop package reuses the existing pipeline, ASTM/HL7, profiles, matching, validation, HELD, routing, alerts, webhooks, FHIR, SDK.
- Any clinical interpretation — the platform still never does that.
- Cloud hosting decisions (D6) — those apply to the cloud platform, not the local box.

---

## 10. Risks + honest limits

- **SQLite is great for a single-facility edge, not for a multi-tenant cloud.** That's exactly why the split exists. If a future customer demands cloud-side SQLite for some reason, that's an escalation like D5, not the default.
- **Orthanc on Windows is still a separate process** with its own data and ports; bundling it locally is fine, but it's not "the hub becomes DICOM-native." The AGPL boundary stays identical to the Docker case.
- **Network/firewall is the most likely end-user support issue** on a local Windows box, especially for analyzer/modal connectivity and any outbound LIS reach. The installer + first-boot flow should make this as obvious as possible.
- **Cloud pairing later is a designed path, not a day-one feature.** Local-first, cloud-later is deliberate; pairing should be a controlled H3-style flow, not accidental data sharing.

---

## 11. How this folds into the existing plan

- **Decision D2** gets the Windows-local resolution above; the cloud/central side stays Postgres.
- **§7.G edge resilience** already has the local-durable-store + outbox + watchdog + secure-channel shape; the Windows track is the packaging of that for a single Windows machine.
- **§7.H cloud** stays Postgres + org/facility + RLS + BullMQ sync; the local box is the edge that can later pair into it.
- **§4.2/§4.3 edge packaging** already says edge packaging goals include auto-start as OS service, crash/power-loss recovery, durable local queue, outbound-only secure channel, signed updates. The Windows desktop track is the concrete Windows expression of exactly that.
- **§7.D5 tenancy** stays as resolved: shared-schema + RLS for cloud; local Windows is single-tenant edge by default, with cloud pairing later.

---

*End of track.*
