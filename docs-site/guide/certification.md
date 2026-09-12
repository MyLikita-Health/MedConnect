# Device certification

How a real analyzer becomes a **certified device profile** — from first bytes
on the wire to a CI-gated, version-stamped, bound profile. This is the field
procedure behind the "certified device profile" claim; the protocol background
(ASTM/HL7/DICOM) lives in [Devices & connections](/guide/devices).

**What certification means here.** A *profile* is configuration that turns the
generic ASTM pipeline into a device adapter: 1-based record-layout field
positions, per-model test-code mappings, capabilities, and transport/session
options. A profile ships **certified** only when recorded device transcripts
(*goldens*) pass through the real pipeline and produce the expected canonical
payload — and that recorded conformance run executes in CI on every test run.
Every message is stamped with the exact profile version that parsed it.

**Expected effort:** roughly 1–2 engineer-days per analyzer model, most of it
transcript capture and layout confirmation. The engineering machinery exists;
the input that cannot be faked is a real instrument's transcript.

**Roles:** the on-site engineer (device access, capture) plus an integration
engineer with an API key of role `engineer` or higher (`config:write`,
`devices:write` scopes) and, for profile promotion, a reviewer who understands
the vendor's ASTM implementation.

## Pre-flight checklist

- [ ] Hub reachable: `npm run db:up && npm start` (or the container stack).
      Device listener default `tcp://127.0.0.1:5000`, API
      `http://127.0.0.1:3000` — override with `DEVICE_PORT` / `PORT` / `HOST`.
- [ ] API key with role `engineer` (or `admin`) — from the first-boot print,
      `HUB_ADMIN_KEY`, or the console Access keys panel:
      ```bash
      export HUB_URL=http://127.0.0.1:3000
      export KEY=ihk_…   # engineer or admin
      curl -H "Authorization: Bearer $KEY" $HUB_URL/api/v1/me   # shows role
      ```
- [ ] TLS in use? Then the device must trust the facility CA (`tls/ca.pem`)
      and you need `curl --cacert tls/ca.pem` — see
      [Infrastructure](/guide/infrastructure). Without TLS the listener is
      plain TCP (fine for a bench bring-up; enable TLS before production).
- [ ] Vendor documentation in hand: the analyzer's **ASTM E1394 LIS interface
      manual** — record layouts (P/O/R field tables), test-code list, session
      behavior (who initiates, frame numbering, checksum style).
- [ ] Device-side configuration done: analyzer set to *send results to host*,
      correct host/IP of the hub, correct port, LIS mode on if the device has
      one.
- [ ] A few real samples with known expected results (normal + abnormal) and
      ≥1 deliberately bad case (e.g. missing patient ID) for negative goldens.
- [ ] Postgres up if you want durable capture (`DATABASE_URL=…`, see
      [Infrastructure](/guide/infrastructure)). In-memory is fine for capture
      on a bench; **use Postgres for the soak phase.**

## 1. Bring up the session — get bytes flowing

1. Configure the analyzer to push results to the hub (results-up). ASTM E1381
   sessions on this hub are **device-initiated**: the device sends `ENQ`, the
   hub answers `ACK`, then frames → `ACK`/`NAK`, `EOT`.
2. Trigger one result on the analyzer. The hub auto-registers the device from
   the H record and the message lands in the store:
   ```bash
   curl -H "Authorization: Bearer $KEY" "$HUB_URL/api/v1/devices"
   curl -H "Authorization: Bearer $KEY" "$HUB_URL/api/v1/messages?limit=10"
   ```
3. **Confirm the device id.** It is derived from the H record sender
   `"name^id"` (first non-empty component), exactly as sent — case-sensitive.
   Copy the exact string; you'll register the device under it later:
   ```bash
   curl -H "Authorization: Bearer $KEY" "$HUB_URL/api/v1/messages?limit=5" | jq '.[].deviceId'
   ```
