# Integration Hub — Full Platform Implementation Plan

> **Status:** Living document · v1.0 · September 2026
> **Sources:** [`prd.txt`](./prd.txt) (product definition), the MVP scaffold in this
> repository (`packages/*`, `README.md`), and the build-vs-buy architecture decision
> documented in §3 (hub-as-orchestrator around Orthanc/HL7 engines).
> **Working name:** Integration Hub. **Commercial line:** "Connect any medical device to
> any healthcare system."

---

## 1. Purpose, scope, and assumptions

### 1.1 Purpose

This document is the engineering + product implementation plan for the **entire**
Integration Hub platform — from today's MVP scaffold to a commercially deployed,
multi-tenant platform connecting laboratory analyzers, imaging modalities, and other
medical devices to LIS/HIS/HMS/PMS/EMR/RIS/PACS systems. It is intended for the
engineering team, product decisions, partner discussions, and commercial planning.

It deliberately follows the PRD's staged philosophy: **laboratory first → imaging
second → broader devices later** (§5, §55, §69). "Full platform" does **not** mean
"build everything at once"; it means the plan covers the whole destination and the
staged route to it.

### 1.2 What the full platform is

```text
                      ┌───────────────────────────────┐
                      │   CLOUD MANAGEMENT PLATFORM   │   multi-tenant org → facility
                      │   fleet mgmt · analytics      │   licensing · support
                      └──────────────┬────────────────┘
                                     │ secure channel (outbound from edge)
        ┌────────────────────────────▼────────────────────────────┐
        │                      INTEGRATION HUB                    │
        │   mapping · routing · queue/retry/DLQ · patient match    │
        │   validation · dedup · audit · alerts · exception UI     │
        └───────┬──────────────────────────┬──────────────────────┘
      lab side  │                          │ imaging side
        ┌───────▼────────┐        ┌────────▼──────────┐   outward
        │ ASTM / HL7 v2  │        │  DICOM (Orthanc)  │   HL7 v2 / FHIR / REST
        │ TCP / serial   │        │  MWL · C-STORE    │   webhooks → LIS/HIS/EMR
        └───────┬────────┘        └────────┬──────────┘
           analyzers / POCT          modalities / PACS
```

Edge gateway runs on-premises inside the facility LAN and keeps working offline; the
cloud platform manages fleets of gateways and facilities. Protocols are executed by
specialist engines (see §3); the Hub owns everything around them.

### 1.3 Scope boundaries (what the platform is NOT)

Per PRD §5: **not** an LIS, EHR, PACS, image archive, patient portal, or clinical
decision system. It never interprets results clinically. Where a component would drift
into these domains, it is delegated to the customer's systems (or to an engine like
Orthanc) rather than built.

### 1.4 Planning assumptions

| # | Assumption | Impact |
| --- | --- | --- |
| A1 | Core team of 3–5 engineers (Node/TS + infra) with part-time product, QA, clinical/field liaison; growth in later phases | Milestones sized to this team; durations in §9 are reference values |
| A2 | Node.js + TypeScript remains the platform language (PRD §49) | DICOM networking stays delegated to Orthanc (§3.2) |
| A3 | PostgreSQL + Redis available in production; cloud hosting can be self-hosted or hyperscaler | Architecture keeps cloud optional until Phase 3 |
| A4 | First commercial market: Nigeria / West Africa, then broader Africa; HIPAA/GDPR readiness is architectural, not first-market compliance (PRD §45) | Compliance program (§7.10) sequenced accordingly |
| A5 | No FDA/CE class-II submission assumed for the integration layer (no clinical interpretation); legal review required before commercialization (risk R8) | Treated as a risk + open decision, not a build blocker |
| A6 | Field access to real analyzers (or vendor test systems) for conformance of the first 3–5 certified devices | Gating risk for the certification program (§7.11, risk R2) |

### 1.5 How to read this document

- §2–§6: target architecture and what we build vs. buy.
- §7: per-workstream implementation plans (the "what", with deliverables and exit criteria).
- §8: phased roadmap with milestones and exit criteria (the "when").
- §9–§12: quality, rollout, team, risks, open decisions.
- §13: relationship to the current scaffold (what evolves vs. is replaced).

---

## 2. Product goals and success criteria (recap from PRD)

**North star metric:** *number of successfully interoperating medical devices* (PRD §65).

Supporting product metrics: connected facilities · connected devices · supported
device models · messages processed · message success rate · median processing latency ·
integration deployment time.

Business metrics: MRR · revenue/facility · distributor partnerships · retention ·
integration cost per customer.

Reliability/performance targets (PRD §46–47): edge gateway ≥99.9% availability,
automatic recovery after power/network/crash; ≥10,000 messages/hour per gateway;
<1 s typical processing latency (excluding device/network).

---

## 3. Guiding architecture: build vs. buy

### 3.1 Conclusion (from the architecture decision)

Do **not** build one monolithic protocol stack. Build the Hub as an **orchestrator
around specialist engines**, owning: the canonical model, adapters, mapping, routing,
queueing, exception handling, management UI/API, edge resilience, and ecosystem. Let
engines that already solve a hard protocol problem do their job:

- **DICOM networking → Orthanc** (adjacent service, driven over its REST API — never a
  hand-written Node C-STORE stack; no mature Node DICOM networking exists).
- **HL7 v2 parsing → mature library**; we build the thin messaging engine around it.
- **General integration/routing engines (Mirth Connect, Rhapsody, ...)** → not required;
  optional interop for customers who already run them (they can front/consume our HL7
  v2/FHIR interfaces).
- **ASTM E1381/E1394 device communication → build in-house** (this is the moat: no
  commodity product does multi-vendor analyzer framing/sessions well; the scaffold
  already implements the core, and the team has production experience here).
- **FHIR → implement R4 outward endpoints ourselves on top of shared REST/validation
  foundations** (it is an API contract, not a wire protocol we must decode).

### 3.2 Build / buy / integrate decision matrix

