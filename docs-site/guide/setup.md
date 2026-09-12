---
title: Setup
description: First boot, the setup wizard, API keys and roles, and cloud pairing.
outline: [2, 3]
---

# Setup

## First boot

Start the hub (any install shape) and open the console at
`http://<hub-host>:3000/`. On first boot the console shows the **setup
wizard** instead of the dashboard. Completing it:

- mints the **admin API key** — shown **exactly once** (copy it now);
- stores first-boot settings in the local settings store (applied on every
  restart — env still wins);
- closes the wizard permanently (`GET /api/v1/setup/status` flips
  `firstBoot: false`).

> The setup routes are public **only while the hub is unconfigured** —
> fail-closed in the route and the auth hook. Once setup completes, they
> refuse.

## API keys and roles

Every `/api/v1` route (except `health`) requires
`Authorization: Bearer <key>`. Only a SHA-256 **hash** of each key is
stored; the plaintext is returned exactly once, at creation.

| Role | Grants | Persona |
| --- | --- | --- |
| `viewer` | read everything | monitoring, read-only audit |
| `operator` | + replay, DLQ discard, HELD release | lab bench / exception queue |
| `engineer` | + register devices, configure destinations/routes/orders/alert rules/profiles | Integration Engineer |
| `admin` | + manage API keys, view audit log | Facility / IT Admin |

### Creating keys

```bash
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"name":"night shift","role":"operator"}' \
     http://127.0.0.1:3000/api/v1/keys        # secret shown once
```

Lifecycle (all admin-only, each mutation audited):

- **Rename / disable / expiry** via `PATCH /api/v1/keys/:id` — disabled or
  expired keys refuse authn but stay listed; you cannot disable the key
  you are using (lockout guard).
- **Rotate** via `POST /api/v1/keys/:id/rotate` — mints a new secret for
  the same key identity; old secret revoked immediately. The response
  warns when the outgoing secret was **never used** since issuance.
- **Revoke** via `DELETE /api/v1/keys/:id` (you cannot delete the key in
  use).

The console's **Access keys** panel (admin) does all of this inline, and
the `hub-key` CLI drives the same surface:

```bash
npx tsx scripts/key-cli.ts list|create|rename|disable|enable|expiry|rotate|delete
```

## Pairing

A local edge can join the cloud platform later. Pairing uses a claim code
(`ihp_…`) driven from the edge console:

- `GET /api/v1/pairing/status` — identity + sync endpoint, never the key;
- `POST /api/v1/pairing/claim` — public **only while unpaired**; proxies
  the code to the cloud and validates + persists the bundle;
- `POST /api/v1/pairing/unpair` — admin-only.

After claiming, restart the hub: on boot it applies the stored bundle and
runs the **outbox syncer** — every locally stored message ships to the
cloud with tenancy stamps, and acknowledgements drain the backlog. The
gateway key (`ihk_gw_…`) is stored at rest and **never echoed** back over
the API.

## Demo datasets

For a quick look at every feature with seeded data:

```bash
npm run demo:sandbox   # seeds a rich demo dataset and prints a curl walkthrough
```

The scripted end-to-end demos (`npm run demo`, `demo:hl7`, `demo:outbound`,
`demo:dicom`, `demo:mwl`, `demo:routing`, `demo:m3-exit`, `demo:update`)
each prove one vertical end to end and are safe to re-run.