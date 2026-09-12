# Licensing & the AGPL boundary

For procurement, compliance and security review: how the hub integrates
AGPL-licensed software (the Orthanc DICOM engine and its plugins) while
keeping its own license clean. The boundary is an **architectural invariant**
enforced by a code-review gate — breaking it would contaminate the hub's
license, so it is treated as a safety property, not paperwork.

## The rule in one sentence

**AGPL components (Orthanc, its plugins) are always separate processes that
the hub talks to over a network API — never embedded, linked, statically
linked, vendored, or forked into hub code.**

## What ships and how it enters the picture

| Component | License | How it enters the picture | Boundary status |
| --- | --- | --- | --- |
| **Orthanc** (DICOM engine) | AGPLv3 | Separate container/process (compose service, or a customer-provided Orthanc at `ORTHANC_URL`) | ✅ Separate process, REST only |
| **orthanc-worklists plugin** | AGPLv3+ | Shared library loaded **inside the Orthanc process** by Orthanc itself | ✅ Runs in the Orthanc process, not the hub |
| **PACS/archive Orthanc** | AGPLv3 | Separate container used as a forwarding peer | ✅ Separate process, REST/peer API |
| Hub DICOM adapter | hub's own license | REST client for Orthanc's HTTP API | ✅ No AGPL code; plain HTTP |

The hub never links against Orthanc binaries or headers at build time, and
the hub's runtime never loads an Orthanc shared library into its own address
space. The DICOM adapter is a plain HTTP client (fetch over REST).

## The one subtle case: the derived Docker image

The `docker/orthanc/` image bundles Orthanc **and** the worklists plugin
`.so` **in the same container**. This is still compliant:

- The `.so` is loaded by the **Orthanc process** (via Orthanc's own plugin
  mechanism), not by the hub.
- The hub process is a different container/process that reaches Orthanc over
  REST.
- No AGPL object code is linked into, or loaded by, the hub executable.
- The plugin is compiled from source **inside the Orthanc image's build
  stage** (against the Orthanc plugin SDK) and the toolchain is discarded —
  the resulting `.so` never touches hub code.

Both binaries coexisting in one container is fine: AGPL obligations attach to
**distribution of the AGPL work**, not to co-location with other software.
The hub does not create a derivative work of Orthanc.

## What is forbidden (and how review catches it)

| Forbidden | Symptom to catch in review |
| --- | --- |
| Linking any Orthanc/plugin library into hub packages | A dependency on `libOrthanc*`, Orthanc SDK headers, or Orthanc source in hub packages |
| Forking/copying Orthanc or plugin source into the repo | Vendored AGPL source files outside `docker/orthanc/` |
| Loading a plugin `.so` from hub code (`dlopen`/`LoadLibrary`) | `dlopen`/`LoadLibrary`/`ffi` usage targeting Orthanc artifacts |
| Running Orthanc in-process (thread embedding) | Hub code calling into Orthanc C/C++ APIs |
| Shipping modified Orthanc/plugin binaries as "our" component | The derived image must remain an Orthanc image with config/plugin additions, not a rewrite |

**Review gate:** every PR touching imaging must not add AGPL code to hub
packages. `docker/orthanc/` is the **only** place AGPL material may live (as
a derived image build).

## Customer-provided Orthanc

The hub treats Orthanc as a **pluggable resource**: `ORTHANC_URL` points at
any Orthanc — the bundled image, a facility-managed instance, or a vendor
appliance:

- A facility that already runs Orthanc can point the hub at it; the hub
  ships no Orthanc in that deployment at all.
- The bundled image is the convenience default for pilot/demo.
- The AGPL boundary is **identical** in both cases (REST only).

## Distribution obligations

Running AGPL software in a separate process does not remove the usual
obligations when we **distribute** the Orthanc image or its derived image:

- Offer the corresponding source for Orthanc + the worklists plugin (both are
  publicly available upstream; the Dockerfile records exact versions).
- Keep the AGPL license texts present in the distributed image (upstream
  images do this; the derived image inherits them).
- Do not claim the Orthanc/plugin components as our own proprietary work.
- When the hub itself is offered as a network service (SaaS), the AGPL
  **server-side** trigger applies to the *Orthanc* component too; the
  offering must provide Orthanc source access as AGPL requires.

## Upgrading Orthanc

Upgrades are a one-line bump in `docker/orthanc/Dockerfile`
(`ORTHANC_BASE_IMAGE` / `WORKLISTS_VERSION`) followed by
`docker compose up -d --build orthanc`. Before bumping:

- Check the new Orthanc release notes for config/API changes the adapter
  relies on (`/worklists/*`, `/modalities/*`, `/peers/*`, `/studies/*`).
- Re-run `npm run demo:dicom` + `npm run demo:mwl` against the rebuilt image.
- Re-verify the worklists plugin release exists for the new Orthanc (the
  plugin's CMake pins its own SDK version; build from source in the image).

See also: [Devices & connections](/guide/devices) for what the hub does over
the Orthanc API, and [Infrastructure](/guide/infrastructure) for deployment
topologies.