| Capability | Decision | Rationale | License/boundary note |
| --- | --- | --- | --- |
| ASTM E1381/E1394 framing, sessions, checksums | **Build** (done in scaffold, evolve) | No commodity product; core moat | n/a (ours) |
| Per-device analyzer profiles & adapters | **Build** (config-first) | Differentiation (PRD §39–40, §56) | n/a (ours) |
| HL7 v2 parsing | **Buy** (library) | Mature, PRD §49 explicitly says don't reinvent | MIT/Apache libs preferred |
| HL7 v2 MLLP transport engine | **Build thin** (server/client over TCP, framing is trivial) | Small, high-value, keeps profile control | ours |
| DICOM storage/worklist/forwarding | **Integrate Orthanc** via REST | Mature engine; Node has no DICOM networking | **AGPLv3** — separate process, no embedding/linking; document boundary (§7.5.5) |
| Imaging routing to PACS | Configure Orthanc peers + hub rules | Reuse engine routing | same |
| General routing/transformation engine | **Build the slice we need**; interop w/ Mirth optional | Mirth-class engines are config jungles; our rules are DB-driven and domain-shaped | MPL/AGPL engines stay out-of-process |
| Queues / retry / DLQ | **Build** on Redis + BullMQ (cloud) / local durable outbox (edge) | Core reliability value (PRD §21–23) | OSS libs |
| Serial transport (RS-232) | **Buy** (node-serialport) | Mature lib | OSS |
| Web console UI | **Build** (React/Vite; scaffold ships a zero-dep preview, replaced in M0–M1) | Core product surface | ours |
| FHIR R4 | **Build** (outward contract) on our API | API contract work | ours |
| DICOMweb | Orthanc's DICOMweb plugin exposed via hub API | Reuse | AGPL — separate process |
| Observability | **Buy/build mix**: pino, Prometheus metrics, OpenTelemetry | PRD §48 | OSS |

### 3.3 Architecture invariants (non-negotiable)

1. **The Integration Core never depends on a specific vendor or protocol** (PRD §67):
   everything enters/leaves through the canonical model.
2. **Canonical model is the single source of truth** for messages, orders, results,
   studies — never vendor formats.
3. **Configuration-first**: device profiles, mappings, routes, retry policies are data
   (DB/YAML), not code; custom code adapters are the exception, loaded as plugins.
4. **Nothing is ever silently dropped**: every message reaches a terminal state
   (ROUTED/FAILED) or an exception queue with full auditability (PRD §22–23).
5. **Edge autonomy**: the gateway must function fully offline and sync when
   connectivity returns (PRD §43).
6. **Everything important is audited** (who/what/when/before/after/result — PRD §30).
7. **Licensing hygiene**: AGPL components (Orthanc) are always separate processes
   integrated over documented public interfaces; the Hub codebase stays proprietary.

---

## 4. Production technology baseline

### 4.1 Stack evolution

| Layer | Scaffold now | Production target | Why |
| --- | --- | --- | --- |
| Language/runtime | TS on Node 21 | TypeScript strict, **Node 22 LTS** | LTS support |
| REST API | node:http, hand-rolled router | **Fastify** + shared **zod** schemas | validation, plugins, perf |
| Persistence | in-memory ring (MessageStore) | **PostgreSQL 16** (+ JSONB) | PRD §49: JSONB, relational integrity |
| Queue/retry | none (sync pipeline) | **Redis + BullMQ** (cloud); durable SQL **outbox** (edge) | PRD §21–22 |
| ORM/migrations | none | Prisma or Drizzle (decision D2) | |
| Frontend | static HTML console | **React + Vite + TS**, chart lib | real console |
| Logs/metrics/traces | console | **pino** JSON logs, Prometheus metrics, OTel traces | PRD §48 |
| Serial | — | **node-serialport** | RS-232 analyzers |
| DICOM | — | **Orthanc** (adjacent process, REST) | §3.2, no Node DICOM stack |
| HL7 parsing | — | mature MIT/Apache v2 parser lib | PRD §49 |
| Packaging | tsx/CLI | Docker image + Windows installer + Linux systemd | edge deployment (§4.3) |

### 4.2 Process topology (production)

- **Edge gateway** (one service + bundled Postgres-or-SQLite option, see D4): device
  listeners (ASTM/HL7/serial), pipeline, local store, local console. Ships as Docker
  compose or native installer.
- **Cloud platform** (later phases): API, console, queue workers, Postgres, Redis;
  optional **bundled Orthanc** container per facility (or customer-provided).
- Gateways reach out over a secure channel only (PRD §42); no inbound ports opened.

### 4.3 Edge packaging goals (PRD §46, §42, §43)

- Auto-start as OS service; crash/power-loss recovery; durable local queue (outbox).
- Encrypted local storage for messages/credentials; credential rotation.
- Outbound-only secure channel to cloud; remote updates (signed).
- Runs on modest hardware (small PC / mini-PC / VM in hospital LAN).

---

## 5. Data architecture

### 5.1 Entity groups (PRD §50) and rollout

| Group | Entities | Phase | Notes |
| --- | --- | --- | --- |
| Tenancy | Organization, Facility, Department | 3 (edge-only before) | cloud platform |
| Identity | User, Role, RoleBinding, Session, ApiKey | 1 (edge) / 3 (cloud) | RBAC PRD §34 |
| Devices | Device, DeviceType, Manufacturer, DeviceModel, DeviceProfile | 1 | profiles = config-first adapter (PRD §39) |
| Connectivity | Connection (tcp/serial), Integration, Channel | 1 | per-facility bindings |
| Messages | Message, MessageAttempt, MessageError, ParsedRecord, RawMessage | 1 | store raw + parsed for viewer/retention |
| Clinical | Patient, Order, Specimen, Result | 1 (local), sync 3 | canonical model tables |
| Mapping | TestMapping, UnitMapping, ResultFlagMapping, IdentifierMapping | 1 | DB-driven (PRD §17–18) |
| Routing | RouteRule, Transformation | 1–2 | rules engine |
| Imaging | Study, Series, Instance (metadata), OrthancPeer | 2 | metadata only; pixels stay in Orthanc/PACS |
| Ops | AuditLog, Alert, Notification, DeadLetterMessage | 1 | PRD §30, §33 |
| Platform | License, Subscription, FacilityPkg, Release (firmware) | 3 | commercial (PRD §61) |

