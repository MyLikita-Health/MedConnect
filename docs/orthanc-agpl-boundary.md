# AGPL Boundary Policy — Orthanc Integration (plan §7.5.5)

> **Status:** M3.5 (C5) deliverable. Applies to every component the hub ships
> or drives that is AGPL-licensed. The boundary is an **architectural
> invariant**, not a paperwork formality: a code-review gate checks it (risk
> R5 in the plan), and breaking it would contaminate the hub's license.

## 1. The rule in one sentence

**AGPL components (Orthanc, its plugins) are always separate processes that
the hub talks to over a network API — never embedded, linked, statically
linked, vendored, or forked into hub code.**

## 2. What the hub actually ships / uses

| Component | License | How it enters the picture | Boundary status |
| --- | --- | --- | --- |
| **Orthanc** (DICOM engine) | AGPLv3 | Separate container/process (`orthanc` compose service, or a customer-provided Orthanc at `ORTHANC_URL`) | ✅ Separate process, REST only |
| **orthanc-worklists plugin** | AGPLv3+ | Shared library loaded **inside the Orthanc process** by Orthanc itself | ✅ Runs in the Orthanc process, not the hub |
| **pacs/archive Orthanc** | AGPLv3 | Separate container used as a forwarding peer | ✅ Separate process, REST/peer API |
| `@integration-hub/dicom` (hub code) | hub's own license | REST client for Orthanc's HTTP API | ✅ No AGPL code; talks HTTP |

The hub never links against Orthanc binaries or headers at build time, and
the hub's runtime never loads an Orthanc shared library into its own address
space. `@integration-hub/dicom` is a plain HTTP client (fetch over REST).

## 3. The one subtle case: the derived Docker image

`docker/orthanc/Dockerfile` produces an image that bundles Orthanc **and** the
worklists plugin `.so` **in the same container**. This is still compliant:

- The `.so` is loaded by the **Orthanc process** (via Orthanc's own plugin
  mechanism), not by the hub.
- The hub process is a different container/process (`packages/server` image)
  that reaches Orthanc over REST.
- No AGPL object code is linked into, or loaded by, the hub executable.
- The M3.5 build step compiles the plugin from source **inside the Orthanc
  image's build stage** (against the Orthanc plugin SDK) and discards the
  toolchain — the resulting `.so` never touches hub code.

Both binaries coexisting in one container is fine: the AGPL obligations
attach to **distribution of the AGPL work**, not to co-location with other
software. The hub does not create a derivative work of Orthanc.

## 4. What is forbidden (and how the review gate catches it)

| Forbidden | Symptom to catch in review |
| --- | --- |
| Linking any Orthanc/plugin library into hub packages | A dependency on `libOrthanc*`, Orthanc SDK headers, or Orthanc source in `packages/*` |
| Forking/copying Orthanc or plugin source into this repo | Vendored AGPL source files outside `docker/orthanc/` |
| Loading a plugin `.so` from hub code (`dlopen`/`LoadLibrary`) | `dlopen`/`LoadLibrary`/`ffi` usage targeting Orthanc artifacts |
| Running Orthanc in-process (thread embedding) | Hub code calling into Orthanc C/C++ APIs |
| Shipping modified Orthanc/plugin binaries as "our" component | The derived image must remain an Orthanc image with config/plugin additions, not a rewrite |

**Review gate:** every PR touching imaging must not add AGPL code to
`packages/*`. The `docker/orthanc/` directory is the **only** place AGPL
material may live (as a derived image build), and that directory's
responsibility is documented in this policy.

## 5. Customer-provided Orthanc (decision D10)

The hub treats Orthanc as a **pluggable resource**: `ORTHANC_URL` points at
any Orthanc (bundled image, facility-managed instance, or a vendor appliance).
This means:

- A facility that already runs Orthanc can point the hub at it — the hub
  ships no Orthanc in that deployment at all.
- The bundled compose image is the convenience default for pilot/demo.
- The AGPL boundary is **identical** in both cases (REST only).

## 6. Distribution obligations (what we must still do)

Running AGPL software in a separate process does not remove the usual
obligations when we **distribute** the Orthanc image or its derived image:

- Offer the corresponding source for Orthanc + the worklists plugin (both are
  publicly available upstream; the Dockerfile records exact versions).
- Keep the AGPL license texts present in the distributed image (upstream
  images do this; our derived image inherits them).
- Do not claim the Orthanc/plugin components as our own proprietary work.
- When the hub itself is offered as a network service (SaaS — M4 cloud), the
  AGPL **server-side** trigger applies to the *Orthanc* component too; the
  facility-cloud offering must offer Orthanc source access as AGPL requires.

## 7. Version pins (upgrade path)

Upgrades are a one-line bump in `docker/orthanc/Dockerfile`
(`ORTHANC_BASE_IMAGE` / `WORKLISTS_VERSION`) followed by
`docker compose up -d --build orthanc`. Before bumping:

- Check the new Orthanc release notes for config/API changes the adapter
  relies on (`/worklists/*`, `/modalities/*`, `/peers/*`, `/studies/*`).
- Re-run `npm run demo:dicom` + `npm run demo:mwl` against the rebuilt image.
- Re-verify the worklists plugin release exists for the new Orthanc (the
  plugin's CMake pins its own SDK version; build from source in the image).

## 8. Ownership

The boundary policy lives in the plan (§7.5.5, risk R5) and this document;
the architect owns it, and the M3 exit drill re-verifies it (the drill's
modality harness speaks DICOM to Orthanc — still the hub doing REST only).