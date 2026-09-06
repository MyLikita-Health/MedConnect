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

### 8.2 Phase W2 — Windows service + packaging skeleton

- Wrap the hub as a Windows service / supervised process: auto-start, crash recovery, safe shutdown, logs, uninstall.
- Build the installer skeleton: install dir, data dir, service registration, shortcuts, firewall notes, uninstall.
- First-boot config UI: facility name, domain choice, device/network basics, admin key, optional cloud pairing artifact.

### 8.3 Phase W3 — imaging + network reach polish

- Bundle/hook Orthanc locally when imaging is enabled; keep the AGPL boundary (out-of-process, REST-only).
- Harden LAN device connectivity: listen ports, TLS option, firewall guidance, analyzer/modal binding.
- Ensure outbound LIS/HIS/EMR reach works cleanly in local mode with retry/DLQ.

### 8.4 Phase W4 — cloud-pairing readiness + update delivery

- Make the local install cloud-pairing-ready: outbox + tenant context + pairing artifact, so later pairing to a cloud org/facility is a controlled flow rather than a re-install.
- Settle Windows update delivery mechanics on top of the existing signed-update supervisor story.

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
