# Analyzer Certification Runbook

Onboarding a real analyzer onto the hub as a **certified device profile** — from
first bytes on the wire to a CI-gated, version-stamped, bound profile.This is the field procedure behind the "certified device profile" claim (PRD §39–40,
plan §6.3, workstream A2/K). It covers both certification gates the platform
ships: the **ASTM golden gate** for lab analyzers (§§1–9) and the **M3 imaging
exit drill** (§10, workstream K) that closes the imaging workstream.

**What certification means here.** A *profile* is configuration that turns the
generic ASTM pipeline into a device adapter: 1-based record-layout field
positions, per-model test-code mappings, capabilities, and transport/session
options. A profile ships **certified** only when recorded device transcripts
(*goldens*) pass through the real pipeline and produce the expected canonical
payload — and that recorded conformance run executes in CI on every test run.
Binding a device to the profile makes the hub canonicalize that device's stream
with its layout + mappings, and stamp every message with the exact profile
version that parsed it.

**Expected effort:** roughly 1–2 engineer-days per analyzer model, most of it
transcript capture and layout confirmation. The engineering machinery exists;
the input that cannot be faked is a real instrument's transcript.

**Roles:** the on-site engineer (device access, capture) plus an integration
engineer with an API key of role `engineer` or higher (`config:write`,
`devices:write` scopes) and, for profile promotion, a reviewer who understands
the vendor's ASTM implementation.

---

## 0. Pre-flight checklist

- [ ] Hub is reachable: `npm run db:up && npm start` (or the container:
  `npm run up:stack`). Device listener default `tcp://127.0.0.1:5000`, API
  `http://127.0.0.1:3000` — override with `DEVICE_PORT` / `PORT` / `HOST`.
- [ ] You have an API key with role `engineer` (or `admin`): from the first-boot
  print, `HUB_ADMIN_KEY`, or the console Access keys panel. Save it as `$KEY`:
  ```bash
  export HUB_URL=http://127.0.0.1:3000
  export KEY=ihk_…   # engineer or admin
  curl -H "Authorization: Bearer $KEY" $HUB_URL/api/v1/me   # shows role
  ```
- [ ] TLS in use? (`HUB_TLS_CERT` / `HUB_TLS_KEY`) Then the device must trust
  the facility CA (`tls/ca.pem`) and you need `curl --cacert tls/ca.pem` —
  see README "TLS for device + LIS connections". Without TLS the listener is
  plain TCP (fine for a lab bench bring-up; enable TLS before production).
- [ ] Vendor documentation in hand: the analyzer's **ASTM E1394 LIS interface
  manual** — record layouts (P/O/R field tables), test-code list, session
  behavior (who initiates, frame numbering, checksum style).
- [ ] Device-side configuration done: analyzer set to *send results to host*
  (results-up), correct host/IP of the hub, correct port, LIS mode on if the
  device has one.
- [ ] A few real samples with known expected results (normal + abnormal) and
  ≥1 deliberately bad case (e.g. missing patient ID) for negative goldens.
- [ ] The hub's Postgres is up if you want durable capture
  (`DATABASE_URL=postgres://hub:hub@localhost:5434/hub`, see README). In-memory
  is fine for capture on a bench; **use Postgres for the soak phase.**

---

## 1. Bring up the session — get bytes flowing

1. Configure the analyzer to push results to the hub (results-up). ASTM E1381
   sessions on this hub are **device-initiated**: the device sends `ENQ`, the
   hub answers `ACK`, then frames → `ACK`/`NAK`, `EOT`.
2. Trigger one result on the analyzer. The hub auto-registers the device from
   the H record and the message lands in the store:
   ```bash
   curl -H "Authorization: Bearer $KEY" "$HUB_URL/api/v1/devices"      # device list
   curl -H "Authorization: Bearer $KEY" "$HUB_URL/api/v1/messages?limit=10"
   ```
3. **Confirm the device id.** It is derived from the H record sender
   `"name^id"` (first non-empty component), exactly as sent — case-sensitive.
   Copy the exact string; you'll register the device under it in §6.
   ```bash
   curl -H "Authorization: Bearer $KEY" "$HUB_URL/api/v1/messages?limit=5" | jq '.[].deviceId'
   ```
4. **Confirm clean sessions.** `npm run simulate -- --device <name> --id <id>`
   is the bench reference (it emits the reference layout). For the real device,
   watch for NAK loops: the hub logs
   `ASTM checksum mismatch: expected X, computed Y` on `onSessionError`. Zero
   NAKs on a clean cable is the goal. If the device *requires* echoed frame
   numbers or excludes STX from its checksum, that is a known extension point
   (see §3, "honest limits") — log a support case with a captured capture file.

