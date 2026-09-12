# Security & privacy

A statement for hospital IT, security and compliance reviewers evaluating the
Integration Hub. Every claim here describes shipped behavior and is verifiable
in the repository (pointers included). Questions this page does not answer
should go to the integration team — this page is the contract, not marketing.

## At a glance

| Question | Answer |
| --- | --- |
| Where does patient data live? | **On the box.** Embedded SQLite in the hub's data directory; nothing is sent anywhere except destinations the facility configures |
| Network telemetry / phone-home? | **None.** The hub makes no outbound connection except to facility-configured endpoints (updates source, cloud gateway when paired) |
| Who can act on the system? | API keys mapped 1:1 to four roles with fixed scope grants; every mutating action is attributed in the audit log |
| Is clinical data protected in transit? | Optional TLS on **all three** listeners (API, ASTM, HL7/MLLP) with facility-supplied certificates |
| Who reviews the safety gate? | Ambiguous or invalid results are HELD for operator review — the pipeline never silently assigns them |

## Data locality and residency

- All persistent state lives in one on-disk directory (`HUB_DATA_DIR`):
  `hub.sqlite` (the embedded store, WAL mode), `state/` (signed-update
  bookkeeping), and `logs/hub.log`. There is no other copy.
- The hub is designed to run **fully offline**: device ingestion, matching,
  validation, routing, DLQ/HELD and the console all work with no internet
  connection.
- **No telemetry.** There is no analytics, crash-reporting or metrics
  endpoint in the hub process; the string list of every URL the server/core
  packages can contact is exactly the facility-configured set (destinations,
  Orthanc at `ORTHANC_URL`, the update source, the cloud gateway only after
  an explicit pairing).
- **Cloud is opt-in.** When the facility pairs the hub to the cloud (W4), an
  explicit claim code exchanges for a gateway credential, and the hub then
  syncs to that one configured base URL. Unpairing revokes it. Nothing cloud
  flows without that deliberate step.

## Authentication and authorization

- **API keys, four roles.** Every key maps to exactly one role — `admin`,
  `engineer`, `operator`, `viewer` — and each role carries a fixed scope set
  (PRD §34 RBAC model). `viewer` is read-only; lifecycle actions (replay,
  HELD release, DLQ discard) need `operator` or above; configuration needs
  `engineer`; key management and updates need `admin`.
- **Fail closed.** The route→scope table denies anything not explicitly
  listed — a new API route is inaccessible until a scope is added for it.
  Unauthenticated calls get 401; authenticated-but-unauthorized get 403.
- **Secrets are stored hashed.** Only a SHA-256 hash of each key secret is
  persisted (plus a short display prefix); the plaintext is shown exactly
  once at creation/rotation and never stored. Key rotation mints a new
  secret and revokes the old hash in one step.
- **Key lifecycle controls:** enable/disable, ISO expiry timestamps (expired
  keys refuse auth but stay listed for rotation ergonomics), last-used
  tracking, and a "never seen" warning when rotating a secret that was
  issued but never used.
- **First boot is the only unauthenticated window.** The setup-completion
  endpoint is public *only* while the hub is unconfigured and **403s itself
  permanently** once setup completes (fail closed — see `SETUP_COMPLETE_ROUTE`
  in `packages/api/src/security.ts`). The same pattern guards cloud pairing
  (the pairing code is the credential; the claim route 409s itself once
  paired). The minted admin key is displayed exactly once.
- **The console uses the same RBAC.** The web console is a static page that
  authenticates with a regular API key; without a key it can only see the
  public status endpoints (setup status, health).

## Audit trail

Every mutating API action is recorded with **who / what / when / where /
result** (PRD §30): actor key id, name and role, the route *pattern* (not
the concrete path), the target object id, `ok` / `error` / **`denied`**, the
HTTP status, the source IP, and before/after context for configuration
changes. Denied attempts are attributed too — the audit log is a record of
attack surface as much as of use. Read access to the audit log itself
requires the `audit:read` scope (admin).

## Encryption in transit

TLS is available on **all three** listeners with facility-supplied PEM
certificates (`HUB_TLS_CERT` / `HUB_TLS_KEY`):

| Listener | Default | With TLS |
| --- | --- | --- |
| API + web console (`PORT`, 3000) | HTTP | HTTPS |
| ASTM device listener (`DEVICE_PORT`, 5000) | plain TCP | TLS |
| HL7 MLLP listener (`HL7_PORT`, opt-in) | plain MLLP | MLLP over TLS |

