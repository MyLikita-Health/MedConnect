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
   The written boundary policy is **§7.5.5** (policy doc:
   [`docs/orthanc-agpl-boundary.md`](orthanc-agpl-boundary.md)) — the code-review
   gate for risk R5 references it.

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
- **Tenancy** (cloud): shared schema with `org_id`/`facility_id` columns + Postgres RLS.
  Default: one org per cloud instance (a cloud platform installation = one org, many
  facilities). Facilities are the tenant-level isolation boundary for RBAC and resource
  scoping; a user is bound to a facility and sees only that facility's devices/messages/
  routing. RLS enforces org+facility read/write isolation on every tenant-scoped table.
  Schema-per-tenant (D5 escalation): reserved for customers who require hard isolation
  (sovereign data, audit-isolation, specific compliance posture). When triggered, the
  migration path is org → separate shared-schema cluster (not per-customer per-table
  fragmentation), so the platform doesn't fragment into N copies of itself.
- **Edge → cloud sync**: outbox pattern — every local write to a tenant-scoped table also
  appends an outbox row (`outbox { table, pk, op, payload, acked, synced_at }`); the cloud
  sync worker reads unacked rows and marks them acked. No dual-write races. The edge's durable
  local queue is the outbox itself (PRD §21 local queues + §4.3 durable local queue) — the
  same rows the dispatcher's in-process delivery already targets today; cloud adds the sync
  worker that reads them when connectivity returns.
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
- D5 JS/TS SDK (`@integration-hub/api` → `HubClient`) wrapping orders/results/devices/webhooks
  (PRD §38): typed models mirroring the v1 OpenAPI contract, `apiKeyAuth`, retry with
  exponential backoff on 429/5xx, list pagination via `limit`, and the webhook create
  secret-echoed-once semantics. SDK smoke test drives a live in-memory hub end-to-end
  (health/version → devices → orders → webhooks create/list/update/test). Exit criterion:
  a reference LIS/EHR integration can be written against the SDK + OpenAPI surface alone.

Exit criteria: reference LIS/EHR integration completed in sandbox without our help;
webhook replay + signature verification tested; OpenAPI published; SDK ships with the API.

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
- G1 Local durable store + outbox; crash recovery (replay outbox on boot). The edge
  SQL store IS the durable outbox today (every committed message is on disk via
  `PostgresMessageStore`); M4 adds the explicit `outbox` table + cloud sync worker
  (decision D11) that reads unacked rows and ships them over the outbound-only secure
  channel, acking on success. The dispatcher seam is unchanged.
- G2 Edge watchdog/supervisor: restart policy, heartbeat, health file, disk/log
  rotation, safe shutdown (PRD §46).
- G3 Secure channel (TLS, client cert / device auth), outbound only (PRD §42);
  credential + profile rotation; signed update packages.
- G4 Sync protocol: message/clinical/audit delta sync with idempotency + conflict
  policy; bandwidth-friendly batching; sync status visible in console. Idempotency keys
  are the outbox row pk + logical table+op so a retry never duplicates a cloud write.

Exit criteria: kill -9 + power-cut tests lose zero committed messages; 48 h offline
soak then sync converges with no duplicates (idempotency keys); update applied
remotely and rolled back on failure.

### H. Cloud platform & multi-tenancy (Phase 3)

**Objective:** manage fleets of facilities/gateways from one place (PRD §35).

Preconditions (now resolved): D5 tenancy model = shared-schema + RLS, org-centric
(one cloud installation = one org, many facilities); facility is the RBAC + resource
isolation boundary. M0 schema already carries the null/default-tenant scaffolding
(`org_id`/`facility_id` on `devices` + `messages `, no RLS until M4). Edge-outbox/
cloud-queue swap = D11 (edge outbox = cloud sync outbox; cloud adds BullMQ worker).

Deliverables:
- H1 Org → Facility → Department hierarchy; users scoped per level; RLS enforcement.
  Bootstrap a cloud org + its first facility on install; facility_id is the isolation key
  on devices/messages/definitions. Users bound to a facility; admins can be bound across
  facilities in the same org. RLS policies on every tenant-scoped table (no policy before
  M4 — single-tenant edge mode). Two-tenant isolation is a test-suite gate (H1 exit).
- H2 Cloud console superset of edge console; fleet views: gateways, devices, messages
  aggregated; per-facility drill-down. Reuses the same ApiServer + stores behind a
  tenant-aware backend (every query filtered by the requesting facility unless admin).
- H3 Remote provisioning: gateway onboarding (pairing code/cert), profile push,
  updates (PRD §42, §63 marketplace-ready). Reuses the signed-update agent (G3/M2) for
  the update axis; provisioning is the pairing + profile-push + facility-link flow.
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

### 8.2a Windows desktop local deployment (decision D12 — parallel track)

- **Local edge DB shape resolved (D12):** SQLite + durable outbox for the single-machine
  Windows edge (no Docker, no separate DB service, single-file store under the app data dir,
  managed by the hub itself); PostgreSQL stays for the cloud/central side; in-memory stays
  as the test/dev fallback.
- **Local mode:** one hub, one box, one embedded store, one console — single-tenant edge by
  default; no Docker at install or run time; end-user first-boot config; optional imaging
  (bundled Orthanc as a separate Windows process, off by default, AGPL boundary unchanged:
  out-of-process, REST-only).
- **Network reach:** LAN analyzer/modal listeners + outbound to remote LIS/HIS/EMR (HL7 MLLP,
  HTTP/FHIR) with retry/DLQ; TLS on API + device endpoints optional.
- **Cloud later:** local-first, cloud-later by design; when paired, the local box becomes a
  cloud-connected edge via the H3 provisioning + secure-outbound-channel story (§7.G3),
  with the outbox as the sync basis and Postgres on the cloud side.
- **Sequencing:** start W1 (resolve D12 + SQLite edge backend behind the existing
  StoreBackend/DeviceBackend seams + prove a fully-local no-Docker run), then W2 (Windows
  service + installer skeleton + first-boot config UI), then W3 (imaging + LAN/network
  polish), then W4 (cloud-pairing readiness + Windows update delivery on top of the
existing signed-update supervisor). This track is parallel to M4 cloud, not a blocker.

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
| **M4** | 15–20 | **Cloud platform + developer surface** | Multi-tenant cloud (H1–H3); FHIR R4 (D1–D2); webhooks (D3); REST GA + sandbox (D4); SDK (D5); analytics/licensing hooks (H5); edge→cloud outbox sync (D11) | Reference vendor integrates via sandbox unaided; 2 tenants isolated (test-proven); edge sync converges after 48 h offline |
| **M5** | 21–26 | **Ecosystem & broader devices** | Marketplace + adapter packaging (L); certification program; OEM/white-label API; ECG/monitor/POCT profiles; MPPS/DICOMweb/IHE where demanded (PRD §58) | Distributor + OEM onboarded; 1 certified device added by partner; N connected-device metric compounding quarterly |

### 8.2 Sequencing principles