> **Capture hygiene.** Everything the hub received is already stored — raw wire
> text, parsed records, canonical payload, timeline. You do not need a packet
> sniffer; you need *representative* samples. Do not hand-edit values in a
> transcript; if a sample is bad, capture another.

---

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
| 8 | Optional fields populated: name with `^` components, absent reference range, result status (`F` vs `P`) | field-level tolerance |

Capture **at least 3 good messages per scenario**, from different patients.
Label each in your notes: scenario, sample, expected values from the lab system.
The golden library stores the *records* (protocol text), so the transcripts are
self-contained — no fixture patients needed later.

Negative cases: on this platform a message that cannot be associated is parked
(`FAILED`, `HELD`), never dropped — that is the safety gate working. In goldens,
negative cases assert the *issues* the pipeline must report.

---

## 3. Author the profile (layout + mappings + session)

### 3.1 The shape (zod-validated at the API boundary)

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
  "status": "draft"              // → "certified" only after §5 passes
}
```

The layout above is the **reference layout** (the simulator's). Start from it
and change only what the vendor manual + your transcripts prove differs.

### 3.2 Deriving layout offsets

For each record type, line up the captured fields against the canonical
meaning the device intends (from the vendor manual). Positions are 1-based.
Examples from this codebase's certified profiles:

- **P record** — `["1", "", "PID-1001", "Adeyemi^Tunde", "", "19850312", "M"]`
  → id=3, name=4, dob=6, sex=7. The pipeline flattens `^`-names to
  "Last, Given" automatically.
- **O record** — `["1", "S-4242", "ACC-424242", "^GLU^Glucose"]` → sampleId=2,
  accession=3, test=4. ⚠ Some vendors swap sample/accession — that is *the*
  classic mis-association bug. The seeded `acme-chem-200` profile exists
  precisely because its O record is `["1", "ACC…", "S-…", "^GLU^"]` (accession
  first): under the reference layout the accession becomes the sample id and
  results mis-associate; under its own profile they land correctly. **If your
  device's transcript shows that swap, your profile is the acme shape.**
- **R record** — `["1", "^GLU^Glucose", "95", "mg/dL", "70-110", "N", "", "F"]`
  → test=2, value=3, unit=4, referenceRange=5, flag=6, status=8.

### 3.3 Mappings

Device test code → canonical code. Lookups try the exact code then its
uppercase form; an unmapped code passes through unchanged and triggers a
`testKnown` warning in validation. Map every test your analyzer can emit —
at minimum every code in your transcripts, ideally the whole vendor code list.

### 3.4 Honest limits of this milestone (read before promising a fix)

The `connection` and `session` blocks are **modeled in the profile schema but
not yet consumed by the frame/session codec**. Specifically:

- `checksumIncludesStx` — documented config point; today the codec always
  includes STX in the mod-256 sum. A device that excludes STX will NAK-loop.
- `frameNumbering: "echo"` — the session accepts bare ACK/NAK; echoed frame
  numbers are not yet implemented.
- `initiator: "host"` — the hub session is responder-only; a device that waits
  for the host to initiate is not yet supported.

If the analyzer needs any of these, **capture the failing transcript, open a
support case**, and do not proceed — a checksum-mismatch loop is a hard stop,
not a config tweak. Layout, mappings, and identity/version stamping are fully
wired; session-level behavior is the remaining seam (plan workstream L / Phase 4).

### 3.5 Save it as a draft

```bash
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d @profile.json $HUB_URL/api/v1/profiles
# → 201 with the validated profile; a zod failure returns 400 with issues.
curl -H "Authorization: Bearer $KEY" $HUB_URL/api/v1/profiles/<ID>   # read back
```

Then **bind your device to it immediately** (§6) so subsequent captured
messages are canonicalized with *your* layout — that is how you confirm the
layout is right before investing in goldens. Watch the console message viewer:
if the canonical patient/order/results now look correct, the layout is right;
if the accession landed in the sample-id slot (or vice versa), adjust the O
record offsets and re-verify.

---

## 4. Author the golden file (`goldens/<profile-id>.json`)

A golden file embeds **the profile it certifies** plus cases. Lookup matches
embedded `profile.id`, so the filename only needs to be unique JSON in
`goldens/`. Model on `goldens/reference.json` / `goldens/acme-chem-200.json`:

```json
{
  "profile": { /* the profile EXACTLY as it will ship certified: layout,
                  mappings, capabilities, version, status, certifiedAt */ },
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

- **`records`** are the captured transcript verbatim (`jq '.records'` from §2).
  `\\^` in JSON is the literal `\^` delimiter component.
- **`expected` is a partial comparison** — assert only the fields that prove
  layout + mappings (patient id/name/dob/gender, order id/sampleId, each
  result's `testCode` (mapped!), `originalTestCode`, value, unit, flag, …).
  Results are compared by count and index; a golden with no `expected.results`
  still asserts `payload !== null` and the patient/order fields.
- **Negative cases** use `expected.expectIssues` with the *exact* pipeline
  issue text, e.g. `"Missing patient identifier"`. For a negative case the
  pipeline **must** produce no payload.
- The **embedded profile version must equal the version you will certify** —
  it is the `certifiedVersion` baseline every later message is compared
  against (drift enforcement, §7).

Put the file in `goldens/` (the default library dir; a non-default deployment
can point `HUB_GOLDENS_DIR` at its own copy — the Docker image ships `goldens/`).

---

## 5. Run the conformance gate

Every `goldens/*.json` runs through the real pipeline in CI —
`packages/core/src/goldens.test.ts`, executed by `npm test` and
`npm run test:db`:

```bash
npx tsx --test packages/core/src/goldens.test.ts    # fast loop: just the gate
npm run build                                       # types clean
npm run test                                        # full suite (DB-gated tests skip)
npm run test:db                                     # full suite against Postgres (needs db:up)
```

The gate fails if *any* case in *any* golden file fails, and the failure text
names case + mismatch (`patient.id: expected "…", got "…"`). The suite also
asserts your file's embedded profile parses (zod) and has a valid status.

Iterate here — this is the expensive part to get right, and it is why the
fictional reference/acme profiles ship as the certified examples: the gate
*proves* the Acme transcript fails under the reference profile (profiles
matter) and passes under its own.

### Promote to certified

Only after the gate is green and a reviewer has eyeballed the transcripts
against the vendor manual:

```bash
# status → "certified", set certifiedAt, keep version = the golden's version
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d @profile-certified.json $HUB_URL/api/v1/profiles
# the console now shows the green "certified" badge and, per profile:
curl -H "Authorization: Bearer $KEY" $HUB_URL/api/v1/profiles/<ID>/conformance
# → available: true, run.passed == run.cases.length
```

The conformance endpoint re-runs the *stored* profile against its recorded
goldens — after promotion it should read **passed ✓ n/n**.

---

## 6. Bind the device and verify live

Register the device with **the exact id from the H record** (§1.3) and the
profile id. The binding is what makes the gateway canonicalize with your
layout:

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
- `status` in `ROUTED` / `HELD` — see the troubleshooting table for HELD/FAILED.
- `profile` = `{ "id": "<profile id>", "version": 1, "certifiedVersion": 1,
  "drift": false }` — **`drift` must be false** for every message. `drift:
  true` means the stored profile no longer matches the version its goldens
  were recorded under (an edit happened, or the store was reseeded); results
  still flow but are flagged (⚠ drift in the console) — fix the version
  mismatch before trusting results.
- Canonical payload correct: mapped codes (`GLUCOSE`, with
  `originalTestCode: GLU`), right patient/order, right units/flags.

Full acceptance loop with the expected-order registry (the LIS seam) so
results route instead of parking in HELD:

```bash
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"id":"<ACCESSION>","patientId":"<PATIENT_ID>","tests":["GLUCOSE"]}' \
  $HUB_URL/api/v1/orders
```

---

## 7. Versioning & drift discipline (after certification)

- The golden file's embedded profile version is the **certification baseline**.
- **Any change** to layout, mappings, or session config = **bump `version`** on
  the stored profile and re-run the gate. Do not edit a certified profile
  in place at the same version.
- If a change breaks a golden, the conformance endpoint and CI fail, and live
  messages stamp `drift: true` with a `FLAGGED` timeline note naming both
  versions — that is the enforcement working, not a bug. Either fix the
  profile back or certify a new version with updated goldens
  (goldens are recorded *per version* in the model).
- Every message keeps its `profile` stamp through replay, so a stored result
  is always attributable to the exact config that parsed it.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No device appears / no messages | Wrong host/port on the analyzer; TLS mismatch | Point device at hub `DEVICE_PORT`; if TLS, import `tls/ca.pem` into the device's trust store |
| `ASTM checksum mismatch` in logs | Physical layer noise, or device excludes STX from checksum | Re-check cabling first; if persistent, device needs `checksumIncludesStx:false` — codec config point not yet wired (support case, §3.4) |
| Session hangs after ENQ | Device expects host to initiate or frame-number echo | Not yet supported (§3.4) — capture transcript, raise a case |
| Messages `FAILED` with `Missing patient identifier` / `Missing order identifier` | Layout offsets wrong for P/O records | Diff §2 transcript against vendor manual; fix layout, re-capture |
| Message parks in `HELD` | Matching couldn't associate (no expected order), or error-severity validation | Register the expected order (`POST /api/v1/orders`); check `match` + `errors` on the message |
| Canonical accession == sample id (or swap) | O record offsets wrong (the acme case) | Swap `order.sampleId` / `order.accession` in the layout |
| `testKnown` warnings on the timeline | Analyzer code unmapped | Add to `mappings`; bump version if already certified |
| Conformance endpoint shows ✗ after an edit | Stored profile drifted from its golden version | Bump version + re-certify, or revert the edit |
| Messages stamped `drift: true` | Stored version ≠ golden-recorded version | Align versions (§7); check nothing reseeded a stale profile |
| NAKs on the bench but fine in production | Different cabling/termination | RS-232: baud/parity/data-bits must match both ends (`connection` block) |

---

## 9. Sign-off checklist

- [ ] ≥3 good transcripts per scenario from §2, including ≥1 negative case,
      captured from the **real instrument** (not hand-typed).
- [ ] Profile draft bound to the device; canonical payload verified correct
      on live messages; `profile.drift` false.
- [ ] `goldens/<profile-id>.json` committed; `goldens.test.ts` green both
      locally and on CI (`npm test` + `npm run test:db`).
- [ ] Profile promoted to `status: "certified"` with `certifiedAt`; the
      console shows the certified badge and conformance **passed ✓ n/n**.
- [ ] Device registration committed/scripted with the exact H-record id +
      `profileId` so a rebuild of the hub restores the binding.
- [ ] **7-day soak** on Postgres: zero silent drops, zero NAK loops, no
      unexpected HELD/FAILED growth (alert rules `device-offline`,
      `held-backlog`, `dlq` cover this).
- [ ] Version-discipline note written into the facility's change log: any
      future edit bumps `version` and re-runs the gate.

Deliverable: profile id + golden file + device binding + the soak report. That
combination is what "certified" means on this platform — the rest of the
pipeline is config, not code.

---

## 10. The M3 exit drill — imaging certification gate (workstream K)

The imaging counterpart to the ASTM golden gate. Where §§1–7 certify a lab
analyzer by *recorded transcripts* replayed through the ASTM pipeline, the M3
exit drill certifies the imaging chain (plan §7.C / §13.16) by driving it
**live over real DICOM networking**: a pynetdicom *fake modality* stands in
for an actual CT scanner and walks the entire order → worklist → store → route
path against a real Orthanc, with failure injection. Passing the drill is the
M3 exit gate.

### 10.1 Components

| Piece | Where | Role |
| --- | --- | --- |
| Fake modality | `scripts/dicom-modality/fake_modality.py` | pynetdicom AE that answers C-ECHO, C-FINDs the worklist, C-STOREs performed studies, and can refuse stores (`--refuse`) |
| Orthanc | `docker compose up -d --build orthanc` (`medconnect-orthanc:0.2.0`) | the DICOM engine; its Worklists plugin holds the MWL, its ModalityMonitor C-ECHOs registered modalities |
| Hub (drill-booted) | `startHub` inside `scripts/demo-m3-exit.ts` | in-memory, auth-disabled, with `orthanc` + modality-monitor wiring; MLLP listener (ADT/ORM); MWL monitor; imaging router; device registry + alerts |

No live hub, no Postgres, and no PACS peer are needed — the drill boots its own
hub and cleans up after itself: the modality config, patients, and worklist
items are removed, so Orthanc is left exactly as it was.

### 10.2 Prerequisites

```bash
docker compose up -d --build orthanc      # derived image incl. the Worklists plugin
python3 -m venv .venv && .venv/bin/pip install pynetdicom   # the fake modality's AE stack
npm run build
```

The fake modality runs **on the host** and Orthanc must reach it back through
the compose container, so `host.docker.internal` has to resolve inside the
Orthanc container — automatic on Docker Desktop; on Linux add
`extra_hosts: ["host.docker.internal:host-gateway"]` to the compose `orthanc`
service.

Environment overrides: `ORTHANC_URL` / `ORTHANC_USER` / `ORTHANC_PASSWORD`
(defaults `http://127.0.0.1:8042` / `orthanc` / `orthanc`), `MODALITY_AET`
(default `FAKE-CT`), `MODALITY_PORT` (default `11112`), `MODALITY_PYTHON`
(default `.venv/bin/python`).

### 10.3 Run the gate

```bash
npm run demo:m3-exit
# exit 0  →  [drill] ═══ DRILL COMPLETE — ALL CHECKS PASSED ═══
# exit 1  →  one or more ✗ FAIL lines; the failing check names what broke
```

The drill prints one `✓` / `✗ FAIL` line per check; **any** ✗ makes it exit 1
— treat that as the M3 exit gate failing.

### 10.4 What each check proves

| # | Check | Proves |
| --- | --- | --- |
| 1 | `admission accepted (AA)` | ADT^A01 over MLLP parsed + accepted (the LIS patient feed) |
| 2 | `order accepted (AA)` | ORM^O01 over MLLP parsed + registered in the OrderRegistry |
| 3 | `order synced onto the Orthanc worklist` | MWL monitor pushed the registry order to the Worklists plugin — accepts `created` **or** `queued`, since the standing poller may have won the race |
| 4 | `C-FIND found the scheduled procedure` | a real modality query finds the worklist item (empty return-keys, the way real scanners query) |
| 5 | `C-STORE performed the study into Orthanc` | the performed study lands in Orthanc over DICOM |
| 6 | `performed study became a hub message` + `study routed through the dispatcher` + accession carried | the monitor's next poll sees the study and routes its metadata → `ROUTED` |
| 7 | modality `disconnected` + `device-offline` FIRING, then `connected` + resolved after restart | failure injection A: C-ECHO failure → device row + alert, auto-recovery |
| 8 | second study `FAILED` + `dlqAt`, then `ROUTED` + marker cleared after rule fix + retry | failure injection B: dead destination → DLQ (never a silent drop) → operator retry |

### 10.5 Failure-injection manual controls (fake modality CLI)

```bash
.venv/bin/python scripts/dicom-modality/fake_modality.py serve \
  --ae FAKE-CT --host 0.0.0.0 --port 11112 [--accept-store]
.venv/bin/python scripts/dicom-modality/fake_modality.py find-mwl \
  --ae FAKE-CT --orthanc 127.0.0.1 --port 4242 --accession ACC-X --expect
.venv/bin/python scripts/dicom-modality/fake_modality.py store \
  --ae FAKE-CT --orthanc 127.0.0.1 --port 4242 \
  --accession ACC-X --patient-id PID-1 --patient-name "Doe^John" --modality CT [--refuse]
```

- Killing the `serve` process = the modality going offline (drill failure A).
- `--refuse` on `store` = modality-side storage failure; nothing lands and the
  worklist item stays scheduled.
- `--expect` on `find-mwl` makes a missing match exit non-zero, so the query
  asserts the item was found.

### 10.6 Exit criteria for M3

- [ ] `npm run demo:m3-exit` passes clean (exit 0, all ✓) against a fresh
      `docker compose up -d --build orthanc`.
- [ ] The two failure injections actually fail before they are fixed — a drill
      that passes with the modality never going offline or the rule never
      pointing at a dead destination proves nothing. Introduce a deliberate
      regression (e.g. rule → dead port), confirm the ✗ appears, then restore.
- [ ] Orthanc is left pristine after the run: `GET /modalities`,
      `GET /patients`, and `GET /worklists` all empty.
- [ ] The chain also holds on Postgres: `npm run test:db` green (imaging
      messages persist through the PG store).

### 10.7 Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `C-ECHO failed` / modality never connects | Orthanc can't reach the host-run modality | Confirm the `serve` process is up; check `host.docker.internal` resolves inside the Orthanc container (§10.2) |
| `C-FIND found 0` although the worklist item exists | Query sent `PatientName="*"` — Orthanc's matcher treats `*` as *requiring* the tag to exist on the item | Send empty (return) keys like real modalities; feed an ADT first so the item carries the patient name |
| Check 3 reports `created=0 queued=0` | The order never reached the worklist | Order must be `active` with a `patientId`; confirm the ORM leg produced `AA` (check 2) |
| `unknown destination kind: hl7` when routing imaging | The imaging dispatcher lacks the outbound-HL7 deliverer | Both dispatchers must share the same MLLP pool — wire `deliverHl7Destination` into the imaging dispatcher |
| `host.docker.internal` unresolved (Linux hosts) | Docker Desktop's NAT hostname doesn't exist on Linux | Add `extra_hosts: ["host.docker.internal:host-gateway"]` to the compose `orthanc` service |