### 5.2 Key decisions

- **Message table is append-mostly**; attempts/errors as child rows; raw stored with
  retention policy (PRD §44). Newest-first queries use `(received_at DESC, id DESC)` +
  BRIN/b-tree indexes on `device_id`, `status`, `received_at`.
- **Patient/order/result** tables keep the canonical values *plus* the original device
  identifiers needed for matching (PRD §27) and dedup (§29).
- **Tenancy** (cloud): shared schema with `org_id`/`facility_id` columns + Postgres RLS;
  re-evaluate schema-per-tenant only if a customer demands hard isolation (D5).
- **Edge → cloud sync**: outbox pattern — every local write also appends to an outbox
  row; the sync worker ships rows and marks them acked. No dual-write races.
- **JSONB** for: device profile config, mapping tables snapshot, route rule payload,
  parsed-record blobs, extension metadata.

### 5.3 Message lifecycle (status model)

```text
RECEIVED → PARSED → VALIDATED → MAPPED → ROUTED         (success)
         ↘ any failure → FAILED (with errors) → DLQ workflow:
           view → correct → REPLAY → ROUTED | discard | quarantine   (PRD §23)
Dedup hit → DUPLICATE (skipped, logged)
Patient/order unresolved → HELD (ambiguous/ unmatched review queue, PRD §27)
```

Terminal-state guarantee: every message lands in one of ROUTED, FAILED(+DLQ),
DUPLICATE, DISCARDED — never silently dropped.

---

## 6. Domain & pipeline evolution

### 6.1 Generalize the adapter contract (evolve scaffold)

Today the gateway is ASTM-shaped (`AstmGateway` pushes straight into the pipeline).
Production introduces a protocol-agnostic **AdapterRegistry + DeviceProfile** (PRD §40):

```ts
interface DeviceAdapter {
  readonly profile: DeviceProfile;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendOrder(order: CanonicalOrder): Promise<DeliveryReceipt>;   // orders DOWN to device
  start(): void;                                                 // listen for device
  health(): Promise<DeviceHealth>;
}

// registered by protocol, e.g.
//   AstmTcpAdapter(profile) · Hl7MllpAdapter(profile) · SerialAstmAdapter(profile)
//   · DicomOrthancAdapter(profile)  (talks REST to Orthanc, not DICOM itself)
```

The pipeline input becomes `ParsedMessage { protocol, raw, records }` — ASTM is simply
one translator to canonical (what `astmToCanonical` does today); HL7 v2, FHIR, and
DICOM metadata gain their own translators into the **same** canonical shapes.

### 6.2 Canonical model extensions by phase

| Phase | Canonical additions |
| --- | --- |
| 1 (lab) | full Order (tests, priority, collection), Specimen, Result flags/statuses, identifiers (patient, accession, sample), measuredAt |
| 2 (imaging) | ImagingRequest (accession, modality, requested procedure), Study/Series/Instance **metadata** + storage URLs; pixels never in hub DB |
| 3 (advanced) | FHIR-flavored projections (Patient/ServiceRequest/DiagnosticReport/Observation/ImagingStudy); consent/privacy flags |
| 4 (devices) | DeviceTelemetry (monitors, ECG, POCT), waveform references (never waveforms in DB) |

### 6.3 Config-first device profiles (PRD §39)

Stored in DB (JSONB) + versioned; example fields:

```yaml
profile:
  id: mindray-bs430-v1
  manufacturer: Mindray
  model: BS-430
  protocol: ASTM
  transport: tcp            # tcp | serial
  connection: { host: "192.168.1.20", port: 5000 }
  session: { initiator: device | host, frameNumbering: none|echo, checksumIncludesStx: true }
  records:                  # vendor layout override (real devices deviate!)
    patient: { id: 3, name: 4, dob: 6, sex: 7 }
    order:   { sampleId: 2, accession: 3, test: 4 }
    result:  { test: 2, value: 3, unit: 4, ref: 5, flag: 6, status: 8 }
  capabilities: [orders-down, results-up, host-query]
  mappings: { GLU: GLUCOSE, CREA: CREATININE }
```

A **profile conformance test** (from the simulator + golden messages, §7.11) is required
before a profile ships; adapters that need code get a plugin slot behind the same
contract.

### 6.4 Order download (bidirectional, PRD §20)

Lab order workflows: LIS order → hub → device via (a) ASTM host-initiated query
(device sends Q records, hub answers with O records), (b) hub-initiated push where the
vendor supports it, (c) HL7 ORM. Imaging: RIS/HIS order → hub → Orthanc worklist (MWL)
→ modality. Both directions route through the same canonical Order.

---

## 7. Workstream implementation plans

Each workstream lists **objective → deliverables → exit criteria**. Workstreams run in
parallel within phases (§8); letter = permanent capability area.

### A. Gateway device connectivity (ASTM focus)

**Objective:** production-grade multi-vendor analyzer connectivity (evolve scaffold).

Deliverables:
- A1 Session engine maturity: host- and device-initiated sessions, frame-number echo
  option, serial (RS-232) transport, TLS option, connect watchdog + auto-reconnect.
- A2 DeviceProfile model + DB + admin CRUD + conformance gate (§6.3).
- A3 Capabilities: results up (ORU-style R records), orders down + host-query (Q/O
  exchange, §6.4), ACK handling, host clock sync message where vendors require it.
- A4 AdapterRegistry loading profiles + optional code plugins.
- A5 Diagnostics: per-connection live log, raw-frame inspector, test-message sender
  (PRD §24–25) for the console.

Exit criteria: 2 pilot analyzers (2 vendors) running 24/7 with auto-reconnect; zero
silent drops over a 7-day soak; serial + TCP both covered by simulator tests.