- **Do not start M3 imaging until M2 gate closes** (PRD §69: lab rock-solid first).
- Cloud (M4) work may begin *scoped* early (tenant columns + RLS in M0 schema) to avoid
  migration pain, but the cloud product does not gate lab revenue. The M0 schema already
  carries the null/default-tenant scaffolding (`org_id`/`facility_id` on `devices` and
  `messages`, migration `0001_init.sql`); RLS policies + the cloud-org bootstrap are the
  M4 arrival, per D5.
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
| D12 | Windows local edge DB shape | **RESOLVED (Windows desktop track)**: SQLite + durable outbox for the single-machine Windows edge (no Docker, no separate DB service, single-file store under the app data dir, managed by the hub itself); PostgreSQL stays for the cloud/central side. In-memory stays as the test/dev fallback. Other D decisions unchanged (D1 ORM/migrations, D3 first certified vendors, D4 edge hardware, D5 tenancy escalation, D6 cloud hosting, D7 HL7 parser — resolved, D8 licensing, D9 marketplace timing, D10 Orthanc bundled-by-default + customer-provided). |
| D3 | First certified vendors | depends on market/distributor access | M1 |
| D4 | Edge hardware baseline | mini-PC spec; OS support (Windows/Linux) | M1 |
| D5 | Tenancy model escalation | shared+RLS default; schema-per-tenant only if a customer demands hard isolation (e.g. sovereign-data, audit-isolation, or a compliance posture that won't accept shared storage). Rationale: PRD §35 wants fleet mgmt from one place, which is naturally a shared-schema multi-tenant model; the edge is single-tenant by design and RLS must arrive with cloud, not before. Escalation path (D5 here) records the threshold and migration shape so a later customer demand doesn't trigger a re-architecture. Resolved in favor of shared-schema + RLS for launch; schema-per-tenant remains a documented fallback. | **Resolved** (M4 cloud kickoff) |
| D6 | Cloud hosting | self-hosted vs hyperscaler; region (data residency) | M3 |
| D7 | HL7 parser lib selection | **RESOLVED — adopt `hl7v2` (panates, MIT)**: v1.9.0 + `hl7v2-dictionary` declared as deps of `@integration-hub/hl7` (B1/B2a shipped on it). Spike evidence (`packages/hl7/src/parser-substrate.test.ts`): parses ORU/ADT 2.3.1–2.5.1; dictionary-correct unescape + repetition reads; typed `HL7Error` on garbage, tolerant of truncated input; quirk — `toHL7String()` normalizes datatypes, so output is never byte-round-tripped (own model builds it). Runners-up rejected: `node-hl7-client`/-`server` (Node≥22, server-shaped, would duplicate our MLLP), `hl7` (amida) + `L7Node/hl7` dead. | **Resolved** (B kickoff) |
| D8 | Licensing/commercial model detail | per-facility vs device-based vs OEM (PRD §61) | M2 |
| D9 | Marketplace timing vs M5 pull | demand check with distributors | M4 |
| D10 | Orthanc bundled vs customer-provided default | **RESOLVED (M3.5) — bundled-by-default** (pinned multi-arch derived image for pilot/demo) **+ customer-provided supported**: `ORTHANC_URL` already points at any Orthanc (facility-managed, vendor appliance), so deployments that already run Orthanc ship none; the §7.5.5 AGPL boundary is identical either way (REST only). | **Resolved** (M3.5) |
| D11 | Edge durable queue / cloud queue swap | **RESOLVED (M4 cloud kickoff) — edge outbox = the cloud sync outbox, cloud adds a Redis+BullMQ worker**. The in-process dispatcher today writes to the edge SQL store (the edge-outbox shape, §4.2/§13.2); no recovery on restart yet. Cloud M4 adds (1) an explicit `outbox` table + write-through on the same local writes, and (2) a BullMQ worker that reads unacked outbox rows and ships them to the cloud platform over the outbound-only secure channel (PRD §42), acking on success. The dispatcher seam (`MessageSink` / `Dispatcher`) stays the same — BullMQ is a swap behind the existing delivery seam, not a rewrite. In-memory mode keeps the in-process delivery; PG mode with no cloud sync keeps the outbox as a no-op log until a sync worker is wired. |

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
  on restart yet (Redis+BullMQ swap keeps the same `Dispatcher` seam — decision
  D11). The outbox table that backs cloud sync is NOT yet a separate row; today the
  edge SQL store IS the durable outbox (every committed message is on disk). Cloud M4
  adds the explicit `outbox` table + sync worker (D11) behind the existing seam.
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

Remaining M2 gate items (§8.1): **security review** — shipped (§13.6);
**installer + remote update** — shipped (§13.7); **device → profile
binding** — shipped (§13.9); profile **versioning** enforcement — shipped
(§13.12); certified profiles for 3–5 **real** analyzers via the
field/vendor conformance program (workstream A6/K, gated on field access —
risk R2) remain.

### 13.6 M2 security review — API-key authn, per-role scopes, audit log: status

The security-review M2 gate item is implemented as a dedicated sprint and
shipped as `M2 security review: API-key authn + RBAC + audit log`. The v1
API is now **authenticated by default** with per-role scopes over every
route, and every mutating action lands in an **audit log** (PRD §30, §34).

1. ✅ Roles/scopes matrix + route table
   (`packages/api/src/security.ts`): roles `viewer` / `operator` /
   `engineer` / `admin` map PRD §34 personas onto scopes (read /
   review / operate / configure / admin); `ROUTE_SCOPES` maps every
   `/api/v1` route → scope and is **fail-closed** — an unscoped v1 route
   is denied until explicitly added (verified by a test that registers a
   route and expects 403).
2. ✅ API keys: only SHA-256 hashes stored; plaintext secret returned once
   at creation (`ihk_…`); `DELETE /api/v1/keys/:id` revokes (self-delete
   blocked); Fastify `preHandler` authn hook resolves the key on every
   request (except `/health`), records the principal on the request.
3. ✅ Audit log (PRD §30): every mutating action by an identified key is
   written (actor/action/route/result/ip/context + `actor` role at the
   time); denied attempts recorded; unauthenticated requests skipped (no
   principal to attribute). Read ops and the UI's static assets are not
   audited. Console exposes the log at `/api/v1/audit` and in the UI.
4. ✅ Migration `0007_security.sql` (`api_keys`, `audit_log`);
   `PostgresKeyStore`/`PostgresAuditStore`; in-memory equivalents for
   the scaffold default. Stores behind the `KeyStore`/`AuditStore`
   interfaces so Redis or a hardware vault can drop in later.
5. ✅ Bootstrap: server starts with auth enabled by default; on first boot
   with an empty store it generates an admin key and prints it (or honors
   `HUB_ADMIN_KEY=ihk_…`); `AUTH_DISABLED=1` opens the API for dev; CLI
   prints the key. Console: sign-in overlay storing the key in
   `sessionStorage`, `Authorization` header on every fetch, role badge in
   the masthead.
6. Tests: role/scope units, full authz matrix over the API (admin +
   each role hitting routes it may/may not touch, incl. anonymous 401),
   audit recording of allowed + denied actions, PG key/audit round-trip.
   Both suites green: `npm test` = 123 (109 pass / 14 DB-gated skip);
   `npm run test:db` = 123/123; both demos authenticated and clean.

Remaining M2 gate items (§8.1): **installer + remote update** — shipped
(§13.7); **device → profile binding** — shipped (§13.9); profile
**versioning** enforcement — shipped (§13.12); certified profiles for 3–5
**real** analyzers remain (gated on field access — risk R2).

### 13.7 M2 installer + remote update — Docker image, signed manifests, supervisor: status

The final M2 gate item is implemented and shipped as `M2 installer + remote
update: Docker packaging + signed updates with supervisor rollback`. It
satisfies §4.3's edge packaging goals (auto-start/supervision, crash
recovery, outbound-only signed updates) in the scaffold's terms, and the G
workstream exit criterion "update applied remotely and rolled back on
failure" is demonstrated end-to-end.

1. ✅ Installer unit: root `Dockerfile` + compose `hub` service — `npm run
   image:build` / `npm run up:stack` boots the whole product in Docker
   (Postgres-backed, migrations auto-applied, authenticated API, device
   listener). Verified live: health/version from the container.
2. ✅ Release identity: `HUB_VERSION` (env, default `0.1.0` in
   `packages/shared/src/version.ts`) surfaced on `/health` and
   `/api/v1/version` — the version axis updates compare and the UI shows.
3. ✅ Signed manifest format (`packages/core/src/updates/manifest.ts`): zod
   schema; canonical JSON (sorted keys, signature excluded); Ed25519
   keygen/sign/verify; sha256; dependency-free semver compare.
4. ✅ State directory (`updates/state.ts`): `current.json` / `desired.json` /
   `last-good.json` / `previous.json` / `history.jsonl` / supervisor
   heartbeat — version state survives restarts, no DB needed.
5. ✅ Update agent (`updates/agent.ts`): fetches the signed manifest from an
   https URL or local path (outbound only, PRD §42), verifies signature +
   platform + version-range policy vs the running release, stages
   apply/rollback into `desired.json`; rejections are recorded in history.
   Wired into the hub when `HUB_STATE_DIR` is set; console panel shows
   status/history, admin-only check/apply/rollback buttons.
6. ✅ Supervisor (`updates/supervisor.ts`): owns the hub child — crash
   watchdog with backoff, heartbeats, and the swap path: staged release →
   restart → **health gate** (probes `/health`, optionally the target
   version) → success records applied + last-good; gate failure auto-rolls
   back to the replaced release; runtime crash-loops past `maxRestarts`
   escalate to the previously-good release. Boots are serialized so restart
   races cannot reap each other's children (a real bug found by the tests).
   `npm run start:supervised` = supervisor + hub child.
7. ✅ Operator tooling: `scripts/update-cli.ts` (`hub-update keygen | sign |
   verify`), npm scripts `update-cli`, `start:supervised`, `demo:update`,
   `image:build`, `up:stack`.
8. Tests: manifest (canonical/sign/verify/tamper/semver), agent (policy,
   staging, previous-vs-last-good rollback), supervisor integration with a
   fake child (boot, apply swap, auto-rollback on failed gate, crash
   restart, crash-loop escalation), API authz for `/api/v1/updates/*`
   (admin-only `updates:manage`), health/version. Both suites green:
   `npm test` = 147 (133 pass / 14 DB-gated skip); `npm run test:db` =
   147/147; `npm run demo:update` runs the real hub under the supervisor
   through signed check → apply → v0.2.0 → rollback → v0.1.0.

Notes / honest limits: the scaffold's artifact kind is `payload` (a
version+env bundle the supervisor hands the process); production artifacts
swap the Docker image tag or checkout instead (kinds `tarball`/
`docker-image` are reserved in the schema). `npm start` without `HUB_STATE_DIR`
leaves the update endpoints reporting "not configured". Real fleet
provisioning/remote push is Phase 3 workstream H3.

### 13.8 TLS on the API + device endpoints: status

Shipped as `TLS: HTTPS API + TLS device listener with on-prem CA trust flow`
(J workstream "TLS everywhere", PRD §42/§45 — hardening, not a numbered gate
item). With `HUB_TLS_CERT`/`HUB_TLS_KEY` (PEM file paths) the hub
TLS-terminates **both** endpoints: Fastify serves HTTPS (console included)
and the ASTM gateway accepts TLS connections (`tls.createServer`; the
session/ENQ-ACK layer is transport-agnostic and works unchanged over
TLSSocket).

1. ✅ Credentials threading: `startHub` opts/env → `AstmGateway` + `ApiServer`
   (`TlsCredentials`/`ApiTls`); CLI reads the env vars.
2. ✅ On-prem material + documented trust flow: `npm run tls:gen`
   (`scripts/gen-certs.ts`) creates a facility CA + a hub cert signed by it
   with configurable SANs. README documents the flow: CA is the facility
   root of trust, import `ca.pem` into device/LIS trust stores, browsers/curl
   use `--cacert`, the supervisor probes the https health endpoint
   (self-signed skip via `HUB_TLS_VERIFY_PROBE`).
3. ✅ Supervisor https probe: `probeJson` via node:https honors
   `healthRejectUnauthorized` per request (global fetch has no TLS knob).
4. Tests: gateway ASTM-over-TLS end-to-end (trusted client completes a full
   ENQ/ACK session; untrusted handshake rejected) and API https (trusted
   health call; untrusted fails) against committed `test-fixtures/` certs
   with SAN localhost/127.0.0.1. Both suites green: `npm test` = 151 (137
   pass / 14 DB-gated skip); `npm run test:db` = 151/151; live check over
   generated certs confirmed trusted curl + TLS device handshake.

### 13.9 A4 AdapterRegistry seam — device → profile binding: status

Shipped as `A4: bind registered devices to DeviceProfiles by config`. The
registry-to-profile wiring the plan called "future work (A4 AdapterRegistry)"
is now real: a registered device carries an optional `profileId`, and the
gateway canonicalizes that device's stream with the bound profile's record
layout + code mappings.

