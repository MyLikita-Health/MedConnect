---
title: Devices & connections
description: Connecting ASTM analyzers, HL7 LIS feeds and DICOM imaging equipment — protocols, simulators, profiles and certification.
outline: [2, 3]
---

# Devices & connections

The hub speaks three protocol families. All listeners bind `127.0.0.1` by
default — set `HOST` to accept LAN connections from real equipment.

| Family | Listener | Default |
| --- | --- | --- |
| [ASTM analyzers](#astm-analyzers-tcp) | TCP `DEVICE_PORT` | `:5000` |
| [HL7 v2 (MLLP)](#hl7-v2-mllp) | TCP `HL7_PORT` | *(off until set)* |
| [Imaging (DICOM)](#imaging-dicom-via-orthanc) | Orthanc REST/DICOM | `:8042` / `:4242` |

## ASTM analyzers (TCP)

### Register the device

```bash
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"BS-430","protocol":"astm","profileId":"acme-chem-200"}' \
  http://127.0.0.1:3000/api/v1/devices
```

(`profileId` is optional — it binds a certified
[device profile](#device-profiles-certified-vendor-support); unbound
devices get the generic reference behavior.)

### Point the analyzer at the hub

Configure the analyzer (or its middleware) to send over TCP to
`<hub-host>:5000` (or your `DEVICE_PORT`).

### What happens on the wire

The ASTM listener runs the E1381 session protocol per connection:

```
Analyzer                                  Hub
   │ ── ENQ ────────────────────────────▶ │
   │ ◀──────────────────────────────── ACK │
   │ ── frame (STX … ETX + checksum) ───▶ │
   │ ◀──────────────────────────────── ACK │   (NAK on corruption → device retries)
   │ ── … more frames (ETB …) … ───────▶ │
   │ ── EOT ────────────────────────────▶ │
```

1. **Transport** — `ENQ` → host `ACK` → one frame per record
   (`STX … ETX/ETB` + 2-hex checksum) → host ACKs each frame (or NAKs a
   corrupted one; the device retries) → `EOT` ends the session. Records
   accumulate across `ETB` frames; the `ETX` frame completes the message.
2. **Parse** — records split into `H/P/O/R/L`, `|` fields, `^` components.
3. **Validate** — patient id, order id and ≥1 result required; failures
   are recorded `FAILED` with issues, never dropped.
4. **Map** — analyzer test codes → canonical codes (e.g. `GLU` →
   `GLUCOSE`), `originalTestCode` preserved.
5. **Deliver** — matching, validation, routing and retry as in
   [Usage → How a message flows](/guide/usage#how-a-message-flows).

### Testing with the simulator

```bash
npm run simulate -- --count 10 --interval 200   # 10 messages, 200 ms apart
npm run simulate -- --corrupt-rate 0.5          # inject corrupt frames → NAK + retry on the wire
```

### Protocol compatibility knobs

- **Checksum** — mod-256 sum from `STX` through `ETX`/`ETB` inclusive,
  two uppercase hex digits. Some devices exclude `STX`; the codec exposes
  `checksumIncludesStx` as a per-device config point.
- **ACK/NAK** — the session acknowledges with a bare `ACK` and tolerates
  stray padding bytes; frame-number echoing (required by some analyzers)
  is a documented extension point.
- **Record layouts** — real analyzers deviate vendor-by-vendor (sometimes
  between firmware versions). The hub uses a configurable per-device
  **profile** for field offsets — a device whose O record swaps fields
  gets a profile, not a code change.
- **Serial transport** — the session/client take a minimal `DuplexLike`
  interface, so swapping TCP for RS-232 only changes how bytes arrive.

## HL7 v2 (MLLP)

Set `HL7_PORT` and the hub listens for **inbound HL7 v2 over MLLP** in
addition to ASTM:

```bash
HL7_PORT=2575 npm start
# boot log should print: [gateway] HL7 v2 (MLLP) listening on tcp://…
```

### Inbound message types

| Message | Effect |
| --- | --- |
| **ORU^R01** (results) | Translated to canonical results and pushed through the full pipeline (validate → match → route) |
| **ORM^O01** (orders) | Registers the order in the **order registry** — the LIS seam; the imaging side consumes the same registry for the worklist |
| **ADT^A01 / A04 / A08** (admissions) | Registers the patient in the **admission registry** (used to enrich worklist items with patient names) |

Every inbound message receives an application ACK (`MSA|AA…`) on success.

### Outbound (store-and-forward to a LIS)

`kind: 'hl7'` destinations **serialize canonical messages to HL7 v2
(ORU/ORM)** and deliver over MLLP, awaiting the application ACK: `AA` →
delivered; `AR`/`AE` → failed delivery (retry → DLQ). Outbound MLLP runs
over a held-open connection pool (reuse, replace-on-dead-peer, idle
close).

### Testing with the simulator

```bash
npm run simulate:hl7                                     # inbound ORU over MLLP
npm run simulate:hl7 -- --kind orm                       # ORM order feed
npm run simulate:hl7 -- --variant pid6-name --kind oru   # vendor-variant transcripts
```

Variants (`pid6-name`, `obx-swap`, `delimiters`, `pid4-id`, `orc4-id`)
emit B4 vendor-deviant wire for profile testing. ADT has no simulator —
the ADT golden corpus runs in CI and the feed is exercised through the
demos/tests.

HL7 **segment-level profiles** let a device profile pin per-vendor
PID/OBR/OBX field positions + delimiter overrides; the gateway resolves
the layout from the MSH sender identity.

## Imaging (DICOM via Orthanc)

The hub **does not speak DICOM networking** — it drives **Orthanc** (a
separate AGPLv3 process, never embedded) over its REST API. This is the
AGPL boundary: adjacent process, REST-only.

### Enabling imaging

```bash
docker compose up -d --build orthanc   # REST :8042, DICOM :4242 (+ Worklists plugin)
ORTHANC_URL=http://127.0.0.1:8042 ORTHANC_USER=orthanc ORTHANC_PASSWORD=orthanc npm start
```

The compose `orthanc` image is **derived** (`docker/orthanc/Dockerfile`):
a version-pinned, multi-arch base (`orthancteam/orthanc:26.8.2`, amd64 +
arm64) plus the REST-based **Worklists plugin** (0.9.2) source-built in
the image with DB-backed worklists enabled. On the Windows imaging
bundle, Orthanc ships as its own service (`integration-hub-orthanc`) with
REST bound **localhost-only** — the hub is the only client.

### What runs when `ORTHANC_URL` is set

1. **MWL study monitor** (`hub.mwl`, every `MWL_POLL_MS`) — pushes the
   order registry's active orders onto the Orthanc worklist (idempotently,
   joined with the admission registry's patient name), then polls for
   performed studies (accession match). Performed studies are retired
   from the worklist.
2. **Imaging router** (`hub.imaging`) — each performed study becomes a
   hub **message** (canonical study metadata + storage URLs only;
   **pixels never enter the hub**) and flows through the dispatcher:
   dedup → route rules → delivery, in the same viewer as lab results.
3. **Modality health monitor** (`hub.modalities`, every `MODALITY_POLL_MS`)
   — lists Orthanc's configured DICOM modalities and **C-ECHOes** each
   one; every outcome flips that modality's device row (protocol DICOM)
   and feeds `device-offline` alerting. Rows auto-drop when a modality is
   removed from Orthanc's config.
4. **Storage routing to PACS** — with `ORTHANC_FORWARD_PEER` set to a
   peer configured in Orthanc, each performed study is also forwarded
   Orthanc→peer. The pixels move Orthanc→PACS; the hub only triggers and
   records the routing. The compose stack includes a `pacs` archive
   Orthanc for this.

### Observing imaging

- **Radiology panel** — worklist sync totals + live items, and
  per-study routing status with Retry on FAILED.
- **Devices panel** — the `orthanc` device row (connected/disconnected +
  lastSeen) and one row per configured modality.
- **Alerts** — the seeded `orthanc-down` rule (threshold 3) fires on
  consecutive failed polls, resolves on the first success.
- **REST** — `GET /api/v1/mwl` and `GET /api/v1/imaging`.

### The M3 exit drill (imaging certification gate)

`npm run demo:m3-exit` drives the whole imaging chain **live, over real
DICOM networking**: a pynetdicom *fake modality* stands in for an actual
CT scanner and walks **ADT^A01 → ORM^O01 (MLLP) → MWL C-FIND → C-STORE →
routed performed study** against a real Orthanc container, then exercises
the two failure paths an operator will actually meet:

- **Modality offline** — kill the fake modality: Orthanc's C-ECHO fails,
  the modality monitor flips the device row to `disconnected` and fires
  `device-offline`; restarting the modality resolves both automatically.
- **Dead routing destination** — a rule pointed at an unreachable `hl7`
  destination sends the study to `FAILED` + the DLQ (never a silent
  drop); after the rule is fixed, an operator retry (API or the Radiology
  panel's Retry button) routes it → `ROUTED`.

```bash
docker compose up -d --build orthanc    # derived image incl. the Worklists plugin
python3 -m venv .venv && .venv/bin/pip install pynetdicom   # the fake modality
npm run build
npm run demo:m3-exit                    # exit 0 = ALL CHECKS PASSED
```

The drill prints one ✓/✗ line per check, cleans up after itself (Orthanc
left pristine), and boots its own hub — no Postgres or PACS peer needed.
Every check, the failure-injection controls, the exit criteria and
troubleshooting live in the
[certification runbook §10](https://github.com/MyLikita-Health/MedConnect/blob/main/docs/analyzer-certification-runbook.md#10-the-m3-exit-drill--imaging-certification-gate-workstream-k).

## Device profiles (certified vendor support)

Certified device support is **configuration, not code**. A profile turns
the generic pipeline into a device adapter: 1-based record-layout field
positions (P/O/R records), per-model test-code mappings, capabilities,
transport/session options — and, for HL7, per-vendor PID/OBR/OBX
positions + delimiter overrides.

- **Validation** — every profile is zod-validated at the API boundary and
  whenever stored JSON is read back; a corrupt profile fails loudly
  instead of silently mis-parsing results.
- **Binding** — a registered device carries an optional `profileId`; when
  set, the gateway canonicalizes that device's stream with the profile's
  layout + mappings (per-device mappings override the global table).
- **Golden-message conformance** — `goldens/*.json` pair a certified
  profile with recorded transcripts and the canonical output they must
  produce (including negative cases). The CI suite runs every golden
  file; the `GET /api/v1/profiles/:id/conformance` view re-runs the
  profile's *current* config against its goldens and shows per-case
  failures when an edit drifted it away from certification.
- **Version stamping + drift** — every message parsed through a binding
  carries `profile: {id, version, certifiedVersion?, drift?}`. When the
  stored profile version differs from the golden-recorded
  `certifiedVersion` (edited after certification), messages are stamped
  `drift: true` with a `FLAGGED` timeline entry — results still flow, the
  console marks them red, and the `profile-drift` alert can page.

The console's **Device profiles** panel lists profiles with certified
(green) vs draft (amber) badges and the per-profile conformance view.

## Onboarding a real analyzer (certification runbook)

The full field procedure is
[`docs/analyzer-certification-runbook.md`](https://github.com/MyLikita-Health/MedConnect/blob/main/docs/analyzer-certification-runbook.md)
in the repo. In short:

1. Bring up the session; capture the analyzer's transcript on the wire.
2. Author a profile for the vendor's layout + code mappings.
3. Record goldens (transcript → expected canonical payload) and pass the
   conformance run.
4. Bind the profile to the device; run the soak.
5. Keep profile versions disciplined — edits after certification flag
   drift.