### B. HL7 v2 engine (outward LIS/HIS + inbound ORU)

**Objective:** speak HL7 v2 to LIS/HIS/EHR and accept result feeds.

Deliverables:
- B1 MLLP server + client (parse via mature lib; build transport + error handling).
- B2 Message support: MSH/ACK + ADT^A01/A04/A08, ORM^O01 (order), ORU^R01 (result),
  plus inbound ORU translation → canonical (mirror of astmToCanonical).
- B3 Outbound: canonical → HL7 ORM/ORU via mappings; configurable sending facility
  fields, segment variants, ACK tracking + retry.
- B4 Vendor profile concept extended to HL7 (delimiter/segment variants).

Exit criteria: two-way exchange with a conformance harness (our HL7 simulator) for
ADT/ORM/ORU; ACK/NACK handling incl. reject reasons surfaced in UI; no message loss on
destination outage (queued).

### C. Imaging & DICOM (via Orthanc) — Phase 2

**Objective:** X-ray/CT/MRI modality connectivity and RIS/PACS interchange **without
writing DICOM networking** (decision §3.2).

Deliverables:
- C1 Orthanc integration module (`DicomOrthancAdapter`): REST client wrapper — create
  patients/studies for MWL, query studies, delete, list modalities/peers.
- C2 **MWL workflow**: RIS order → hub → Orthanc worklist → modality; hub monitors
  whether the study was performed (PRD §14).
- C3 **Storage routing**: Orthanc captures C-STORE from modalities; hub registers it as
  a forwarding peer to PACS/archive; hub stores study metadata + status; routing rules
  (modality, department, accession) live in hub DB.
- C4 Failure handling: studies that fail to reach PACS → exception queue with replay;
  modality/Orthanc health surfaced as devices (PRD §32–33).
- C5 Orthanc lifecycle: container packaging, upgrade path, AGPL boundary doc (§7.5.5);
  optional customer-provided Orthanc.
- C6 Imaging console: modality list, worklist status, failed studies, routing view
  (PRD §7.3).

Exit criteria: end-to-end with simulator (Orthanc + fake modality using its tools or
pynetdicom): order → MWL → store → route to mock PACS; failure injection shows in DLQ;
radiology pilot at one site.

### D. FHIR & outward developer surface — Phase 3

**Objective:** expose the platform as a FHIR R4 server + REST API + webhooks + SDK for
LIS/HIS/EHR/PMS vendors (PRD §15, §36–38).

Deliverables:
- D1 FHIR R4 read/write/search for Patient, ServiceRequest, Observation,
  DiagnosticReport, ImagingStudy, Device, Task (result routing).
- D2 Internal translation FHIR ↔ canonical (two-way, tested).
- D3 Webhook event bus: result.received/validated/failed, order.received,
  device.connected/disconnected, message.failed (PRD §37); signed deliveries, retries.
- D4 REST API v1 GA + versioning policy + OpenAPI; sandbox environment with seeded data.
- D5 SDK (JS/TS first) wrapping orders/results/devices/webhooks (PRD §38).

Exit criteria: reference LIS/EHR integration completed in sandbox without our help;
webhook replay + signature verification tested; OpenAPI published.

### E. Integration core services (Phase 1 core)

**Objective:** the reliable, auditable middle of the platform (PRD §19, §21–23, §27–29).

Deliverables:
- E1 **Mapping engine** (DB-driven): test codes, units, flags, specimen types, patient
  identifiers, departments (PRD §17). UI to view/test mappings; mapping change = audit
  event; canary test before activation.
- E2 **Routing engine**: rules from device/department/message type/facility/test/
  modality/patient/accession (PRD §19); destinations = integrations (HL7 out, FHIR,
  API/webhook, PACS peer). Rule editor + dry-run.
- E3 **Durable pipeline**: message through queue with per-step acknowledgment;
  retry policy config (PRD §22 backoff table); DLQ with view/correct/replay/discard
  (PRD §23); replay re-enters pipeline with audit.
- E4 **Dedup** (PRD §29): composite keys (message/sample/order/accession/device
  result id + timestamp-hash); configurable window; duplicates logged, not forwarded.
- E5 **Validation engine** (PRD §28): patient matched? order exists? test known? unit
  recognized? result plausible? device authorized? → per-rule config + exception queue.
- E6 **Patient & order matching** (PRD §27): configurable strategies (id + order +
  accession; fallback rules); statuses MATCHED/UNMATCHED/AMBIGUOUS/REJECTED; HELD
  review queue in UI; no silent auto-assign on ambiguity.

Exit criteria: simulated outage of destination → messages queue and retry per policy;
DLQ correct-and-replay round-trip demonstrated in UI; dedup and matching unit/integration
suites green; all actions audited.

### F. Management plane: API, auth, console (Phase 1+)

**Objective:** configuration + operations product surface (PRD §7 personas, §31–36).

Deliverables:
- F1 REST API v1 GA (Fastify + zod), versioned; covers devices, profiles, mappings,
  routes, integrations, messages (+ replay), DLQ actions, alerts, users.
- F2 Authn/authz: local accounts + optional LDAP later; JWT sessions; RBAC with PRD §34
  roles (Super Admin, Facility Admin, Integration Engineer, Lab/Radiology/IT Admin,
  Viewer); per-facility scoping; 2FA (TOTP) by Phase 3.
- F3 React console: Dashboard (PRD §31), Devices+health, Integrations, Mappings,
  Routes, Message Viewer (raw/parsed/canonical/timeline), DLQ + exception queues,
  Test Message sender (PRD §25), Users/Roles, Audit log, Alerts.
- F4 Audit service: centralized write of audit events; query UI; export.

Exit criteria: persona walkthroughs for Integration Engineer + Lab Admin + IT Admin
complete; RBAC enforced and tested per role; every mutating action audited.

### G. Edge resilience & cloud sync (Phase 1 edge / Phase 3 cloud)

**Objective:** facility keeps working when WAN dies; sync when back (PRD §10, §43).

