---
layout: home

hero:
  name: Integration Hub
  text: Healthcare device interoperability
  tagline: A single-box edge gateway that connects laboratory analyzers, imaging modalities and LIS/HIS systems — ASTM, HL7 v2 and DICOM in, one canonical pipeline, REST API and web console out.
  image:
    src: /logo.svg
    alt: Integration Hub
  actions:
    - theme: brand
      text: Get started
      link: /guide/overview
    - theme: alt
      text: View on GitHub
      link: https://github.com/MyLikita-Health/MedConnect

features:
  - title: Protocol gateways
    details: ASTM E1381/E1394 analyzers over TCP, HL7 v2 (ORU/ORM/ADT) over MLLP, and DICOM imaging through Orthanc — all into one canonical model.
  - title: Clinical safety gate
    details: Patient/order matching and result validation before anything is delivered. Ambiguous or invalid results are HELD for operator review — never silently assigned.
  - title: Durable delivery
    details: Retry with backoff, dead-letter queue, dedup and replay. Every message keeps a full audit timeline from wire to destination.
  - title: Imaging & MWL
    details: Orthanc worklist monitoring, performed-study routing and PACS forwarding — lab results and imaging in the same viewer.
  - title: Security first
    details: API-key auth with per-role scopes, an audit log of every mutation, signed (Ed25519) remote updates, and optional TLS on every listener.
  - title: Single-box Windows edge
    details: A native NSIS installer with a supervised Windows service and embedded SQLite — runs fully offline, pairs to the cloud when ready.
---