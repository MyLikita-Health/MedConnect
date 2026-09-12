---
title: Devices & connections
description: Connecting ASTM analyzers, HL7 LIS feeds and DICOM imaging equipment.
outline: [2, 3]
---

# Devices & connections

The hub speaks three protocol families. All listeners bind `127.0.0.1` by
default — set `HOST` to accept LAN connections from real equipment.

## ASTM analyzers (TCP, port 5000)

### Register the device

```bash
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"BS-430","protocol":"astm"}' \
  http://127.0.0.1:3000/api/v1/devices
```

### Point the analyzer at the hub

Configure the analyzer (or its middleware) to send over TCP to
`<hub-host>:5000` (or your `DEVICE_PORT`).

### What happens on the wire

```
Analyzer                                  Hub
   │ ── ENQ ────────────────────────────▶ │
   │ ◀──────────────────────────────── ACK │
   │ ── frame (STX … ETX + checksum) ───▶ │
   │ ◀──────────────────────────────── ACK │   (NAK on corruption → device retries)
   │ ── … more frames … ───────────────▶ │
   │ ── EOT ────────────────────────────▶ │
```

1. **Transport** — `ENQ` → `ACK` → frames (`STX … ETX/ETB` + 2-hex checksum)
   → `EOT`.
2. **Parse** — records split into `H/P/O/R/L`, `|` fields, `^` components.
3. **Validate** — patient id, order id and ≥1 result required; failures are
   recorded `FAILED` with issues, never dropped.
4. **Map** — analyzer test codes → canonical codes (e.g. `GLU` → `GLUCOSE`),
   `originalTestCode` preserved.
5. **Deliver** — matching, validation, routing and retry as in
   [Overview → Message lifecycle](/guide/overview#message-lifecycle).

### Protocol compatibility knobs

- **Checksum** — mod-256, two uppercase hex digits. Some devices exclude
  `STX`; `checksumIncludesStx` is a per-device config point.
- **ACK/NAK** — the session tolerates stray padding bytes; frame-number
  echoing is a documented extension point.
- **Record layouts** — real analyzers deviate vendor-by-vendor. Bind a
  [device profile](#device-profiles-certified-vendor-support) instead of
  changing code.
- **Serial transport** — the session takes a `DuplexLike` interface, so
  RS-232 works by changing how bytes arrive.

## HL7 v2 (MLLP)

The inbound MLLP listener starts **only when `HL7_PORT` is set** — an ASTM-only
hub stays ASTM-only unless you opt in.

```bash
HL7_PORT=2575 npm start        # devices on :5000, HL7 on :2575
```

| Feed | Message types | Effect |
| --- | --- | --- |
| Result feed | `ORU^R01` | Results enter the same pipeline as ASTM results |
| Order feed | `ORM^O01` | Orders land in the expected-order registry (the LIS seam — replaces manual `POST /api/v1/orders`) |
| Admissions | `ADT^A01/A04/A08` | Patients register in the admission registry |

Outbound: results can be **store-and-forwarded** to a LIS over MLLP via an
`hl7` destination (`AA`/`AR`/`AE` handling, retry/DLQ, held-open connection
pool). Vendor quirks (PID/OBR/OBX position overrides, custom delimiters)
are handled by HL7 segment-level [profiles](#device-profiles-certified-vendor-support).

## Imaging (DICOM via Orthanc)

The imaging path runs **Orthanc as an adjacent service** (AGPL boundary:
REST-only, no code coupling):

- Set `ORTHANC_URL` (default `http://127.0.0.1:8042`, optionally
  `ORTHANC_USER`/`ORTHANC_PASSWORD`, `MWL_POLL_MS`).
- The hub pushes registry orders onto the **modality worklist** each cycle
  (idempotent sync), retires performed studies, and joins patient names
  from the admissions registry.
- Performed studies are routed through the dispatcher (`hub.imaging`) and,
  with `ORTHANC_FORWARD_PEER`, the **pixels** are forwarded to a PACS
  archive peer.
- Modalities are shown in the Devices panel like any wire device, mirrored
  from a standing **C-ECHO** probe; `device-offline` alerts fire when a
  modality stops answering.

On the Windows imaging bundle, Orthanc runs as its own service
(`integration-hub-orthanc`) with REST bound **localhost-only** — the hub is
the only client.

## Device profiles (certified vendor support)

Certified device support is **configuration, not code**. A profile
describes 1-based record-layout positions (P/O/R records), per-model
test-code mappings, capabilities and transport/session options.

- Register + bind at device registration: `POST /api/v1/devices` with
  `profileId` (validated against the profile store).
- Every message parsed under a binding is stamped with the profile
  `{id, version, certifiedVersion?, drift?}` — provenance of exactly which
  config produced it.
- **Drift**: if a profile is edited after certification, messages are
  stamped `drift: true`, a `FLAGGED` timeline entry is added, and the
  seeded `profile-drift` alert fires — operators are paged instead of
  noticing red markers later.
- Conformance is provable: goldens replay through the real pipeline in CI.

## Onboarding a real analyzer (certification runbook)

The full field procedure — session bring-up, transcript capture, profile +
golden authoring, the CI conformance gate, device binding, soak, version
discipline — is
[`docs/analyzer-certification-runbook.md`](https://github.com/MyLikita-Health/MedConnect/blob/main/docs/analyzer-certification-runbook.md)
in the repo. In short:

1. Bring up the session; capture the analyzer's transcript on the wire.
2. Author a profile for the vendor's layout + code mappings.
3. Record goldens (transcript → expected canonical payload) and pass the
   conformance run.
4. Bind the profile to the device; run the soak.
5. Keep profile versions disciplined — edits after certification flag
   drift.