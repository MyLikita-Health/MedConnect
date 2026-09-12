# FAQ

The questions that come up in pre-sales conversations and pilot planning —
answered the way the product actually behaves, with links to the detail
pages. Anything not answered here: contact the integration team.

## Product & fit

### What is the Integration Hub, in one paragraph?

A single-box edge gateway that connects laboratory analyzers, imaging
modalities and LIS/HIS systems. Devices speak ASTM, HL7 v2 or DICOM; the hub
turns that traffic into one canonical pipeline with a clinical safety gate
(match + validation before delivery), a REST API, a web console, and a full
audit timeline for every message. See [Project overview](/guide/overview).

### Which devices and protocols are supported?

- **ASTM E1381/E1394** analyzers over TCP (the classic LIS protocol for
  chemistry/hematology analyzers)
- **HL7 v2** (ORU^R01, ORM^O01, ADT) over MLLP — inbound and outbound
- **DICOM** via Orthanc: modality worklist (MWL), performed-study ingestion,
  PACS forwarding

Device-specific behavior is handled by **device profiles** — configuration
that adapts the pipeline to a model's exact record layout and test codes.
See [Devices & connections](/guide/devices).

### Is my analyzer supported out of the box?

The platform ships two reference-certified profiles and a certification
procedure: any ASTM analyzer can be onboarded as a certified profile in
roughly 1–2 engineer-days per model, most of it transcript capture. The
result is CI-gated: recorded transcripts must pass through the real
pipeline on every test run. See [Device certification](/guide/certification).

### Does it replace our LIS?

No — it sits **between** devices and the LIS/HIS. It normalizes device
traffic, applies the clinical safety gate, and delivers to the systems you
configure. It can also hold results for review when the LIS is down (with
replay), which is the usual reason labs deploy a middleware layer.

## Deployment & operations

### What hardware do we need?

One Windows machine (the installer targets x64 Windows with an embedded
SQLite store and a supervised service) or a Docker host. There is no
database server to size for in the default deployment — see
[Installation](/guide/installation) and [Infrastructure](/guide/infrastructure).

### Does it work offline?

**Yes — fully.** Device ingestion, matching, validation, routing, DLQ/HELD,
the console and the audit log all work with no internet connection. Cloud
synchronization exists but is strictly opt-in (see the
[security statement](/reference/security#data-locality-and-residency)).

### What happens when the LIS goes down?

Deliveries retry with backoff; results that cannot be delivered park in the
**dead-letter queue** (never silently dropped) and can be replayed once the
LIS returns. Results that cannot be confidently matched are HELD for
operator review. See [Usage → DLQ, HELD & replay](/guide/usage).

### How do we update it?

Releases are published with SHA-256 checksums; the hub's update agent
verifies **Ed25519-signed manifests** before applying an update and rolls
back to the last-good release if the new one fails its health gate. A
facility can also stay fully offline and update manually — see
[Infrastructure → Updates](/guide/infrastructure) and the
[security statement](/reference/security#updates-and-supply-chain).

### How do we back it up?

Copy the data directory while the service is stopped — the whole state of
the hub is one directory (SQLite store, update bookkeeping, logs). See
[Service management](/guide/service-management).

## Data, security & compliance

### Where does patient data go?

**On the box.** The embedded SQLite store in the hub's data directory is the
only copy; the hub sends data nowhere except the destinations you configure.
No telemetry, no cloud copy unless you explicitly pair to one. See
[Security & privacy](/reference/security).

### Is it HIPAA compliant?

The hub is **pre-certification** — no BAA framework, ISO 27001 or SOC 2 yet.
The architecture (data locality, no telemetry, RBAC, audit trail, signed
updates) is the foundation that certification work builds on; contact the
team for the current roadmap. The full technical posture, including
disclosed limitations, is in the [security statement](/reference/security).

### Who can see and do what?

Every API key maps to one of four roles (`admin`/`engineer`/`operator`/
`viewer`) with fixed scopes; every mutating action — including denied
attempts — lands in the audit log with actor, action, target and source IP.
See [Security & privacy → Authentication](/reference/security#authentication-and-authorization).

### Can one hub serve multiple facilities?

The current model is **one hub per site** (an edge box per lab/facility).
A multi-site fleet layer (gateway registry, per-facility licensing and
quotas) exists behind the `fleet` feature set for pilot programs — talk to
the team about your topology.

## Pricing & pilot

### How is it licensed?

Per-facility licensing with pilot terms — contact the team. (Licensing of
**third-party components** — including the AGPL Orthanc engine and what it
obligates — is documented separately in
[Licensing](/reference/licensing).)

### What does a pilot look like?

Typical shape: one site, one or two analyzer models, the hub installed on
an on-site Windows box, devices certified via the
[certification procedure](/guide/certification), a 7-day soak with the
`held-backlog` / `dlq-growth` / `device-offline` alert rules active, and a
review of the audit trail. The [setup guide](/guide/setup) walks first
boot to first routed result.

### What do we need from our side?

- Network reachability from analyzers to the hub's device port (the
  installer opens it on the local-network profile)
- The analyzers' ASTM/HL7 interface manuals for profile certification
- An LIS/HIS contact for destination configuration (or a file/webhook
  destination to start)
- A decision on TLS certificates if you want encrypted device/API links —
  see [Infrastructure → TLS](/guide/infrastructure)

### Who do we call when something breaks?

Start with [Troubleshooting](/guide/troubleshooting) — it covers the
symptoms operators actually hit. For anything beyond it, contact the
integration team with the message id(s) concerned: every message's audit
timeline (wire bytes → delivery) is in the console, which usually answers
the question in one screenshot.