The Orthanc imaging connection is typically loopback (`127.0.0.1:8042`) when
bundled; for a remote, facility-managed Orthanc use `ORTHANC_USER` /
`ORTHANC_PASSWORD`, and front it with your own TLS-terminating layer if it
leaves the host.

## Updates and supply chain

- Hub releases are distributed as installers with **published SHA-256
  checksums** (`SHA256SUMS.txt` per release) — verify before installing.
- The remote-update channel is **signature-enforced**: update manifests are
  signed with **Ed25519** by the vendor's offline key, and the hub verifies
  every manifest against the pinned `UPDATE_PUBLIC_KEY` before applying
  (see `packages/core/src/updates/`). Unsigned or wrongly signed manifests
  are rejected; the supervisor applies releases with health-gated boots and
  automatic rollback to the last-good release.
- Windows installers are Authenticode-signed (in progress at the time of
  writing — the signing pipeline runs, the certificate was pending as of
  v0.1.0-rc.7).

## Network exposure by default

- The hub binds to **`127.0.0.1` by default** (`HOST` env). It does not
  listen on the LAN unless configured to.
- The Windows installer opens exactly one firewall rule for the **device
  listener** on the *local-network* profile (never public) so analyzers can
  reach `DEVICE_PORT`.
- The optional Orthanc sidecar binds REST to loopback only (`127.0.0.1:8042`)
  and DICOM to `4242` behind a private-profile firewall rule for modalities.

## Patient safety gate (privacy-relevant behavior)

Matching and validation happen **before** any delivery. A result that cannot
be confidently associated with a patient/order — or that fails validation —
is parked as `HELD`/`FAILED` with the reason on its timeline. It is never
silently assigned or forwarded, and releasing a HELD message is an explicit,
audited operator action. Every message carries a full audit timeline from
raw wire bytes to delivery, and device-profile version stamping makes every
stored result attributable to the exact configuration that parsed it.

## Honest limitations

We state these plainly so your risk assessment can account for them:

1. **Console key in `localStorage`.** The web console stores the operator's
   API key in the browser's `localStorage` for convenience. On a shared
   clinical workstation this is a real consideration — prefer per-user OS
   accounts, log out (the console clears the key), or use a `viewer`-role
   key on shared machines. Server-side session handling is on the roadmap.
2. **Device protocols are plaintext-first by default.** ASTM/HL7 links run
   unencrypted unless TLS is configured; most analyzers sit on an isolated
   lab VLAN, but the TLS option exists and should be enabled where the
   network is not physically controlled.
3. **SQLCipher-style at-rest encryption is not built in.** The SQLite store
   relies on OS/file-system protections; the recommended deployment keeps
   the data dir under the OS-managed profile location. Disk-level encryption
   (BitLocker) is the current at-rest control.
4. **No per-request rate limiting yet.** The API has no built-in throttling;
   exposure control is network-level (loopback default, firewall rules).
5. **Admin key bootstrap.** The first admin key is minted at setup
   completion (or pinned via `HUB_ADMIN_KEY`); whoever completes first boot
   holds it. Protect physical access to the box during installation.

## Data retention and deletion

- The hub keeps the message store (wire text, parsed records, canonical
  payloads, timelines) in the embedded SQLite file; retention windows are a
  facility policy decision — there is no forced remote copy to reconcile
  with.
- **Uninstall keeps the data directory** (never destroys clinical records as
  a side effect); deleting it is a separate, explicit step with a backup
  prompt. This makes data lifecycle (including GDPR-style erasure
  workflows) a deliberate operator action, not an accident.

## Certifications posture

The hub is pre-certification. There is no HIPAA Business Associate Agreement
framework, ISO 27001 certificate, or SOC 2 report at this stage. The
architecture above (data locality, no telemetry, RBAC + audit, signed
updates) is the foundation that certification work will build on; contact
the team for the current compliance roadmap.

## Where to verify

Everything on this page is checkable in the repository:

| Claim | Where |
| --- | --- |
| Roles/scopes, fail-closed table, hashed keys | `packages/api/src/security.ts` |
| SQLite key/audit stores (hash at rest) | `packages/api/src/sqlite/sqlite-security.ts` |
| TLS on all three listeners | `packages/server/src/index.ts` (`HUB_TLS_*`) |
| Default loopback binding | `packages/server/src/cli.ts` (`HOST` default) |
| Ed25519-verified updates + rollback | `packages/core/src/updates/` |
| First-boot fail-closed setup/pairing | `SETUP_COMPLETE_ROUTE` / `PAIRING_CLAIM_ROUTE` handling |
| Release checksums | `SHA256SUMS.txt` on every GitHub release |