Deliverables:
- G1 Local durable store + outbox; crash recovery (replay outbox on boot).
- G2 Edge watchdog/supervisor: restart policy, heartbeat, health file, disk/log
  rotation, safe shutdown (PRD §46).
- G3 Secure channel (TLS, client cert / device auth), outbound only (PRD §42);
  credential + profile rotation; signed update packages.
- G4 Sync protocol: message/clinical/audit delta sync with idempotency + conflict
  policy; bandwidth-friendly batching; sync status visible in console.

Exit criteria: kill -9 + power-cut tests lose zero committed messages; 48 h offline
soak then sync converges with no duplicates (idempotency keys); update applied
remotely and rolled back on failure.

### H. Cloud platform & multi-tenancy (Phase 3)

**Objective:** manage fleets of facilities/gateways from one place (PRD §35).

Deliverables:
- H1 Org → Facility → Department hierarchy; users scoped per level; RLS enforcement.
- H2 Cloud console superset of edge console; fleet views: gateways, devices, messages
  aggregated; per-facility drill-down.
- H3 Remote provisioning: gateway onboarding (pairing code/cert), profile push,
  updates (PRD §42, §63 marketplace-ready).
- H4 Platform ops: tenant metrics, per-tenant quotas, feature flags.
- H5 Commercial hooks: license/subscription model entities (PRD §61) + entitlement
  checks at gateway + API; analytics exports for success metrics (§2).

Exit criteria: two tenants isolated end-to-end (data + RBAC) verified by test suite;
onboard a new facility gateway in <15 min unattended after hardware placement.

### I. Observability & alerting (Phase 1 base, grows)

Deliverables: structured JSON logs with correlation ids; Prometheus metrics
(messages_received/processed/failed_total, device_connections, queue_depth,
processing_latency histogram — PRD §48); OTel traces across device→parser→mapper→
router→destination; alert rules (PRD §33): device offline, queue backlog, repeated
failures, destination down, auth failures, abnormal message rate, disk, service down;
channels: console, email, webhook (+SMS later). SLO dashboard vs §2 targets.

Exit criteria: an operator can answer “why didn’t this result reach the LIS?” from
console in <2 min (PRD §60 diagnostics goal); alert fires and resolves correctly in
chaos drills.

### J. Security & compliance program (continuous)

- Threat model + data classification (PHI/PII at rest/in transit) per PRD §41.
- Controls: TLS everywhere, encryption at rest, secrets manager, RBAC, session
  management, API keys w/ scopes, audit logging, network segmentation guidance,
  credential rotation; edge per PRD §42 (device certs, outbound only, local encryption,
  signed updates).
- Compliance posture (PRD §45): NDPA/NDPR first market; architect for HIPAA/GDPR
  (BAAs, DPA templates, retention controls §44); ISO 27001/SOC 2 oriented program.
- Cadence: quarterly pen test, dependency scanning in CI, SBOM, annual review.
- Regulatory: legal opinion on device-software boundary in target markets (risk R8).

Exit criteria: security review gates for each release; pen test findings remediated;
compliance readiness pack (policies, DPA, retention matrix) exists before first
commercial contract.

### K. Simulators & conformance tooling (Phase 1, grows)

Deliverables: ASTM analyzer simulator (exists, extend: serial, host-query, corrupt
scenarios), HL7 simulator (ORM/ORU/ADT), DICOM simulator via Orthanc + a small modality
harness; **golden-message library** per vendor/version; automated profile conformance
harness (PRD §26, §56: “generic ASTM/HL7 + certified device adapters”); test-message
flow UI (PRD §25 checkmarks).

Exit criteria: every shipped profile has a recorded conformance run in CI; simulators
used by QA, field demos, partner onboarding, certification (§L).

### L. Ecosystem & commercial enablers (Phase 4)

Deliverables: device catalog/marketplace (install-adapter flow, PRD §63); adapter
packaging/versioning/ratings; certification program + test plan (PRD §64); OEM/
white-label embedding API (PRD §61); sandbox + partner docs portal; distributor
bundling kit (PRD §62).

Exit criteria: one distributor and one OEM partner on-boarded; first certified device
added by partner without core team.

---

## 8. Phased roadmap & milestones

Reference calendar for a core team of 3–5 engineers (assumption A1). Workstreams run
in parallel; milestones are integration gates, not team hand-offs.

### 8.1 Milestone map (PRD phase mapping: M1 = PRD V1 lab · M3 = PRD Phase 2 imaging ·
M4 = PRD Phase 3 advanced · M5 = PRD Phase 4 ecosystem)

| Milestone | Months | Theme | In-scope (highlights) | Exit criteria (gate) |
| --- | --- | --- | --- | --- |
| **M0** | 0–2 | Foundations | Postgres + migrations; Fastify/zod API base; config service; RBAC/auth skeleton; observability base; CI/CD; React console shell; schema for devices/messages/mappings | `npm run build && npm test` green in CI; dev env = docker compose; seed demo works against DB (not in-memory) |
| **M1** | 3–6 | **V1 lab gateway production** | ASTM profiles + serial; HL7 v2 lab engine (B); durable pipeline (E3) + retry/DLQ; mapping + routing DB-driven; dedup; message viewer; console v1 (F); edge watchdog + outbox (G); simulators/conformance v1 (K) | 2 pilot labs live (1–2 vendors each); soak 7 days w/ 0 silent drops; PRD §55 MVP checklist closed |
| **M2** | 7–9 | V1 hardening + certifications | Patient/order matching (E6); validation rules; alerting live; security review; installer + remote update; **3–5 certified device profiles**; goldens in CI | GA v1 release; integration-deployment time <1 day/facility; support/runbooks; first paying facility |
| **M3** | 10–14 | **Imaging (DICOM)** | Orthanc module (C1–C5); MWL; storage routing to PACS; radiology console; imaging failure queue; RIS/HL7 outbound for imaging | Radiology pilot: order→MWL→store→PACS end-to-end; failure drill passes; dual-domain (lab+imaging) console at one facility |
| **M4** | 15–20 | **Cloud platform + developer surface** | Multi-tenant cloud (H1–H3); FHIR R4 (D1–D2); webhooks (D3); REST GA + sandbox (D4); SDK (D5); analytics/licensing hooks (H5) | Reference vendor integrates via sandbox unaided; 2 tenants isolated (test-proven); edge sync converges after 48 h offline |
| **M5** | 21–26 | **Ecosystem & broader devices** | Marketplace + adapter packaging (L); certification program; OEM/white-label API; ECG/monitor/POCT profiles; MPPS/DICOMweb/IHE where demanded (PRD §58) | Distributor + OEM onboarded; 1 certified device added by partner; N connected-device metric compounding quarterly |

