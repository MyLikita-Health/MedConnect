# docs-site

The public documentation site (VitePress) rendered from
`docs-site/guide/*.md` + `docs-site/reference/*.md`. It deploys
automatically to <https://mylikita-health.github.io/MedConnect/> on every
push to `main` that touches `docs-site/**`
(`.github/workflows/docs.yml`).

```bash
npm run docs:dev       # local dev server with hot reload (localhost:5173)
npm run docs:build     # production build (dead-link check runs here)
npm run docs:preview   # preview the production build locally
```

## Keeping the site current

**Rule: a slice that changes behavior updates the site in the same change** —
the same rule as §21 of `docs/user-manual.md`, which this site mirrors for a
user-facing audience.

Manual section → site page mapping:

| When you touch… | Update the site at… |
| --- | --- |
| §1–2 what it is / architecture | `guide/overview.md` |
| §3 installation & first boot | `guide/installation.md` |
| §4 configuration reference (env vars) | `reference/configuration.md` |
| §5 ports & endpoints | `guide/infrastructure.md` (+ `reference/configuration.md` port table) |
| §6 security (keys, roles, TLS) | `guide/setup.md` + `guide/infrastructure.md` |
| §7 the web console | `guide/usage.md` |
| §8 REST API reference | `reference/rest-api.md` |
| §9–11 device connectivity (ASTM/HL7/DICOM) | `guide/devices.md` |
| §12–14 pipeline, routing, DLQ/HELD/replay | `guide/usage.md` |
| §15 alerting | `guide/usage.md` |
| §16 profiles & conformance | `guide/devices.md` |
| §17 persistence | `guide/infrastructure.md` |
| §18 updates & supervisor | `guide/infrastructure.md` |
| §19 simulators & demos | `guide/usage.md` |
| §20 new failure modes | `guide/troubleshooting.md` |

After edits: `npm run docs:build` must pass (it dead-link-checks every
page). Deployment is automatic on push; verify at
<https://mylikita-health.github.io/MedConnect/>.

## Layout

- `index.md` — landing page (hero + features)
- `.vitepress/config.mts` — nav, sidebar, local search, theme; `DOCS_BASE`
  env var sets the subpath for GitHub Pages (`/MedConnect/` in CI)
- `guide/` — task-oriented guides (overview, infrastructure, installation,
  setup, devices, usage, troubleshooting)
- `reference/` — lookup pages (configuration env vars, REST API table)
- `public/` — static assets (logo, favicon)