1. ✅ Registry: `profileId` on `DeviceRecord`/`RegisterDeviceInput`
   (in-memory + `PostgresDeviceRegistry`); migration `0008` adds
   `devices.profile_id` → `device_profiles(id)` **ON DELETE SET NULL**
   (deleting a profile detaches devices instead of deleting them).
   Auto-registered wire devices keep their binding across reconnects
   (upsert only refreshes state/last-seen).
2. ✅ Gateway seam: `AstmGateway.resolveProfile` (`ProfileResolver`,
   `ProfileBinding` in packages/gateway) — per-message the gateway resolves
   the device's profile and canonicalizes with `layout` + merged mappings
   (profile overrides the global mapping table). Unbound devices keep the
   reference defaults. The gateway stays agnostic of stores.
3. ✅ Wiring: `startHub` closes over the device registry + profile store
   (`device.profileId → profileStore.get → defaultLayoutFor(profile)`).
4. ✅ API/UI: `POST /api/v1/devices` accepts + validates `profileId` against
   the profile store (400 on unknown); the console badges bound devices.
5. Tests: gateway binding proves the same wire bytes canonicalize correctly
   under the Acme profile and mis-associate under the reference layout
   (GLU→GLUCOSE mapping applied per-device too); API register/validate; PG
   store round-trip + FK rejection + detach-on-delete. Both suites green:
   `npm test` = 158 (143 pass / 15 DB-gated skip); `npm run test:db` =
   158/158.

Remaining M2 gate items (§8.1): certified profiles for 3–5 **real** analyzers
gated on field access (risk R2); profile **versioning** enforcement — shipped
(§13.12); adapter *packaging/ecosystem* (install - adapter flow, workstream L,
Phase 4) is out of M2 scope.

### 13.10 Console Device profiles section + stored conformance: status

Shipped as the console's Device profiles panel (workstream K surfacing):
list/CRUD profiles with certified-vs-draft badges and a per-profile golden
conformance view, backed by a new read endpoint that re-runs a *stored*
profile's current config against its recorded goldens.

1. ✅ Core (`packages/core/src/conformance.ts`): `loadGoldenForProfile` +
   `runStoredConformance` — golden files embed their profile, so the lookup
   matches embedded `profile.id` (the reference profile lives in
   `reference.json` even though its id is `astm-reference`), and the library
   directory resolves via `HUB_GOLDENS_DIR` (default: repo/image `goldens/`).
2. ✅ API: `GET /api/v1/profiles/:id/conformance` (`api:read`, 404 on
   unknown profile) — returns `available:false` when no golden records the
   profile (a draft, not a failure), else the full case-by-case run.
3. ✅ Console: Device profiles panel — name/id/manufacturer, certified
   (green) vs draft (amber) badge, version, per-profile conformance summary
   (passed ✓ n/m) expandable to per-case failures with the actual drift, a
   JSON view, and add/replace + delete (engineer/admin; delete warns that
   bound devices detach). Conformance results are cached per refresh cycle.
4. ✅ Packaging: `Dockerfile` copies `goldens/` so the endpoint works in the
   container.
5. Tests: loader unit (embedded-id lookup incl. the reference.json naming
   case; certified profiles pass; goldens-less profile reports unavailable;
   an edited-away layout fails its own transcripts) + API integration
   (auth/role matrix, stored-pass, no-goldens, 404). This caught a real
   drift: the seeded `REFERENCE_PROFILE` lacked the code mappings its own
   golden file was recorded under — the seed now equals its certified
   config, which is exactly the invariant the view enforces. Both suites
   green: `npm test` = 165 (150 pass / 15 DB-gated skip); `npm run test:db`
   = 165/165.

### 13.11 Key-rotation ergonomics (rename / disable / expiry / re-issue): status

Shipped as the key-lifecycle surface on top of the M2 security review (§13.6):
rename, disable-without-delete, expiry dates, and an audit-friendly re-issue
flow with a never-seen warning — in the console (Access keys panel) and a
`hub-key` CLI.

1. ✅ Model + stores (`security.ts` + `PostgresKeyStore`, migration `0009`
   adds `expires_at` + `secret_issued_at`): `KeyPatch` update (rename /
   enable / disable / set-or-clear expiry), `rotateSecret` (new secret for an
   existing key — id/name/role/status preserved, old secret revoked), expiry
   enforced at authn (`keyIsUsable`).
2. ✅ Never-seen tracking: `secretNeverSeen` compares `lastUsedAt` against
   `secretIssuedAt` so it is per issued secret — a key used for months, then
   rotated, counts as never-used again until the new secret authenticates.
   Both stores stamp on a **monotonic per-key clock** (never ties, never goes
   backward) so loopback same-millisecond bursts cannot corrupt the
   comparison — a real flake the tests caught.
3. ✅ API (`keys:manage`): `PATCH /api/v1/keys/:id` (future-only expiry; a
   lockout guard refuses disabling the key in use) and
   `POST /api/v1/keys/:id/rotate` returning `{key, secret, warning?}` — the
   warning fires when the outgoing secret was never presented. Mutations
   audit through the existing hook with the key as target; the secret never
   reaches the audit log or key listings.
4. ✅ Console: Access keys panel (admin only) — status badges, expiry, last
   use with a *never used* marker, copy-once boxes for created/rotated
   secrets, inline rename/disable/enable/expiry/re-issue/delete. Auth last-use
   stamps are now awaited (was fire-and-forget) so a follow-up rotate always
   observes the preceding use.