### 8.2 Sequencing principles

- **Do not start M3 imaging until M2 gate closes** (PRD §69: lab rock-solid first).
- Cloud (M4) work may begin *scoped* early (tenant columns + RLS in M0 schema) to avoid
  migration pain, but the cloud product does not gate lab revenue.
- Simulators/conformance (K) and observability (I) are continuous, not one-off.
- Certification of the *first* vendors (M2) overlaps with M1 pilots: profile work starts
  the moment a real analyzer is available (risk R2).

---

## 9. Quality, testing & rollout

### 9.1 Test pyramid

1. **Unit**: codec/session/pipeline/rule engines (scaffold precedent: node:test suites).
2. **Integration**: adapter ↔ pipeline ↔ store over real TCP/serial-loopback.
3. **Simulator-based E2E**: full device scenarios incl. corruption, disconnects,
   destination outages, power-cut recovery (chaos drills on edge).
4. **Conformance**: golden-message runs per certified profile in CI (workstream K).
5. **Field validation**: pilot sites; issue tracking linked to golden library.

Every release must pass 1–4 before packaging. Performance benchmark (≥10k msg/h,
<1 s p95) runs in CI on a reference profile (PRD §47).

### 9.2 Rollout plan

| Step | Who | Gate |
| --- | --- | --- |
| Lab pilot 1 (single facility, 1–2 vendors) | core team + clinical liaison | M1 exit criteria |
| Lab pilot 2–3 (different region/vendors) | + field engineer | M2 |
| First paid facilities; support runbook + SLA | + support role | M2 exit |
| Radiology pilot (1 facility) | imaging partner site | M3 exit |
| Multi-tenant commercial (several facilities) | sales + distributor channel | M4 exit |
| Marketplace/OEM wave | partners | M5 |

Go-live checklist per facility: profile conformance run → connection test → mapping
validation → test messages (PRD §25 checkmarks) → shadow run (results mirrored, not
applied) → cutover → 48 h monitoring.

### 9.3 Support & ops model

Tier 1 (facility IT via console/runbooks) → Tier 2 (field engineers) → Tier 3 (core
eng, remote access via secure channel). Escalation on SLAs once commercial. On-call for
cloud; edge incidents primarily handled by T2.

---

## 10. Team & resourcing (reference)

Core: 2 backend/device engineers (Node/TS, protocol work) · 1 full-stack (console/API) ·
1 platform/infra (CI, Postgres/Redis, packaging, security) · part-time product owner,
QA, clinical/field liaison. Growth at M3 (imaging) and M5 (partner success). If team is
smaller, order of priority per phase: M0 core → M1 lab value → M2 certification →
M3 imaging only with a committed radiology pilot.

---

## 11. Risks & mitigations

| # | Risk | Mitigation | Owner |
| --- | --- | --- | --- |
| R1 | Scope explosion (“universal” too fast) | PRD staging; gate discipline §8.2 | PM |
| R2 | Device-specific quirks; no access to real analyzers for first 3–5 | Profiles + config-first; pursue vendor test systems/distributor partners early (PRD §62); golden lib from day one | Device eng |
| R3 | Patient/result misassociation (clinical) | Multi-identifier matching, HELD review, no silent fallback, audit (PRD §27, §66) | Core eng |
| R4 | Network instability at sites | Edge gateway, outbox, retry, offline mode, chaos drills | Platform |
| R5 | Orthanc AGPL boundary violated over time | Written boundary policy §7.5.5; separate process always; code-review check | Architecture |
| R6 | Node has no DICOM stack temptation to hand-roll | Decision matrix §3 enforced in ADRs | Architecture |
| R7 | Retention/compliance exposure of PHI | Retention matrix (PRD §44), encryption, audit; NDPA-first posture | Security |
| R8 | Regulatory (device-software boundary, data protection) in target markets | Legal opinion pre-commercial; no clinical interpretation; compliance pack §7.10 | Leadership |
| R9 | Key-person dependency (ASTM expertise) | Profiles as data + conformance tests capture knowledge in repo, not heads | All |
| R10 | Mirth/Orthanc “we already have that” objection in sales | Positioning: engines ≠ device-integration product; diagnostics + local deployment story (§1.2, §3) | Product |

---

## 12. Open decisions (decision log)

| ID | Decision | Options | Due |
| --- | --- | --- | --- |
| D1 | ORM/migrations | Prisma vs Drizzle | M0 |
| D2 | Edge local DB | bundled Postgres container vs SQLite+outbox | M0 |
| D3 | First certified vendors | depends on market/distributor access | M1 |
| D4 | Edge hardware baseline | mini-PC spec; OS support (Windows/Linux) | M1 |
| D5 | Tenancy model escalation | shared+RLS vs schema-per-tenant for large customers | M4 |
| D6 | Cloud hosting | self-hosted vs hyperscaler; region (data residency) | M3 |
| D7 | HL7 parser lib selection | evaluate MIT/Apache options | M0 |
| D8 | Licensing/commercial model detail | per-facility vs device-based vs OEM (PRD §61) | M2 |
| D9 | Marketplace timing vs M5 pull | demand check with distributors | M4 |
| D10 | Orthanc bundled vs customer-provided default | packaging/commercial impact | M3 |

---

## 13. Relationship to the current scaffold