4. **Confirm clean sessions.** `npm run simulate -- --device <name> --id <id>`
   is the bench reference. For the real device, watch for NAK loops: the hub
   logs `ASTM checksum mismatch: expected X, computed Y` on session errors.
   Zero NAKs on a clean cable is the goal. If the device *requires* echoed
   frame numbers or excludes STX from its checksum, that is a known limitation
   (see [the honest limits](#honest-limits-read-before-promising-a-fix)) —
   log a support case with a captured transcript.

::: tip Capture hygiene
Everything the hub received is already stored — raw wire text, parsed records,
canonical payload, timeline. You do not need a packet sniffer; you need
*representative* samples. Do not hand-edit values in a transcript; if a sample
is bad, capture another.
:::

## 2. Capture transcripts (the raw material)

Pull each captured message's parsed records — this is exactly what a golden
case embeds:

```bash
curl -H "Authorization: Bearer $KEY" "$HUB_URL/api/v1/messages?deviceId=<DEVICE_ID>&limit=50" \
  | jq -r '.[].id'                     # message ids for this device
curl -H "Authorization: Bearer $KEY" "$HUB_URL/api/v1/messages/<MESSAGE_ID>" \
  | jq '{records, payload}'            # parsed records + what the hub currently makes of them
```

### Scenario checklist (minimum for certification)

| # | Scenario | Why it must exist |
| --- | --- | --- |
| 1 | Normal single result (e.g. GLU in range) | baseline layout + mapping proof |
| 2 | Multi-panel result (2–5 tests in one O/R group) | ordering + multiple R records |
| 3 | Abnormal high (`H`) and low (`L`) flags | flag field position |
| 4 | Patient without DOB and/or sex | optional patient fields |
| 5 | Multiple patients / orders in a batch | P/O/R grouping across records |
| 6 | **Missing patient identifier** (negative) | must FAIL with `Missing patient identifier` |
| 7 | Missing order id, or a result with no value (negative) | must FAIL, never silently forward |
| 8 | Optional fields populated: `^`-name components, absent reference range, result status (`F` vs `P`) | field-level tolerance |

Capture **at least 3 good messages per scenario**, from different patients.
Label each in your notes: scenario, sample, expected values from the lab
system. Negative cases: a message that cannot be associated is parked
(`FAILED`/`HELD`), never dropped — that is the safety gate working. In
goldens, negative cases assert the *issues* the pipeline must report.

## 3. Author the profile (layout + mappings + session)

### The shape (zod-validated at the API boundary)

```jsonc
{
  "id": "mindray-bs-430",        // lowercase slug: [a-z0-9][a-z0-9-]*
  "name": "Mindray BS-430",
  "manufacturer": "Mindray",
  "model": "BS-430",
  "protocol": "ASTM",
  "transport": "tcp",
  "version": 1,                  // bump on EVERY change after certification
  "layout": {                    // 1-based field positions (seq = position 1)
    "patient": { "id": 3, "name": 4, "dateOfBirth": 6, "sex": 7 },
    "order":   { "sampleId": 2, "accession": 3, "test": 4 },
    "result":  { "test": 2, "value": 3, "unit": 4, "referenceRange": 5, "flag": 6, "status": 8 }
  },
  "mappings": { "GLU": "GLUCOSE", "CREA": "CREATININE", "HGB": "HEMOGLOBIN" },
  "capabilities": ["results-up"],
  "connection": { "port": 5000 },
  "session":   { "initiator": "device", "checksumIncludesStx": true },
  "status": "draft"              // → "certified" only after the gate passes
}
```

The layout above is the **reference layout** (the simulator's). Start from it
and change only what the vendor manual + your transcripts prove differs.

### Deriving layout offsets

For each record type, line up the captured fields against the canonical
meaning the device intends (from the vendor manual). Positions are 1-based:

- **P record** — `["1", "", "PID-1001", "Adeyemi^Tunde", "", "19850312", "M"]`
  → id=3, name=4, dob=6, sex=7. `^`-names flatten to "Last, Given"
  automatically.
- **O record** — `["1", "S-4242", "ACC-424242", "^GLU^Glucose"]` → sampleId=2,
  accession=3, test=4. ⚠ Some vendors swap sample/accession — that is *the*
  classic mis-association bug. The seeded `acme-chem-200` profile exists
  precisely because its O record is accession-first. **If your device's
  transcript shows that swap, your profile is the acme shape.**
- **R record** — `["1", "^GLU^Glucose", "95", "mg/dL", "70-110", "N", "", "F"]`
  → test=2, value=3, unit=4, referenceRange=5, flag=6, status=8.

### Mappings

Device test code → canonical code. Lookups try the exact code then its
uppercase form; an unmapped code passes through unchanged and triggers a
`testKnown` warning in validation. Map every test your analyzer can emit —
at minimum every code in your transcripts, ideally the whole vendor code list.

### Honest limits (read before promising a fix)

The `connection` and `session` blocks are **modeled in the profile schema but
not yet consumed by the frame/session codec**:

- `checksumIncludesStx` — documented config point; today the codec always
  includes STX in the mod-256 sum. A device that excludes STX will NAK-loop.
- `frameNumbering: "echo"` — the session accepts bare ACK/NAK; echoed frame
  numbers are not yet implemented.
- `initiator: "host"` — the hub session is responder-only; a device that waits
  for the host to initiate is not yet supported.

If the analyzer needs any of these, **capture the failing transcript, open a
support case**, and do not proceed — a checksum-mismatch loop is a hard stop,
not a config tweak. Layout, mappings, and identity/version stamping are fully
wired; session-level behavior is the remaining seam.

### Save it as a draft — then bind early

```bash
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d @profile.json $HUB_URL/api/v1/profiles
# → 201 with the validated profile; a validation failure returns 400 with issues.
```

Then **bind your device to it immediately** (see
[Bind the device](#bind-the-device-and-verify-live)) so subsequent captured
messages are canonicalized with *your* layout — that is how you confirm the
layout is right before investing in goldens. Watch the console message
viewer: if the canonical patient/order/results now look correct, the layout is
right; if the accession landed in the sample-id slot (or vice versa), adjust
the O record offsets and re-verify.

## 4. Author the golden file

A golden file embeds **the profile it certifies** plus cases, and lives in
`goldens/` (`<profile-id>.json`; the Docker image ships the directory, and a
non-default deployment can point `HUB_GOLDENS_DIR` at its own copy):

```json
{
  "profile": { "id": "mindray-bs-430", "version": 1, "status": "certified" },
  "goldens": [
    {
      "name": "two-panel male result (GLU + CREA)",
      "records": [
        { "type": "H", "fields": ["\\^&", "", "", "", "SIM-BS430^SIM-001", "", "", "", "", "", "", "P", "1", "20260904120000"] },
        { "type": "P", "fields": ["1", "", "PID-1001", "Adeyemi^Tunde", "", "19850312", "M"] },
        { "type": "O", "fields": ["1", "S-4242", "ACC-424242", "^GLU^Glucose"] },
        { "type": "R", "fields": ["1", "^GLU^Glucose", "95", "mg/dL", "70-110", "N", "", "F"] },
        { "type": "L", "fields": ["1", "N"] }
      ],
      "expected": {
        "patient": { "id": "PID-1001", "name": "Adeyemi, Tunde", "gender": "M" },
        "order":   { "id": "ACC-424242", "sampleId": "S-4242" },
        "results": [ { "testCode": "GLUCOSE", "originalTestCode": "GLU", "value": "95", "flag": "N" } ]
      }
    }
  ]
}
```

Rules:

- **`records`** are the captured transcript verbatim (jq `.records` from the
  capture step). `\^` in JSON is the literal `\^` delimiter component.
- **`expected` is a partial comparison** — assert only the fields that prove
  layout + mappings. Results are compared by count and index.
- **Negative cases** use `expected.expectIssues` with the *exact* pipeline
  issue text, e.g. `"Missing patient identifier"` — and the pipeline **must**
  produce no payload for them.
- The **embedded profile version must equal the version you will certify** —
  it is the certification baseline every later message is compared against
  (drift enforcement).

## 5. Run the conformance gate

Every `goldens/*.json` runs through the real pipeline in CI — on every test
run:

```bash
npx tsx --test packages/core/src/goldens.test.ts   # fast loop: just the gate
npm run build                                      # types clean
npm run test                                       # full suite (DB-gated tests skip)
npm run test:db                                    # full suite against Postgres
```

The gate fails if *any* case in *any* golden file fails, and the failure text
names case + mismatch (`patient.id: expected "…", got "…"`). Iterate here —
this is the expensive part to get right.

### Promote to certified

Only after the gate is green and a reviewer has eyeballed the transcripts
against the vendor manual: set `status: "certified"` + `certifiedAt` on the
profile and re-save it. The console then shows the green "certified" badge,
and the conformance endpoint re-runs the *stored* profile against its
recorded goldens:

```bash
curl -H "Authorization: Bearer $KEY" $HUB_URL/api/v1/profiles/<ID>/conformance
# → available: true, run.passed == run.cases.length
```

## Bind the device and verify live

Register the device with **the exact id from the H record** and the profile
id. The binding is what makes the gateway canonicalize with your layout:

```bash
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"id":"<DEVICE_ID>","name":"<friendly name>","manufacturer":"<vendor>",
       "model":"<model>","protocol":"ASTM","transport":"tcp","profileId":"<profile id>"}' \
  $HUB_URL/api/v1/devices
# 400 if profileId doesn't exist. Unbound devices keep reference behavior.
```

Then push real results and check **the stamp**:

```bash
curl -H "Authorization: Bearer $KEY" "$HUB_URL/api/v1/messages?deviceId=<DEVICE_ID>&limit=3" \
  | jq '.[] | {deviceId, status, profile, payload: .payload.order}'
```

Expect:

- `status` in `ROUTED` / `HELD` — see
  [Troubleshooting](/guide/troubleshooting) for HELD/FAILED meanings.
- `profile` = `{ "id": "<profile id>", "version": 1, "certifiedVersion": 1,
  "drift": false }` — **`drift` must be false** for every message.
- Canonical payload correct: mapped codes (`GLUCOSE`, with
  `originalTestCode: GLU`), right patient/order, right units/flags.

Full acceptance loop with the expected-order registry (the LIS seam) so
results route instead of parking in HELD:

```bash
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"id":"<ACCESSION>","patientId":"<PATIENT_ID>","tests":["GLUCOSE"]}' \
  $HUB_URL/api/v1/orders
```

## Versioning & drift discipline (after certification)

- The golden file's embedded profile version is the **certification baseline**.
- **Any change** to layout, mappings, or session config = **bump `version`**
  on the stored profile and re-run the gate. Do not edit a certified profile
  in place at the same version.
- If a change breaks a golden, the conformance endpoint and CI fail, and live
  messages stamp `drift: true` with a `FLAGGED` timeline note naming both
  versions — that is the enforcement working, not a bug. Either fix the
  profile back or certify a new version with updated goldens.
- Every message keeps its `profile` stamp through replay, so a stored result
  is always attributable to the exact config that parsed it.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No device appears / no messages | Wrong host/port on the analyzer; TLS mismatch | Point device at hub `DEVICE_PORT`; if TLS, import `tls/ca.pem` into the device's trust store |
| `ASTM checksum mismatch` in logs | Physical layer noise, or device excludes STX from checksum | Re-check cabling first; if persistent, device needs `checksumIncludesStx:false` — codec config point not yet wired (support case) |
| Session hangs after ENQ | Device expects host to initiate or frame-number echo | Not yet supported — capture transcript, raise a case |
| Messages `FAILED` with `Missing patient identifier` / `Missing order identifier` | Layout offsets wrong for P/O records | Diff the transcript against the vendor manual; fix layout, re-capture |
| Message parks in `HELD` | Matching couldn't associate (no expected order), or error-severity validation | Register the expected order (`POST /api/v1/orders`); check `match` + `errors` on the message |
| Canonical accession == sample id (or swap) | O record offsets wrong (the acme case) | Swap `order.sampleId` / `order.accession` in the layout |
| `testKnown` warnings on the timeline | Analyzer code unmapped | Add to `mappings`; bump version if already certified |
| Conformance endpoint shows ✗ after an edit | Stored profile drifted from its golden version | Bump version + re-certify, or revert the edit |
| Messages stamped `drift: true` | Stored version ≠ golden-recorded version | Align versions; check nothing reseeded a stale profile |
| NAKs on the bench but fine in production | Different cabling/termination | RS-232: baud/parity/data-bits must match both ends (`connection` block) |

## Sign-off checklist

- [ ] ≥3 good transcripts per scenario, including ≥1 negative case, captured
      from the **real instrument** (not hand-typed).
- [ ] Profile draft bound to the device; canonical payload verified correct
      on live messages; `profile.drift` false.
- [ ] `goldens/<profile-id>.json` committed; the golden gate green both
      locally and in CI (`npm test` + `npm run test:db`).
- [ ] Profile promoted to `status: "certified"` with `certifiedAt`; the
      console shows the certified badge and conformance **passed ✓ n/n**.
- [ ] Device registration committed/scripted with the exact H-record id +
      `profileId` so a rebuild of the hub restores the binding.
- [ ] **7-day soak** on Postgres: zero silent drops, zero NAK loops, no
      unexpected HELD/FAILED growth (the `device-offline`, `held-backlog`,
      `dlq-growth` alert rules cover this).
- [ ] Version-discipline note written into the facility's change log: any
      future edit bumps `version` and re-runs the gate.

Deliverable: profile id + golden file + device binding + the soak report.
That combination is what "certified" means on this platform.

::: tip The imaging counterpart
Imaging devices (modalities) are certified by the **M3 exit drill** — a live
DICOM walk of order → worklist → store → route with failure injection,
covered at the end of [Devices & connections](/guide/devices#the-m3-exit-drill-imaging-certification-gate).
:::