5. ✅ CLI: `npm run key-cli` (`scripts/key-cli.ts`) — list/create/rename/
   disable/enable/expiry/rotate/delete against `HUB_URL` + `HUB_API_KEY`;
   secrets print exactly once and the warning prints on rotate. Verified live
   end-to-end against a booted hub (self-disable refused, expiry on create,
   rotate revoked the acting key — subsequent calls 401'd until re-keyed).
6. Tests: store units (mem + PG round-trip) for rename/disable/expiry/rotate
   and per-secret never-seen semantics; API integration for the role matrix,
   lockout guard, past-expiry rejection, rotate warning + revocation + audit
   (the in-place-mutation bug — `before` read after `rotateSecret` — was
   caught and fixed). Both suites green: `npm test` = 173 (157 pass / 16
   DB-gated skip); `npm run test:db` = 173/173.

### 13.12 Profile version stamping + runtime drift enforcement: status

Shipped as runtime version enforcement on top of the A4 binding (§13.9): the
version axis the model always carried (`version`, goldens per version) is now
enforced — every message is stamped with the exact profile config that parsed
it, and messages parsed under a profile edited after its certification are
flagged instead of silently trusted.

1. ✅ Stamp (`CanonicalMessage.profile`, shared): `{id, version,
   certifiedVersion?, drift?}` — provenance for every parsed message,
   persisted with the message and preserved across replay.
2. ✅ Enforcement (gateway): `ProfileBinding` carries the profile identity;
   the resolver supplies `certifiedVersion` (the version the profile's golden
   transcripts were recorded under). When the stored version ≠ the certified
   version — an edit after certification, or a rollback — the message gets
   `drift: true` and a `FLAGGED` timeline entry naming both versions. Drift is
   an annotation, never a drop: results still flow, operators see it.
3. ✅ Wiring (`startHub`): the resolver now reads the golden file per profile
   (`loadGoldenForProfile`, cached per hub process — goldens are static per
   deploy) and returns id/version/certifiedVersion together.
4. ✅ Console: message list shows a red *⚠ drift* marker; the detail view
   shows the parsing profile badge with *matches certified vN* or the drift
   warning.
5. Tests: gateway matrix — clean stamp at the certified version, drift flagged
   when edited-away (v2 vs certified v1) and on rollback (v1 vs certified v2),
   no-drift-claim for profiles without recorded goldens, no stamp for unbound
   devices, replay preserves provenance. Both suites green: `npm test` = 179
   (163 pass / 16 DB-gated skip); `npm run test:db` = 179/179. Live e2e: a
   device bound to the seeded acme-chem-200 sent its wire bytes under stored
   v1 (clean stamp, GLU→GLUCOSE) and, after a POST upsert bumped the stored
   profile to v2, the same bytes arrived stamped `drift: true` with the
   FLAGGED timeline note.

### 13.13 Analyzer certification runbook: status

Shipped as the field-facing procedure that closes the last M2 gate item's
*input* gap (real-analyzer certification, risk R2):
[`docs/analyzer-certification-runbook.md`](../docs/analyzer-certification-runbook.md)
walks an on-site engineer end-to-end — session bring-up, transcript capture
via the message viewer (scenario checklist incl. negative cases), profile
authoring (layout offsets, mappings, the acme-style accession/sample swap),
golden authoring (partial `expected`, `expectIssues`), the CI gate
(`goldens.test.ts` under `npm test` / `npm run test:db`), promotion to
certified, device binding with the exact H-record id, live stamp verification
(`profile.drift` false), version-bump discipline, a troubleshooting table
(checksum NAK loops, HELD vs FAILED, drift) and a sign-off checklist
(≥3 transcripts/scenario, soak, soak report). It documents the milestone's
honest limits: `connection`/`session` profile fields (checksumIncludesStx,
frameNumbering, initiator) are modeled but not yet consumed by the codec — a
checksum-mismatch loop is a hard stop and a support case, not a config tweak
(workstream L / Phase 4 closes the seam).

Remaining M2 gate items (§8.1): certified profiles for 3–5 **real** analyzers
gated on field access (risk R2) only.

### 13.14 Profile-drift alerts: status

Shipped — the version-stamp sprint (§13.12) made drift *visible*; this makes
it *operational*: a bound device delivering under a profile whose stored
version drifted from its golden-recorded certification baseline now pages
operators instead of leaving red ⚠ markers to be noticed later.

1. ✅ Core: new `profile-drift` alert kind (`alert-store.ts`);
   `AlertService.profileDrift(event)` fires **once per device** on the first
drifted delivery (message names profile + both versions) and resolves on any
later non-drifted delivery (clean stamp, no-goldens binding, or device
unbound/detached). Per-device subject + existing open-alert/cooldown
semantics mean no per-message paging.
2. ✅ Gateway: `onDrift` seam (`DriftEvent`) emitted from `handleMessage` —
   `drift: true` with identity/versions on a drifted delivery, `drift: false`
   otherwise. The message itself keeps its stamp + `FLAGGED` timeline entry
   (annotation unchanged); the alert is the operational layer on top.
3. ✅ Wiring: `startHub` routes `onDrift` → `alerts.profileDrift` and seeds a
   default `profile-drift` rule (console channel, threshold 1) alongside the
   other seeded rules — delete the rule to mute. API `alertRuleSchema` accepts
   the kind; the console alerts panel shows it like any other rule (add a
   `webhook` channel + URL to page). PG needs no migration (`kind` is text).
4. Tests: core fire/resolve/no-re-fire/per-device-independence/threshold and
   subject-scoping/webhook payloads; gateway drift/clean/unbound/no-goldens
   event matrix; API kind acceptance. Both suites green: `npm test` = 184
   (168 pass / 16 DB-gated skip); `npm run test:db` = 184/184. Live e2e via
   `startHub`: stored acme v2 (edited post-certification) + bound ACME-1 →
   message stamped `drift: true` AND a FIRING `profile-drift` alert for
   ACME-1; second drifted delivery did not re-fire; restoring stored v1 +
   clean delivery resolved it (0 firing, RESOLVED in history).

Remaining M2 gate items (§8.1): certified profiles for 3–5 **real** analyzers
gated on field access (risk R2) only.

### 13.15 Workstream B — HL7 v2 lab engine: kickoff survey + status

**Status (B1–B3.3 + B2c shipped, Sept 2026).** The survey below (written
pre-build) mapped B onto this codebase; the inbound leg is real, the LIS
seam closes over the wire, and the outbound leg delivers results to a real
MLLP peer:

1. ✅ **B1 — MLLP framing + sessions + application ACK** (D7 parser adoption,
   framing/ACK, wire sessions): `@integration-hub/hl7` ships `MllpServer` /
   `MllpSession` (per-connection decode → `onMessage` → AA/AE/AR in message
   order, TCP or TLS), `MllpClient` (send + await ACK), `wrapMessage` /
   `MllpDecoder`, and `buildAck` (MSH^ACK, MSA-2 echoes the original
   control id). Parser decision **D7 resolved — `hl7v2` (panates, MIT)
adopted**, declared with `hl7v2-dictionary`; the spike's golden corpus
   (`parser-substrate.test.ts`) pins the substrate contract (ORU/ADT
   2.3.1–2.5.1, dictionary-correct unescape/repetition reads, typed
   `HL7Error` on garbage) and records the design constraint that
   `toHL7String()` normalizes datatypes — output is never byte-round-
   tripped through it.
2. ✅ **B2a — ORU^R01 → canonical translator** (`hl7ToCanonical`): PID/OBR
   (+ORC fallback)/OBX map to `LabPayload` mirroring `astmToCanonical`
   semantics (incl. code mapping + `originalTestCode`); any issue returns
   `payload: null` + reasons — never dropped. V1 limits documented: ORU-only
   triggers, single order group (multi-OBR flagged), no SPM so `sampleId`
   unset.
3. ✅ **B2b — inbound wiring** (`Hl7Gateway` in `@integration-hub/hl7`):
   MLLP in → raw parse (viewer records) → device id from the MSH sender →
   translate → dispatcher sink → ACK (AA on accept, AR + reasons when the
   content cannot be canonicalized but is still persisted FAILED, AE on a
   persistence failure). `startHub` starts it alongside `AstmGateway` when
   `hl7Port`/`HL7_PORT`/`--hl7-port` is set (opt-in), sharing the dispatcher
   sink, mappings, TLS and the device-state/device-offline alert seam.
   Simulator: `Hl7OruSimulator` + `npm run simulate:hl7`; `npm run
   demo:hl7` runs the full loop (register order → 2 matched + 1 stray ORU →
   HELD review → release → all ROUTED, AA acks). Dispatcher integration
   tests prove HL7 reaches ROUTED and resends are deduped exactly like
   ASTM.
4. ✅ **B3.1 — canonical → HL7 serializer** (`@integration-hub/hl7`
   `canonicalToOru` / `canonicalToOrm`): `LabPayload` → ORU^R01 (results to
   an LIS) and ORM^O01 (order download, §6.4). Wire text is built on our own
   message model — never round-tripped through `toHL7String()` (the D7
   constraint); OBX-5 values are escaped; multi-test ORMs emit one OBR per
   test; `OutboundOptions` covers MSH-3/4/5/6 + version + control id. The
   **round-trip oracle** (`serialize.test.ts`) feeds each generated ORU back
   through `hl7ToCanonical` and asserts the canonical payload matches — the
   inbound translator doubles as outbound conformance for free.
5. ✅ **B3.2 — `hl7` destination kind + config schema + migration**:
   `DestinationKind 'hl7'` + `Hl7DestinationConfig` (host/port + MSH
   fields) in core `routing.ts`; API zod schema (kind `hl7` requires the
   config — superRefine); migrations `0010_hl7_destinations.sql` adds the
   additive `hl7_config` jsonb column; in-memory + PG route stores
   round-trip it (API / routing / DB-gated tests). Route rules now select
   MLLP endpoints like any destination.
6. ✅ **B2c — inbound ORM^O01 order feed (the LIS seam)**: `hl7ToOrder`
   (`packages/hl7/src/order.ts`) extracts ORC-1 action → status (NW/RO →
   active, CA → cancelled, CM/OC → completed), ORC-3/ORC-2/OBR order id,
   PID-3 patient, SPM-2 sample (best-effort), and OBR-4 requested tests
   (mapped). `Hl7Gateway` gains an `orders` feed: when wired, ORM messages
   bypass the results pipeline entirely (orders have no results to deliver)
   and register the expected order before the AA ack (AR + reasons on
   translation failure, AE on registry failure). `startHub` wires the real
   `OrderRegistry` — matching (`/api/v1/orders`) is now fed by the LIS wire
   instead of manual `POST /api/v1/orders`. E2E proof
   (`packages/server/src/hl7-order-feed.test.ts`): ORM over MLLP registers
   the order and the matching ORU **ROUTED** with `MATCHED` (control: same
   ORU without the feed → HELD `UNMATCHED`). **ADT extension shipped**: the
   patient-admission feed (`hl7ToAdmission`, `packages/hl7/src/admission.ts`)
   translates ADT^A01/A04/A08 (admitted) and A03 (discharged) into an
   `AdmissionRegistry` (InMemory + PG `0011_adt_admissions.sql`) via the
   gateway's `admissions` seam, wired in `startHub` (`hub.admissions`) — the
   patient-side LIS master feed. E2E (`packages/server/src/hl7-adt-feed.test.ts`)
   against the real `startHub`: ADT → AA → registered (A03 flips status;
   garbage → AR). The registry is visible in the API + console:
   `GET/POST /api/v1/admissions` (api:read / config:write scopes) and an
   "Admissions" console panel.
7. ✅ **B3.3 — outbound delivery (first real outbound beyond HTTP)**: the
   Dispatcher gains an injected `deliver` seam (`DispatcherOptions.deliver`;
   core stays protocol-blind — the built-in handles console/http, anything
   else throws → retry → DLQ without one). `startHub` wires
   `deliverHl7` (`packages/hl7/src/deliver.ts`): canonical → ORU^R01
   (results) / ORM^O01 (order-only) via the B3.1 serializer → MLLP connect →
   await the application ACK — AA resolves (attempt OK), **AE/AR throw with
   the MSA-3 reason** → per-destination retry/backoff → DLQ (the reason
   surfaces in the timeline; never silently dropped). E2E
   (`packages/server/src/hl7-outbound.test.ts`): inbound ORU → route → mock
   LIS over MLLP → ROUTED; an AE-rejecting LIS → 3 attempts → FAILED/DLQ
   with the reason. `npm run demo:outbound` runs the live loop (hub +
   in-process mock LIS + destination/route + simulator → LIS received).
8. ✅ **B3.3 refinement — outbound connection manager**
   (`MllpConnectionPool`, `packages/hl7/src/connection-pool.ts`): one
   held-open MLLP connection per destination endpoint, reused across
   deliveries (LIS peers expect persistent sessions); a dying connection is
   detected on write and **replaced with a fresh one in the same attempt**
   (one retry), sockets idle-close after 30s, and `deliverHl7` now takes a
   shared pool (wired in `startHub`; closed on shutdown). Tests pin reuse
   (N messages, 1 connection), the replace-on-dead-peer path, and idle
   close — the documented "connection per delivery v1" refinement is now
   real.
9. ✅ **B4 — generalized HL7 profiles (segment-level layouts)**: a profile's
   `hl7` config (`Hl7RecordLayout` in shared, zod-validated in core) pins
   PID/OBR/OBX field+component positions (`patient.name` at PID-6, CE
   identifier at OBX-3^2 with a separate `testName` ref, ORC-anchored
   orders, `delimiters` stamped on a lying MSH-2 before parsing).
   `hl7ToCanonical` + `hl7ToOrder` read against a resolved layout
   (`defaultHl7LayoutFor` — defaults byte-identical to the generic
   translator, so unprofiled devices parse exactly as before); `Hl7Gateway`
   gains a `resolveLayout` seam from the MSH sender identity and `startHub`
   binds it to the device→profile store.   Vendor-variant tests cover each
   deviation (name-at-PID-6, code-component swap, ORC anchor, alternate
   delimiters, ORM PID-4/ORC-4) at translator, order-feed and gateway level.
   A **vendor-variant simulator mode** (`packages/simulator/src/hl7-variant.ts`,
   `npm run simulate:hl7 -- --variant <name> [--kind oru|orm]`) emits
   deterministic B4-deviant ORU/ORM transcripts; each variant ships the
   `Hl7RecordLayout` that decodes it, and the conformance-oracle tests pin
   that the generic parse fails/misreads while the layout yields the exact
   canonical payload. **Goldens-in-CI are live**: the six transcripts are
   recorded as `goldens/hl7-b4-vendor-variants.json` (the shared golden
   library, marked `protocol: HL7`; the core ASTM loader skips non-ASTM
   files), executed under `npm test` by the HL7 conformance runner
   (`packages/hl7/src/conformance.ts` + `goldens.test.ts`), with a
   simulator↔golden lockstep test (`hl7-goldens.test.ts`) that fails when
   the recorder drifts. The ADT patient-admission corpus
   (`goldens/hl7-adt-admissions.json`, kind `adt` → the `hl7ToAdmission`
   oracle) records the B2c feed contract the same way. Real vendor field
   transcripts replace the synthetic corpus under risk R2.
10. Test status: `npm test` = 313 (295 pass / 18 DB-gated skip); `npm run
    test:db` = 313/313.

Remaining B: nothing on the core roadmap — goldens-in-CI for real vendor
profiles arrive with field access (risk R2); the ADT patient-admission feed
and the vendor-variant simulator are shipped. Next phase: **M3 imaging &
DICOM via Orthanc** (kickoff survey: §13.16).

---

The survey below was written at kickoff, before any of the above shipped. B
was the biggest remaining Phase-1 capability: the platform spoke ASTM inbound
and HTTP/console outbound only — no MLLP framing, no HL7 parser/serializer,
and no translator anywhere in `packages/` (the `Protocol` union in
`message.ts`, the zod `device_profileSchema.protocol` enum, and this plan
were the only places HL7 existed). The good news from the codebase survey:
**everything downstream of canonicalization was already protocol-blind**, so
B is "build a sibling protocol layer mirroring `@integration-hub/astm` + two
new connection points", not a core rework. Survey findings, mapped onto the
B1–B4 deliverables:

**Reuse as-is (no changes needed).** The canonical model (`LabPayload` in
`packages/shared/src/model.ts`) maps 1:1 onto PID / ORC+OBR / OBX — the PRD
§67 invariant was built for exactly this. `ParsedRecord {type, fields}`
(`message.ts`) is segment-agnostic, so HL7 segments drop straight into the
message store, viewer and replay unchanged. `buildMessage()` is already
protocol-parameterized. Dedup → matching → validation → HELD → route →
retry/DLQ (`Dispatcher`, `packages/core`) consumes `CanonicalMessage` via
`MessageSink` and never inspects the wire protocol, so an inbound ORU^R01 that
reaches canonical form gets the full lifecycle, audit and alerting an ASTM
message gets today — including matching against the **expected-order registry
(the LIS seam)**. `DuplexLike` (`packages/astm/src/transport.ts`) means MLLP
framing works over TCP/TLS/serial/mocks without new transport code. The
retry/backoff/`destination-down` machinery and the PG `destinations` table
(`kind` stored as text) make a new outbound kind additive — no migration.
Profile binding, version stamping and drift alerts attach to any device that
delivers a message; an HL7 inbound peer is just a device with a profile.

**B1 — MLLP transport (small; new).** An MLLP frame codec (VT `0x0B` … FS
`0x1C` CR `0x0D` — an order of magnitude simpler than ASTM E1381 framing) plus
an inbound listener (mirror of `AstmGateway.handleConnection` → `AstmSession`
→ `onMessage`) and an outbound client. Distinct from ASTM: an
**application-ACK layer** (MSH-ACK accept/reject with error text); reject
reasons must surface in the message timeline/attempts and the UI, never
vanish.

**B2 — translators (the real work).**
1. `hl7ToCanonical(segments, profile)` — mirror of `astmToCanonical`:
   MSH→device identity, PID→patient, ORC/OBR→order, OBX→results (units, ref
   ranges, flags, statuses via the `ResultStatus` subset already in `model.ts`).
2. Inbound **ORU^R01** → pipeline → identical downstream path (results-up).
3. Inbound **ORM^O01 / ADT^A01/A04/A08** — these have **no canonical target
today**: the model is lab-payload-only, so this needs a decision (a patient/
order-focused canonical message kind, or — the scaffold-scoped option —
translating ORM directly into the **`OrderRegistry`**, today hand-filled via
`POST /api/v1/orders`). The latter closes the README's "wire it to a real LIS
master feed" gap and makes E6 matching real without new message plumbing.
4. **A parser.** The §3.2 decision matrix says *buy* a mature MIT/Apache lib.
   The open decision (log it as D-n): which lib, and whether `astm`/`gateway`
   staying zero-dependency means the lib dependency lives in a new package
   (recommended) rather than `gateway`.

**B3 — outbound (host-to-device / host-to-LIS).**
1. `canonicalToHl7` serializer: canonical → ORM^O01 (**order download** — plan
   §6.4; the `orders-down` capability exists in `DeviceCapability` but nothing
   sends today) and ORU^R01 (results to an LIS).
2. New destination kind `hl7` (host/port + sending-facility fields for
   MSH-4/6, segment variants) in the destination zod schema (`server.ts`) and
   `resolveDestinations`; the dispatcher's `deliver()` is the only other touch
   point — retries, attempts and DLQ are reused.
3. A small outbound **connection manager** (held-open MLLP sockets with
   reconnect) — the dispatcher treats delivery as stateless today (HTTP
   fetch), and MLLP peers expect persistent connections.

**B4 — HL7 profiles (genuine model surgery).** `DeviceRecordLayout` is
ASTM-position-shaped (1-based P/O/R field numbers) and cannot describe HL7
segment variants. B4 generalizes the profile "layout" to segment-level field
mapping (PID component for the id, delimiter overrides, OBX-5/6 quirks). This
is where the *current* profiles code needs extension rather than addition —
defer until a real vendor's variant requirements exist.

**Tooling to mirror (mechanical, pattern established):** an HL7 simulator
sibling to `AnalyzerSimulator`, golden files + a generalized
`runConformance` (today it imports `astmToCanonical` directly), an
`npm run simulate:hl7`/demo story, and e2e + DB-gated tests in the existing
suites.

**Two structural forks to decide first.** (1) **Package boundary**: a new
`@integration-hub/hl7` package (framing, parse/serialize, ACK, segment
layouts) mirroring `@integration-hub/astm` preserves the gateway's
zero-dependency layering; an `hl7/` dir inside `gateway` breaks it the moment
a parser lib is bought. (2) **Adapter registry vs. sibling gateway**: §6.1
wants a protocol-agnostic `AdapterRegistry`/`DeviceAdapter`, but today
`startHub` constructs an `AstmGateway` and profile resolution lives inside it.
Recommended: a sibling `Hl7Gateway` (MLLP server) sharing the resolver /
version-stamp / `onDrift` seams first — it gets B2 testable now — and
generalize to the §6.1 registry when a third inbound protocol (orders-down or
FHIR) actually arrives.

**Suggested sequencing.** (1) ✅ **done** — B1 + B2-inbound-ORU end-to-end
(`@integration-hub/hl7` framing/sessions/translator + `Hl7Gateway` in
`startHub`, `simulate:hl7`/`demo:hl7`, status above); (2) ✅ **B3.1 + B3.2**
**done** — serializer + `hl7` destination kind/config/migration; (3) ✅
**B2c done** — inbound ORM^O01 → `OrderRegistry` feed closes the LIS seam;
(4) ✅ **B3.3 done** — injectable `deliver` seam + `deliverHl7` (store-and-
forward to an MLLP LIS, `demo:outbound`) + the connection-manager
refinement (`MllpConnectionPool`: held-open sessions, reuse, replace-on-
death); (5) ✅ **B4 done** — generalized HL7 segment-level profile layouts
(`hl7` config in the profile schema, layout-aware translators, `resolveLayout`
gateway seam) with vendor-variant tests + a **recorded golden corpus in CI**
(the synthetic B4 transcripts above; real vendor transcripts replace them
under risk R2); (6) ✅ **ADT feed + API** — patient admissions registered from
ADT^A01 and visible at `/api/v1/admissions`. Each step keeps both suites
green (`npm test` / `npm run test:db`) and demo-able in memory and Postgres.

---

### 13.16 Workstream M3 — imaging & DICOM (via Orthanc): kickoff survey

**Objective** (plan §7.C, PRD Phase 2): X-ray/CT/MRI modality connectivity and
RIS/PACS interchange **without writing DICOM networking** — the §3.1/§3.2
decision is fixed: DICOM storage/worklist/forwarding is **delegated to Orthanc**
(adjacent AGPLv3 process driven over its REST API; never a hand-written Node
C-STORE stack — risk R6). The hub orchestrates: canonical imaging metadata,
routing rules, exception handling, the radiology console — exactly the layers it
already owns for lab. M2's gate has closed (B shipped; §8.2), so M3 may start.
Exit gate (§8.1): radiology pilot — order→MWL→store→PACS end-to-end, failure
drill passes, dual-domain console at one facility.

**What the lab engine already hands M3 for free** (the survey's value — most
of C1–C6 is composition, not new protocol work):

- **RIS/HIS order + patient feeds exist** (B2c + ADT extension): inbound
  ORM^O01 already lands in the `OrderRegistry` and ADT^A01 admissions in the
  admission registry — MWL generation (C2) reads orders from the registry; no
  new inbound protocol to build.
- **Outbound HL7 exists** (B3.1/B3.3): imaging status/order download back to
  the RIS/HIS reuses `canonicalToOrm` + `deliverHl7` to the `hl7` destination
  kind — §6.4's imaging leg is the existing outbound machinery.
- **The whole delivery pipeline is protocol-blind** (§3.3 invariant 1): study
  metadata + status events enter as `CanonicalMessage` envelopes and get dedup
  → match → HELD → route → retry → DLQ for free. The **imaging failure queue
  (C4) is the existing exception queue** + `dispatcher.release` replay.
- **Routing rules are data** (RouteStore): modality/department/accession rules
  for storage routing (C3) are new rules + a new destination kind, not new
  engine code.
- **Modality health = device state** (C4): Orthanc-registered modalities as
  devices → the existing device-state seam + `device-offline` alerting.
- **Console/API foundations**: ApiServer authn/audit/RBAC for the radiology
  console (C6); the in-memory/PG store duality for study metadata rows.

**Build list (new), mapped to slices:**

1. ✅ **M3.1 — `@integration-hub/dicom` module + canonical imaging shapes**
   (shipped): §6.2 phase-2 canonical additions in shared
   (`packages/shared/src/imaging.ts` — `ImagingPatient`, `ImagingStudy`/
   `Series`/`Instance` **metadata** + storage URLs, `ImagingRequest`, `ImagingPeer`;
   pixels never in the hub DB) and `DicomOrthancAdapter`
   (`packages/dicom/src/adapter.ts`, new workspace package): an Orthanc REST
   client — system/ping, list + canonical reads of patients/studies/series/
   instances, `POST /tools/find` study queries, modality/peer listing +
   C-ECHO health, store-to-peer/modality forwarding, delete — typed
   `OrthancError` on failures, Basic-auth + timeout options — plus the C1
   creation/runtime primitives `createDicom` (POST /tools/create-dicom) and
   `configureModality` (PUT /modalities/{name}). Tested against a mock
   Orthanc HTTP server (11 cases) and **live against a real Orthanc
   container**: compose gains an `orthanc` service (adjacent AGPL process,
   REST at host 8042) and `npm run demo:dicom` drives the full adapter
   round-trip — create a CT study from DICOM tags → find/get canonical
   metadata → walk to instances → live C-ECHO via a self-registered
   modality → cleanup. MWL worklist sync (C2) is the next slice on the same
   substrate.
2. ✅ **M3.2 — MWL workflow (C2)**: order registry → Orthanc worklist,
   hub polls for performed studies (poll v1; MPPS stays an M5 refinement
   per §8.1). The adapter gains the Worklists-plugin REST surface —
   `createWorklistItem` (POST /worklists/create from DICOM tags),
   `listWorklistIds` / `getWorklistItem`, `deleteWorklistItem` — and
   `packages/dicom/src/worklist.ts` ships `MwlOrder` + `orderToWorklistTags`
   (AccessionNumber, PatientName/ID/DOB, requested procedure + protocol
   name) and the `WorklistService`: `sync` is idempotent per accession
   (create only when absent), `pollPerformed` returns studies whose
   accession matched the synced set, and cleanup deletes the item once
   performed. Tested against a shared mock Orthanc HTTP server (create,
   idempotent re-sync, performed → item deleted, error paths).
   **Live MWL runs against real Orthanc**: the compose `orthanc` service is
   now a derived image (`docker/orthanc/Dockerfile`) that adds the new
   REST-based Worklists plugin (orthanc-server/orthanc-worklists, AGPLv3+,
   prebuilt release pinned to 0.9.2 — the stock image ships only the legacy
   folder-based sample, which is removed here since both plugins read the
   same `Worklists` config section). The plugin is enabled DB-backed via a
   merged config file (`worklists.json`, folder-mode startup) and
   `npm run demo:dicom` drives the whole M3.2 loop live: sync → idempotent
   re-sync → modality stores the performed study → poll retires the item.
   **The monitor is wired into startHub** (`packages/server/src/mwl-monitor.ts`)
   behind `ORTHANC_URL` (opts.orthanc / env, `MWL_POLL_MS` cadence, default
   60s): each cycle pushes the order registry's active orders onto the
   worklist, joins the patient name from the admission registry, retires
   performed studies and never re-syncs them, and surfaces everything on
   `hub.mwl` (status + observed performed studies; serialized polls so a
   slow sync can't double-create). The wiring is pinned by 5 server tests
   against a mock Orthanc (idempotent sync, performed → retired → no
   re-create, absent without config, ORTHANC_URL alone enables it, error
   resilience) and `npm run demo:mwl` proves the loop through the real hub
   against the live container. **Orthanc reachability is alerted** (workstream
   I): consecutive failed polls raise a new `orthanc-down` alert kind
   (subject = the Orthanc base URL; threshold 3 seeded by default, console
   channel — add a webhook channel to page), and any successful poll resolves
   it — pinned by core alerts tests + a server test driving startHub against
   a mock Orthanc that fails then recovers. Remaining C5 packaging (still
   M3.5):
   source-built plugin for ARM64 hosts and version pinning/upgrade of the
   derived image.
3. ✅ **M3.3 — Storage routing (C3)**: performed-study metadata + status
   flow through the dispatcher with DB-driven routing rules, and the hub
   drives Orthanc peer forwarding to PACS/archive. Two legs:
   - **Metadata leg** — `hub.mwl` gains an `onPerformed` seam (the monitor
     retires an accession only after routing succeeds, so a failure leaves it
     re-syncable and re-routable — never a lost study event). Each performed
     study becomes a hub message (envelope `imaging` field: canonical study
     metadata + storage URLs; pixels never enter the hub) recorded by a
     SECOND gate-free `Dispatcher` over the same store/dedup/routes — imaging
     events are not lab results (no E6 matching, no E5 validation) but they
     dedup (stable per-study raw → a re-observation is DUPLICATE), follow the
     DB-driven `RouteStore` rules (console/http built-ins; an `hl7`
     destination throws → retry → DLQ, since imaging has no HL7 v2 form),
     and land ROUTED/FAILED in the same viewer as lab messages. Wired as
     `hub.imaging` in startHub. **PG persistence**: the `imaging` field rides
     in its own jsonb column on `messages` (migration `0012_imaging_messages`,
     parallel to `payload`) — without it the PG store silently dropped the
     study event on write/read. Pinned by a DB-gated pg-store round-trip test
     and a live drive of the full chain against Postgres (ORM over MLLP →
     order registry → worklist → performed study → ROUTED message read back
     with `imaging` intact, visible at GET /api/v1/imaging).
   - **Pixels leg** — the adapter rounds out the C1 forwarding primitives
     with `configurePeer` (PUT /peers/{name}); `storeToPeer` is corrected to
     the peer endpoint's wire shape (plain resource-id array, vs the modality
     C-STORE object array). With `ORTHANC_FORWARD_PEER` set, the monitor's
     onPerformed also forwards each performed study Orthanc→peer.
   - **Proof**: 5 server tests (console ROUTED, dedup on re-observation,
     http-rule delivery to a webhook, hl7 → DLQ, gateway absence) + the live
     `npm run demo:routing` against TWO real Orthanc containers — the compose
     stack gains a `pacs` archive service — order → worklist → performed →
     webhook receives the study event (ROUTED) AND the archive Orthanc
     receives the study. Cleanup leaves both empty.
   - **Operator surface** — `GET /api/v1/mwl` (monitor status + live
     worklist; 404 when Orthanc isn't configured) and `GET /api/v1/imaging`
     (performed-study messages by status — ROUTED/DUPLICATE/FAILED — from
     the store; both `api:read`). Operators watch worklist sync + study
     routing without console logs.
4. ✅ **M3.4 — Failure handling + radiology console (C4/C6)**: failed studies
   get a real replay path. `Dispatcher.retry(id)` requeues a dead-lettered
   (FAILED + dlq) message under the CURRENT route rules — no dedup wall (a
   requeue is operator-initiated, unlike `record`), the DLQ marker clears on
   requeue (store `MarkFields.clearDlq`, memory + PG) and a still-broken
   destination re-DLQs with a fresh attempt budget. Exposed as
   `POST /api/v1/messages/:id/retry` (messages:write; 409 when not DLQ'd),
   wired in startHub to the right dispatcher by message kind — imaging
   messages are hub-originated with no records to re-canonicalize, so they
   retry through the imaging dispatcher (`hub.imaging`) rather than the lab
   gateway replay. The console (ui.ts) gains the radiology panels — Orthanc
   worklist (status + live items) and performed-study routing (per-status
   counts + Retry on FAILED rows), hidden when ORTHANC_URL is off — and a
   FAILED message detail shows “Retry from DLQ” instead of the lab-only
   replay. Pinned by core dispatcher tests (retry routes after a rule fix,
   non-DLQ rejected, re-DLQ on persistent failure), a DB-gated PG test
   (dlq_at actually clears in the row), a server test through the real API
   (DLQ'd study → rule fixed → retry → webhook ROUTED), and the UI smoke.
   C6 now closed by two follow-ons: **study → detail routing view** — clicking
   an imaging-study row opens the message-detail route as the full routing
   view (canonical study metadata — accession, Study UID, storage link into
   Orthanc — beside the routing outcome: status, destination(s), routing
   timeline, DLQ retry) — and **Orthanc health as a device**: every monitor
   poll outcome flips the `orthanc` device row (protocol DICOM · transport
   api) connected/disconnected + bumps lastSeen in   the SAME device-state
   registry the wire gateways auto-register into, so the Devices panel shows
   the imaging server's health like any modality (PRD §32–33).
   Modality-level health ships the same way: a ModalityMonitor
   (C-ECHO every MODALITY_POLL_MS, default 30s) lists the DICOM modalities
   Orthanc has configured and probes each — every outcome flips that
   modality's device row (protocol DICOM) and feeds the existing
   device-offline alerting, so the Devices panel tracks the whole modality
   list, and rows auto-drop when a modality is removed from Orthanc's config
   (registry remove added to both the memory + PG backends). A down Orthanc
   (list failure) reports nothing and the last-known rows stand.
5. ✅ **M3.5 — Orthanc lifecycle (C5)**: version-pinned, multi-arch packaging
   + the written AGPL boundary + decision D10 resolved. The derived image
   (`docker/orthanc/Dockerfile`) now pins **`orthancteam/orthanc:26.8.2`**
   (the multi-arch ops image — amd64 **and** arm64 — replacing the
   amd64-only `jodogne/orthanc:latest`) and **source-builds the worklists
   plugin 0.9.2 inside the same Ubuntu base** (the plugin's prebuilt release
   binaries are Ubuntu x86_64 only, so arm64 requires the source build; the
   plugin .so is built with `STATIC_BUILD` so it embeds the framework's own
   DCMTK/jsoncpp and never conflicts with the runtime image's shared libs).
   The compose `pacs` archive service is pinned to the same multi-arch base.
   Upgrades are a one-line bump (`ORTHANC_BASE_IMAGE` /
   `WORKLISTS_VERSION`) + rebuild. The **AGPL boundary policy is written**
   at §7.5.5 ([`docs/orthanc-agpl-boundary.md`](orthanc-agpl-boundary.md)):
   Orthanc/plugins stay separate processes driven over REST — the derived
   image's bundled plugin is loaded by the Orthanc process, never the hub;
   review-gate checklist + distribution obligations + the D10 customer-
   provided path. **Decision D10 resolved**: bundled-by-default (the pinned
   derived image for pilot/demo) **and** customer-provided Orthanc supported
   (`ORTHANC_URL` already points at any instance; the boundary is identical
   either way). Verified live: the image builds natively on **arm64** (this
   host), boots, and the worklists REST API round-trips (create/list/delete)
   on both the standalone image and the rebuilt compose stack.

**Decisions & risks carried forward**: D10 **resolved** (bundled default +
customer-provided via ORTHANC_URL — see M3.5 above); R6 enforced by the §3.2
matrix (no Node DICOM stack); AGPL boundary kept by the separate-process
compose pattern (invariant 7) + the written §7.5.5 policy; DICOMweb via
Orthanc's plugin stays M5 (§8.1). Simulators (workstream K): a DICOM
simulator = Orthanc + a fake modality (pynetdicom or Orthanc's own tools)
driving order→MWL→store→route with failure injection — the M3 exit drill.

**Sequencing & gates**: M3.1 adapter+shapes (✅ shipped) → M3.2 MWL
(✅ shipped) → M3.3 storage routing (✅ shipped) → M3.4 console+failure
(✅ shipped) → M3.5 packaging (✅ shipped) → **M3 exit drill (✅ shipped,
workstream K)** → §8.1 radiology-pilot gate closes M3. Every slice keeps
`npm test` / `npm run test:db` green.

6. ✅ **M3 exit drill — real DICOM networking end-to-end (workstream K)**:
   `scripts/dicom-modality/fake_modality.py` — a pynetdicom AE that stands in
   for a real scanner (C-ECHO, MWL C-FIND, C-STORE; `--refuse` for
   modality-side storage failure), plus `npm run demo:m3-exit`
   (`scripts/demo-m3-exit.ts`) driving the full chain against the live
   compose Orthanc: **ADT^A01 → ORM^O01 over MLLP → MWL sync → modality
   C-FIND → C-STORE (performed study) → hub poll routes the study metadata
   through the dispatcher**. Failure injection, both proven live:
   (A) modality killed → Orthanc C-ECHO fails → device row flips to
   `disconnected` + `device-offline` alert fires; restart resolves both.
   (B) a routing rule pointing at a dead `hl7` destination → delivery fails
   → **FAILED + DLQ** → rule fixed → operator retry → ROUTED, DLQ marker
   cleared. Two fixes the live drill surfaced: `find_mwl` sends empty
   (return) keys, not `"*"` (Orthanc's matcher requires the tag to exist
   on the item — silent C-FIND misses otherwise), and the imaging dispatcher
   now shares the results dispatcher's outbound-HL7 deliverer (M3.3 rules
   can target `hl7` destinations like any other). Cleanup leaves Orthanc
   pristine (modalities/patients/worklists emptied). Prereq: `docker compose
   up -d --build orthanc` + `.venv/bin/pip install pynetdicom`.

**Status: M3 fully shipped through the exit drill (M3.1 → M3.5 + drill)**;
**M4 started — workstream D, D2 first** (the B3.1 pattern: pure two-way
translator + round-trip oracle tests before any wiring).

7. ✅ **D2 — canonical ↔ FHIR R4 translator** (`@integration-hub/fhir`,
   `packages/fhir/src/translate.ts`, 8 oracle tests): canonical → FHIR
   (Patient, ServiceRequest, DiagnosticReport, Observation-per-result,
   ImagingStudy, Device — the D1 resource set) and FHIR → canonical,
   proven by round-trip identity tests. Standards choices: interpretation
   carries the raw **v2-0078 abnormal-flag code** (lossless), status maps
   F/P/C/X/I/D bijectively (S/A collapse to `preliminary`), numeric values
   become `valueQuantity` incl. comparator ranges (`>200` → comparator),
   non-numeric ride `valueString`, ref-range "a-b" → low/high, name
   "Last, Given" → family/given, order accession/sample → typed ServiceRequest
   identifiers, ImagingStudy storage URLs ride extensions (pixels never in
   the hub). Documented v1 limits: multi-test orders carry the primary test
   on ServiceRequest.code, pure numeric formatting normalizes (`95.0`→`95`),
   imaging series ids / device transport have no R4 home. Next: D1 REST
   imaging series ids / device transport have no R4 home. Next: D1 REST
   surface (`/fhir` routes serving these resources from the stores).

8. ✅ **D1 — FHIR R4 REST surface** (`packages/api/src/fhir.ts`, 7 route
   tests): `GET /api/v1/fhir/metadata` (CapabilityStatement), `GET
   /api/v1/fhir/:type` (searchset Bundle, `?_id=` filter) and `GET
   /api/v1/fhir/:type/:id` (single resource; unknown type/id → FHIR
   OperationOutcome 404) for Patient / ServiceRequest / DiagnosticReport /
   Observation / ImagingStudy / Device. Resources project live from the
   stores — lab messages → the D2 resources, imaging messages (M3.3) →
   ImagingStudy, device registry → Device — with NEWEST-message-wins on
   duplicate resource ids (a corrected re-send supersedes the earlier one).
   Mounted under `/api/v1` so FHIR inherits key auth: every route is
   `api:read` in ROUTE_SCOPES (viewer-and-up), responses carry
   `application/fhir+json`. A FHIR client points its base at
   `<hub>/api/v1/fhir`. v1 limits: read + search only, `_id` is the only
   search param.

9. ✅ **D3 (slice 1) — signed webhook event bus engine**
   (`packages/core/src/event-bus.ts`, 5 tests): the domain-event catalog
   (result.received/validated/failed, order.received,
   device.connected/disconnected, message.failed) with typed envelopes
   (id = idempotency key, occurredAt, source, data). Delivery POSTs are
   HMAC-SHA256 signed per-subscription secret →
   `X-IntegrationHub-Signature: sha256=…` + `X-IntegrationHub-Event`/
   `-Event-Id`/`-Timestamp` headers; `verifyWebhookSignature` (constant-time)
   exported for receivers/tests — the D exit criterion "signature verification
   tested" is asserted. EventBus: fire → enabled matching subscriptions only,
   per-subscription retry policy, attempt-level delivery log, envelope
   retention (bounded) and **replay** that re-sends the SAME signed body +
   event id (consumer dedupe). Wiring-free by design (the D2/B3.1 pattern).
   Next (D3 slice 2): wire real fire points in `startHub` (message recorded/
   failed, device state flips, order registered) + webhook-subscriptions
   REST surface + console, reusing this engine.

10. ✅ **D3 (slice 2) — webhook fire points wired into `startHub`**
   (`packages/server/src/index.ts` + `packages/server/src/webhooks.test.ts`,
   2 e2e tests, 353 total): the bus (always present — zero subscriptions =
   fire no-ops, so wiring is free) now fires at the hub's real seams. A new
   `DispatcherEvents.onRecorded` (fired after dedup — duplicates stay
   silent) maps to `result.received` for lab payloads; the shared dispatcher
   `onDlq` fires `message.failed` for EVERY DLQ (lab + imaging, so
   `message.failed` = "any message reaching FAILED/DLQ" as catalogued) plus
   `result.failed` for lab results; gateway device flips fire
   `device.connected/disconnected` (ASTM + HL7 wire seams AND the Orthanc
   poll + modality C-ECHO device rows, protocol DICOM); the HL7 ORM feed
   fires `order.received` when it registers an expected order. Deliveries
   are fire-and-forget (the bus retries internally, never throws — a slow
   subscriber can't hold the message pipeline). Hub opts gain `webhooks:
   { subscriptions, source }` (tests/demos seed; runtime management is slice
   3's REST surface) and `hub.webhooks` is exposed. E2e proof drives a real
   MLLP session: ORM → device.connected + order.received (id ACC-424242,
   tests [GLUCOSE]), matching ORU → result.received → ROUTED, rule → dead
   HTTP destination → message.failed + result.failed carry the SAME
   messageId and the store row lands FAILED + dlqAt; socket close →
   device.disconnected. Every captured delivery is verified end-to-end:
   HMAC signature checks against the raw body with `verifyWebhookSignature`
   and the X-IntegrationHub-Event/-Event-Id/-Timestamp headers match the
   envelope. Deferred to slice 3: the manual `POST /api/v1/orders` fire
   point + webhook-subscriptions REST surface + console.

11. ✅ **D3 (slice 3) — webhook-subscriptions REST surface + console**
   (`packages/api/src/webhooks.ts` + `webhooks.test.ts`, 5 route tests;
   `ui.ts` Webhooks panel; 359 total): `/api/v1/webhooks` — GET
   subscriptions (secret never re-sent), POST create (secret echoed exactly
   once — generated when omitted; API-key pattern), PATCH / DELETE by id,
   GET deliveries (?limit=), POST deliveries/:eventId/replay (200
   {attempted} when re-attempted, 404 for unknown events), POST test (fires
   a synthetic signed ping through the REAL bus — returns {id, matched},
   with a note when nothing matches). Reads are `api:read`, mutations
   `config:write` (engineer+); the ROUTE_SCOPES table stays fail-closed.
   startHub passes its live bus into ApiServer (subscriptions managed at
   runtime; still in-memory on the bus — PG persistence remains a
   documented deferral). Console: a Webhooks panel in the left column —
   subscription table (events chips, enable/disable, delete; actions hide
   below engineer), add form (events = '*' or a comma list; secret blank =
   generate + copy-once), test ping, and the delivery log with a ↩ Replay
   button per failed delivery. Test coverage: CRUD + secret-once semantics,
   validation 400s, test-ping signature verification against the captured
   body, deliveries + replay (down → 200 {attempted} → fix → same event id
   re-sent → delivery flips ok), and auth scoping (viewer reads 200 /
   writes 403; engineer writes 201; anonymous 401). Deferred: PG
   persistence + the manual `POST /api/v1/orders` fire point.

12. ✅ **D3 (slice 4) — PG-persisted webhook subscriptions**
   (`packages/core/src/pg-webhooks.ts` + `pg-webhooks.test.ts`, 4 DB-gated
   tests; `packages/api/migrations/0013_webhook_subscriptions.sql`;
   `event-bus.ts` store seam; 363 total): the bus gains an optional
   `WebhookSubscriptionStore` (list/upsert/remove). With a store attached
   (startHub passes `PostgresWebhookStore` whenever a pool exists) the bus
   loads subscriptions at boot (`EventBus.ready`, awaited in startHub) and
   writes through on every add/update/remove — subscriptions now survive
   hub restarts in PG mode, closing entry 11's deferral. The REST surface
   awaits the now-persisting calls; without a store the bus behaves exactly
   as before (synchronous, in-memory). Rows are JSONB payloads with zod
   read-back validation (pg-profiles pattern) — a corrupt row fails loudly
   on load, and the bus never throws at boot (store failure logs + seeds
   stay live). Tests: store round-trip (upsert/list/remove, secret
   persisted server-side, same-id overwrite), the restart proof (bus A
   writes → fresh bus B on the same store sees them → removal through B is
   seen by bus C), corrupt-row rejection, and unchanged no-store behavior.

13. ✅ **D3 (slice 5) — manual `POST /api/v1/orders` fire point**
   (`packages/api/src/server.ts` + `webhooks.test.ts`, 364 total): the
   manual LIS-order registration now fires `order.received` — the SAME
   envelope shape as the HL7 ORM feed (`orderId/patientId/sampleId/tests/
   status`; only the source differs: `hub:api` vs `hub:<host>`), so
   subscribers can't tell the manual POST and the wire apart. Fire-and-forget
   like every fire point (the bus retries internally, never throws). Test:
   POST an order → it lands in the registry AND a signed `order.received`
   delivery reaches the subscription (HMAC verified, shape asserted). This
   closes the last D3 deferral — the webhook event bus is fully wired:
   engine, fire points, REST surface, console, replay, PG persistence.

14. ✅ **D4 — REST API v1 GA + OpenAPI spec + sandbox** (`packages/api/src/openapi.json`,
   `scripts/demo-sandbox.ts`, 364 total): the full v1 API surface (~50 routes)
   is documented as an OpenAPI 3.1 spec served at `GET /api/v1/openapi.json`
   (public — no auth required, so developers discover the API without a key).
   Every route is documented with request/response schemas, auth requirements,
   and tags (Health, Messages, Queue, Devices, Profiles, Routing, Alerts,
   Orders, Admissions, Imaging, Results, Webhooks, FHIR, Security, Updates).
   The sandbox script (`npm run demo:sandbox`) starts the hub, seeds a rich
   demo dataset (profiles, devices, orders, admissions, destinations, routes,
   alert rules) via the API, sends simulator messages through the full
   pipeline, and prints a curl-based walkthrough of every endpoint — enough
   for a reference LIS/EHR vendor to integrate without our help.

### 13.17 M4 cloud platform — D11 sync + H2/H3/H4/H5 fleet surface: status

Shipped September 2026 — the remaining M4 workstreams after D1–D5 and H1:
the edge→cloud outbox sync (D11/G4), gateway provisioning (H3), fleet
aggregation (H2), platform ops (H4) and commercial hooks (H5). The cloud
dependency `sync:write` is gateway-credentials-only — no user role holds it
(admin included), enforced by the preHandler split in `server.ts` and pinned
by the security matrix test.

1. ✅ **D11 — edge→cloud outbox sync** (decision D11: the edge outbox IS the
   cloud sync outbox; the `Dispatcher` seam unchanged). Migration
   `0015_cloud_sync_outbox.sql` ships BOTH sync roles: `outbox` (edge — the
   write-through log) and `ingest_ledger` (cloud — PK `(facility_id, seq)`,
   the idempotency key). `PostgresOutbox` implements `OutboxReader` (unacked
   FIFO + `markAcked(throughSeq)`) + `OutboxWriter`; `PostgresIngestStore`
   applies batches as whole-row message/device upserts, claims the ledger
   slot first (ON CONFLICT DO NOTHING), and reports the highest seq actually
   applied — a redelivered batch is a truthful no-op. Write-through is the
   no-dual-write invariant: `PostgresMessageStore.record` appends the sync
   entry in the SAME transaction (message `mark` and device register/upsert
   follow, best-effort so sync can never fail a lifecycle transition).
   `OutboxSyncer` (`packages/core/src/outbox.ts`) ships batches to
   `POST /api/v1/sync/ingest` over the outbound-only channel (PRD §42 —
   `x-hub-gateway` + Bearer gateway key), tolerates outages (backlog grows,
   pipeline never blocks) and drains on stop. startHub wiring: `cloudSync`
   opts or `HUB_CLOUD_URL`+`HUB_GATEWAY_ID`+`HUB_GATEWAY_KEY` (the H3 bundle's
   values) enable the syncer; PG stores get the outbox + tenancy stamps.
   Cloud ingest: `PostgresIngestStore.applyBatch` behind the ingest route.
2. ✅ **H3 — gateway provisioning**: pairing flow with the exact-once
   semantics throughout. Cloud admin registers a gateway (`POST
   /api/v1/fleet/gateways`) → pairing code `ihp_…` shown once (hash-stored,
   15-min TTL); the edge claims it (`POST /api/v1/provision/claim`, PUBLIC —
   the code IS the credential; 410 expired, 409 consumed) → gateway flips
   `active`, mints its API key `ihk_gw_…` (shown exactly once, hash-verified
   with timing-safe compare), and receives the provisioning bundle: gateway
   identity, cloud URLs, org/facility tenancy stamps and the facility's
   device profiles (config-first §6.3). Revoke (`POST
   /api/v1/fleet/gateways/:id/revoke`) kills the credential. Gateway keys
   authenticate ONLY the ingest route — fleet data is unreachable with them.
3. ✅ **H2 — fleet aggregation**: `GET /api/v1/fleet/overview` joins
   per-facility stats (messages / devices / connected via the tenancy stamps
   the stores now write) with facility rows and totals; `GET/POST
   /api/v1/facilities` manages the org's facility list. Console: a Fleet
   panel (facilities table + gateway table with live sync seq + revoke),
   shown only when the fleet surface is mounted.
4. ✅ **H4 — platform ops**: feature flags (`FeatureFlagStore`, facility-
   scoping optional) and per-facility quotas (`messagesPerDay`, `maxDevices`)
   as DATA not code (§3.3 invariant 3) — `GET/PUT/DELETE
   /api/v1/platform/flags|quotas`.
5. ✅ **H5 — commercial hooks**: `LicenseRecord` (tier trial/standard/
   enterprise, state, expiry, optional facility coverage) +
   `evaluateEntitlement` (tier → feature gates: cloudSync/imaging/
   multiFacility); `GET /api/v1/licenses/:facilityId/entitlement` is the
   check the edge + API consume; `GET /api/v1/analytics/export` produces the
   §2 success-metric shape (connected facilities/devices, message volume).
6. ✅ **H1 completion — tenancy write-through**: the deferred seam from the
   H1 test ("the message-level org/facility write-through is the D11 seam
   that lands next") is closed: `tenancy` on the PG stores stamps every
   device + message row in cloud mode; `CanonicalMessage` and `DeviceRecord`
   carry optional `orgId`/`facilityId`; the sync entries ride the stamps so
   the cloud routes them without extra context.
7. Tests: outbox syncer unit suite (ship/ack/failure-keeps-backlog/
   redelivery/stop-drain, `packages/core/src/outbox.test.ts`), PG-gated
   edge→cloud convergence round-trip incl. the (facility, seq) idempotency
   and per-facility isolation (`packages/api/src/pg/pg-outbox.test.ts`),
   fleet route tests (pairing lifecycle, credential isolation, ingest
   idempotency, RBAC matrix, analytics shape — `packages/api/src/fleet.test.ts`),
   and the security matrix updated for the gateway-only `sync:write` scope.
   OpenAPI: the Fleet tag documents all 16 new routes (62 paths total).

**M4 gate status**: D1–D5 ✅, H1–H5 ✅, D11 ✅. The remaining exit criteria are
operational rather than build items: a reference vendor integrating unaided
(sandbox + SDK shipped — needs a real partner), the 48 h offline soak (needs
a deployed edge + cloud pair), and two-tenant isolation is test-proven at the
store level (`pg-tenancy.test.ts` + the D11 per-facility isolation test);
full-stack two-tenant isolation arrives with production RLS roll-out (H1
enablement is wired, real-fleet verification pending).

---

## 14. Plan maintenance

- Version this document; record changes in a changelog section at the end.
- Milestones map to GitHub milestones/epics (suggested); each workstream becomes an epic
  with issues from its deliverables.
- Revisit quarterly: assumptions (A1–A6), decision log (D1–D10), risks (R1–R10).
- This plan intentionally leaves **product/commercial details** (pricing, naming,
  packaging) to the business owner; engineering gates are listed where they intersect.