The scaffold is the working **M0 codebase** — it proves the pipeline and protocol core.
It is not thrown away; it evolves as follows:

| Scaffold module | Production fate | Change |
| --- | --- | --- |
| `packages/astm` (codec, session, client) | **Keep + harden** | A1: serial transport, frame numbering option, TLS, watchdogs; keep zero-dep core, add tests for real-device variants |
| `packages/gateway` (TCP listener + pipeline) | **Refactor** | generalize to AdapterRegistry/DeviceProfile (§6.1); pipeline becomes protocol-agnostic |
| `packages/shared` (canonical model) | **Keep + extend** | §6.2 additions; add Imaging metadata, telemetry later; `DEFAULT_MAPPINGS` moved here (seeded into the DB) |
| `packages/api` MessageStore | **Done (M0)**: `PostgresMessageStore` behind `MessageSink` | in-memory `MessageStore` kept as fallback/default; both behind `StoreBackend` (§13.2) |
| `packages/api` REST + UI | **Done (M0)**: API on Fastify + zod | keep routes/URLs as v1 contract baseline (PRD §36); UI still the zero-dep console — React shell is M0 item 6 |
| `packages/core` (new, M1) | **Keep + grow** | durable delivery core: lifecycle §5.3, dedup (§29), routing (§5.1), dispatcher/retry/DLQ (E3); future: matching rules (E6), outbound HL7 delivery |
| `packages/simulator` | **Keep + extend** | serial, host-query mode, golden-message library, HL7 sim (B4) |
| `scripts/demo.ts`, tests | Keep as smoke/E2E harness | feed CI |

### 13.1 First 90 days (M0 backlog, concrete)

1. ✅ docker compose dev env (Postgres 16 host port 5434, Redis 7 host port 6380).
   CI (lint, build, test, coverage) — not yet set up.
2. ✅ DB schema migration (`packages/api/migrations/0001_init.sql`) for §5.1 Phase-1
   entities; `PostgresMessageStore`/`PostgresDeviceRegistry` behind the existing
   `MessageSink`; `org_id`/`facility_id` tenant columns added (RLS deferred to M4 —
   see §13.2 note).
3. ✅ Fastify + zod API layer (`packages/api/src/server.ts`); existing endpoints moved
   onto it with the same v1 surface. Authn/RBAC skeleton — not yet.
4. Config service + DeviceProfile model; profile conformance harness (simulator-driven).
   Partially done in M1 sprint 1: DB-driven routing (destinations + route rules, §5.1
   Routing group) via `@integration-hub/core`. DeviceProfile model — still open.
5. ⚠️ Durable delivery core shipped (M1 sprint 1): message lifecycle state machine
   (§5.3 statuses incl. QUEUED/DELIVERING/DUPLICATE/DISCARDED), dedup (PRD §29),
   per-destination retry/backoff with persisted `message_attempts`, and DLQ
   (`dlq_at` + /api/v1/dlq + discard). The delivery worker is **in-process** (the
   edge SQL-outbox shape, §4.2); Redis/BullMQ on the cloud side remains the swap.
6. React console shell with dashboard, devices, message viewer wired to the new API.
7. Decide D1, D2, D7; stand up observability base (pino + metrics).

Exit: M0 gate (§8.1) — demo runs against Postgres (`npm run demo:db`), all scaffold
        tests still green (`npm test` = 58; `npm run test:db` = 58).

### 13.2 M0/M1 build notes

- Backend selection is a wiring decision in `packages/server/src/index.ts`: set
  `DATABASE_URL` → Postgres (migrations auto-applied at startup, default mappings
  seeded into `test_mappings`); unset → in-memory.
- Both store/device backends share structural contracts in
  `packages/api/src/backend.ts` (`StoreBackend`/`DeviceBackend`); the Fastify
  handlers and the gateway's `MessageSink` usage are backend-agnostic.
- `MessageSink.record` now allows `void | Promise<void>`; the gateway awaits
  async sinks and surfaces persistence failures as session errors (never a
  silent drop). The gateway no longer pre-marks `ROUTED` — delivery (and the
  ROUTED/DLQ terminal states) belongs to the sink/dispatcher.
- M1 delivery core lives in a new `@integration-hub/core` package (dedup,
  routing, `Dispatcher`); migration `0002_m1_lifecycle.sql` adds `dlq_at` /
  `duplicate_of`, `destinations`, `route_rules`, `message_attempts`, and
  `dedup_keys`. In-process delivery is the edge-outbox shape; no queue recovery
  on restart yet (Redis/BullMQ swap keeps the same `Dispatcher` seam).
- RLS was deliberately NOT added with the tenant columns: default-deny policies
  would break single-tenant edge mode. Policies arrive with the tenancy
  mechanism in M4 (§5.2).

### 13.3 M2 sprint 1 — clinical correctness (E5 + E6): status

Shipped as `M2 sprint 1: clinical correctness` (matching, validation, HELD
queue). M2 gate items patient/order matching (E6) and validation rules (E5)
are implemented end-to-end; alerting (I), DeviceProfile model + goldens
(A2/K) are the next M2 sprints.

1. ✅ Matching engine (`packages/core/src/matching.ts`, PRD §27): configurable
   key strategies (default: patientId+orderId → patientId+sampleId); outcomes
   MATCHED / UNMATCHED / AMBIGUOUS / REJECTED; never silently auto-assigns —
   everything but a unique hit is HELD. Registry = the **LIS seam**:
   expected orders (`/api/v1/orders` CRUD; `order_registry` table in
   migration `0003`; `InMemoryOrderRegistry` + `PostgresOrderRegistry`).
2. ✅ Validation engine (`packages/core/src/validate.ts`, PRD §28): per-rule
   config + severity for patientMatched / orderExists / testKnown /
   unitRecognized / resultPlausible / deviceAuthorized; error-severity
   findings hold, warnings are recorded on the timeline. Server seeds
   catalog + numeric bounds (unit-convention note: seeds are mg/dL-style to
   match the reference simulator).
3. ✅ Lifecycle: `HELD` status + `MessageMatch` metadata on the message;
   `messages.match_*` columns; dispatcher runs match → validate → dedup →
   route (clinical gate before delivery); `release()` re-enters a HELD
   message into delivery. API: `GET /api/v1/held`, `POST
   /api/v1/messages/:id/release`; console shows HELD (color, match badge,
   Review & release action).
4. ✅ Simulator `--fixed` fixture mode (deterministic patient/order/sample for
   matching fixtures); `npm run demo` now registers the expected order,
   sends matched + stray samples, releases the HELD one, prints the summary.
5. Test status: in-memory suite green (`npm test` = 85: 76 pass / 9
   DB-gated skip). DB suite (`npm run test:db`) is green too — 85/85 incl.
   the Postgres matching → HELD → release round-trip. The DB gate caught
   two real bugs fixed in a follow-up commit: `match.reason` was dropped by
   the Postgres store (persisted via migration `0004`), and the order
   registry selected a `received_at` column the schema never created
   (created_at is the registration timestamp).

### 13.4 M2 sprint 2 — alerting (workstream I): status

Shipped as `M2 sprint 2: alerting` (PRD §33). The milestone's "alerting live"
item is implemented end-to-end; DeviceProfile model + goldens (A2/K) shipped
in sprint 3 (§13.5); security review and installer/remote update remain.

1. ✅ Alert engine (`packages/core/src/alerts.ts` + `alert-store.ts`): rules
   (kind/threshold/subject/cooldown/channels), fire/resolve lifecycle, one
   open alert per rule+subject, cooldown between firings. Four kinds:
   device-offline (fires on disconnect, resolves on reconnect),
   destination-down (consecutive failures), dlq and held-backlog (queue
   depth checks on transitions).
2. ✅ Channels: console (alert store → API/UI) and webhook (HTTP POST, JSON
   FIRING/RESOLVED payloads, failures logged not thrown).
3. ✅ Dispatcher lifecycle events (`DispatcherOptions.events`: onDelivery /
   onDlq / onHold / onRelease) keep alerting decoupled from delivery.
   Server wiring hooks gateway device states + dispatcher events, seeds
   default rules, and checks backlog counts from the live store.
4. ✅ Migration `0005_alerting.sql` (`alert_rules`, `alerts`) +
   `PostgresAlertStore`; API `GET/POST/DELETE /api/v1/alert-rules` and
   `GET /api/v1/alerts`; console Alerts panel (sidebar, firing list).
5. Tests: engine suite (fire/resolve/cooldown/webhook/disabled), dispatcher
   event tests, API tests, PG alert store + full-stack PG tests. Both suites
   green: `npm test` = 98 (87 pass / 11 DB-gated skip); `npm run test:db`
   = 98/98. Demo exercises fire → resolve for held-backlog.

### 13.5 M2 sprint 3 — device profiles + conformance (A2/K): status

Shipped as `M2 sprint 3: config-first device profiles + conformance harness`.
The config-first DeviceProfile model (PRD §39–40, §6.3) is implemented
end-to-end, and the golden-message conformance harness (workstream K) runs
certified profiles against golden ASTM transcripts **in the test suite** —
the "goldens in CI" M2 gate item is now concrete.

1. ✅ Shared model (`packages/shared/src/profiles.ts`): 1-based P/O/R record
   layouts, mappings, capabilities, connection/session options;
   `DEFAULT_REFERENCE_LAYOUT` + `defaultLayoutFor` (partial profiles inherit
   the reference per group — config declares only deviations).
2. ✅ Config service (`packages/core/src/profiles.ts`): zod
   `deviceProfileSchema` / `parseDeviceProfile` validate at the API boundary
   and on every stored-JSON read (corrupt rows fail loudly — covered by a PG
   test that corrupts a row and expects a throw); `InMemoryProfileStore`;
   seed profiles `astm-reference` + fictional `acme-chem-200` (a vendor
   whose O record swaps accession and sample-id — mis-associated under the
   reference profile, correct under its own).
3. ✅ Gateway pipeline honors profile layouts: `astmToCanonical(records,
   { layout })` canonicalizes by 1-based profile positions, defaulting each
   group to the reference layout (backward-compatible).
4. ✅ Conformance harness (`packages/core/src/conformance.ts`):
   `runConformance(profile, goldens)` replays recorded ASTM transcripts
   through the real pipeline and asserts the canonical payload per case,
   including negative cases.
5. ✅ Goldens library + CI gate: `goldens/reference.json` +
   `goldens/acme-chem-200.json`; `packages/core/src/goldens.test.ts` runs
   every golden file on every `npm test`/CI run and proves an Acme
   transcript fails under the reference profile (profiles matter).
6. ✅ Migration `0006_device_profiles.sql` + `PostgresProfileStore`; API
   `GET/POST/GET/DELETE /api/v1/profiles`; server seeds both profiles when
   the store is empty (memory and Postgres).
7. Tests: schema acceptance/rejection, layout canonicalization, conformance
   runner, goldens-in-CI, API CRUD, PG store round-trip + corrupt-row. Both
   suites green: `npm test` = 109 (97 pass / 12 DB-gated skip); `npm run
   test:db` = 109/109; demos clean in both modes.

Remaining M2 gate items (§8.1): security review; installer + remote update;
certified profiles for 3–5 **real** analyzers via the field/vendor conformance
program (workstream A6/K, gated on field access — risk R2); profile
**versioning** on change is already modeled (`version`, goldens per version)
but not yet enforced in the pipeline (A4 AdapterRegistry is future work).

---

## 14. Plan maintenance

---

## 14. Plan maintenance

- Version this document; record changes in a changelog section at the end.
- Milestones map to GitHub milestones/epics (suggested); each workstream becomes an epic
  with issues from its deliverables.
- Revisit quarterly: assumptions (A1–A6), decision log (D1–D10), risks (R1–R10).
- This plan intentionally leaves **product/commercial details** (pricing, naming,
  packaging) to the business owner; engineering gates are listed where they intersect.
