#!/usr/bin/env tsx
/**
 * D4 — Sandbox environment with seeded data (plan §7.D D4).
 *
 * Starts the hub, seeds a rich demo dataset via the API, sends a few
 * simulator messages through the full pipeline, and prints a curl-based
 * walkthrough of every endpoint — enough for a reference LIS/EHR vendor
 * to integrate without our help.
 *
 * Usage:
 *   npm run demo:sandbox            # in-memory (default)
 *   DATABASE_URL=... npm run demo:sandbox  # against Postgres
 */

import { startHub } from '../packages/server/src/index.js';
import { AnalyzerSimulator } from '../packages/simulator/src/analyzer.js';
import type { Hub } from '../packages/server/src/index.js';

const HOST = '127.0.0.1';
const hubUrl = (port: number) => `http://${HOST}:${port}`;

async function post(base: string, path: string, body: unknown, key?: string): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.status >= 400) {
    const text = await res.text();
    console.error(`  ✗ POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return undefined;
  }
  return res.status === 204 ? undefined : res.json();
}

async function get(base: string, path: string, key?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${base}${path}`, { headers });
  return res.json();
}

async function main() {
  console.log('═'.repeat(72));
  console.log('  Integration Hub — D4 Sandbox');
  console.log('═'.repeat(72));
  console.log();

  // ── 1. Start the hub ──────────────────────────────────────────────────
  const hub: Hub = await startHub({
    authDisabled: true,
    devicePort: 0,
    httpPort: 0,
  });
  const base = hubUrl(hub.ports.http);
  const devicePort = hub.ports.device;
  console.log(`[hub] started — API ${base} · devices tcp://${HOST}:${devicePort}`);
  console.log();

  // ── 2. Create an admin API key ────────────────────────────────────────
  console.log('─── API Key ───');
  const keyRes = await post(base, '/api/v1/keys', {
    name: 'sandbox-admin',
    role: 'admin',
  }) as { id: string; secret: string } | undefined;
  const adminKey = keyRes?.secret;
  if (adminKey) {
    console.log(`  admin key: ${adminKey}`);
    console.log(`  (save this — it is shown only once)`);
  }
  console.log();

  const api = (path: string) => `${base}${path}`;
  const auth = adminKey ? { authorization: `Bearer ${adminKey}` } : {};
  const jget = async (path: string) => (await fetch(api(path), { headers: auth })).json();
  const jpost = async (path: string, body: unknown) =>
    (await fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) })).json();

  // ── 3. Seed device profiles ───────────────────────────────────────────
  console.log('─── Device Profiles ───');
  await jpost('/api/v1/profiles', {
    id: 'astm-reference',
    manufacturer: 'Generic',
    model: 'ASTM Reference',
    protocol: 'ASTM',
    transport: 'tcp',
    version: 1,
    capabilities: ['results-up'],
    records: {},
    mappings: {},
  });
  console.log('  ✓ astm-reference (generic ASTM profile)');

  await jpost('/api/v1/profiles', {
    id: 'acme-chem-200',
    manufacturer: 'Acme Diagnostics',
    model: 'Chem-200',
    protocol: 'ASTM',
    transport: 'tcp',
    version: 1,
    capabilities: ['results-up'],
    records: { order: { accession: 4, sampleId: 3 } },
    mappings: { GLU: 'GLUCOSE', CREA: 'CREATININE', NA: 'SODIUM' },
  });
  console.log('  ✓ acme-chem-200 (vendor variant with accession/sample swap)');
  console.log();

  // ── 4. Register devices ──────────────────────────────────────────────
  console.log('─── Devices ───');
  await jpost('/api/v1/devices', {
    id: 'ANA-001',
    name: 'Chemistry Analyzer',
    manufacturer: 'Acme Diagnostics',
    model: 'Chem-200',
    protocol: 'ASTM',
    transport: 'tcp',
    host: HOST,
    port: devicePort,
    profileId: 'acme-chem-200',
  });
  console.log('  ✓ ANA-001 (Acme Chem-200, bound to acme-chem-200 profile)');

  await jpost('/api/v1/devices', {
    id: 'HEM-001',
    name: 'Hematology Analyzer',
    manufacturer: 'Sysmex',
    model: 'XN-1000',
    protocol: 'ASTM',
    transport: 'tcp',
  });
  console.log('  ✓ HEM-001 (Sysmex XN-1000, unbound — uses reference layout)');
  console.log();

  // ── 5. Seed expected orders ──────────────────────────────────────────
  console.log('─── Expected Orders (LIS seam) ───');
  await jpost('/api/v1/orders', {
    id: 'ACC-777001',
    patientId: 'P-1001',
    sampleId: 'S-001',
    tests: ['GLUCOSE', 'CREATININE', 'SODIUM'],
    status: 'active',
  });
  console.log('  ✓ ACC-777001 (P-1001, 3 tests)');

  await jpost('/api/v1/orders', {
    id: 'ACC-777002',
    patientId: 'P-1002',
    sampleId: 'S-002',
    tests: ['GLUCOSE'],
    status: 'active',
  });
  console.log('  ✓ ACC-777002 (P-1002, 1 test)');
  console.log();

  // ── 6. Seed patient admissions ────────────────────────────────────────
  console.log('─── Patient Admissions ───');
  await jpost('/api/v1/admissions', {
    patientId: 'P-1001',
    name: 'Adebayo^Oluwaseun',
    dateOfBirth: '1985-03-15',
    gender: 'M',
    status: 'admitted',
  });
  console.log('  ✓ P-1001 (Adebayo Oluwaseun, admitted)');

  await jpost('/api/v1/admissions', {
    patientId: 'P-1002',
    name: 'Ngozi^Adichie',
    dateOfBirth: '1990-07-22',
    gender: 'F',
    status: 'admitted',
  });
  console.log('  ✓ P-1002 (Ngozi Adichie, admitted)');
  console.log();

  // ── 7. Configure destinations + routes ────────────────────────────────
  console.log('─── Routing ───');
  await jpost('/api/v1/destinations', {
    id: 'webhook-lis',
    kind: 'http',
    name: 'LIS Webhook',
    url: 'http://httpbin.org/post',
    enabled: true,
  });
  console.log('  ✓ destination webhook-lis (http → httpbin.org/post)');

  await jpost('/api/v1/routes', {
    id: 'route-all-to-webhook',
    destinationId: 'webhook-lis',
    priority: 100,
    enabled: true,
  });
  console.log('  ✓ route: all messages → webhook-lis');
  console.log();

  // ── 8. Configure alerts ──────────────────────────────────────────────
  console.log('─── Alert Rules ───');
  await jpost('/api/v1/alert-rules', {
    id: 'device-offline',
    kind: 'device-offline',
    name: 'Device Offline',
    threshold: 1,
    channels: ['console'],
    enabled: true,
  });
  console.log('  ✓ device-offline (fires on disconnect)');

  await jpost('/api/v1/alert-rules', {
    id: 'dlq-backlog',
    kind: 'dlq',
    name: 'DLQ Backlog',
    threshold: 5,
    channels: ['console'],
    enabled: true,
  });
  console.log('  ✓ dlq-backlog (fires when DLQ ≥ 5)');
  console.log();

  // ── 9. Send simulator messages ───────────────────────────────────────
  console.log('─── Simulator Messages ───');
  console.log(`  connecting analyzer simulator to tcp://${HOST}:${devicePort}...`);

  const sim = new AnalyzerSimulator({ host: HOST, port: devicePort });
  await sim.connect();
  console.log('  ✓ connected');

  // Send 2 matched results (ACC-777001) + 1 stray (unmatched)
  const matched1 = sim.sendResult({
    patientId: 'P-1001',
    sampleId: 'S-001',
    accession: 'ACC-777001',
    results: [
      { test: 'GLU', value: '95', unit: 'mg/dL', refRange: '70-100', flag: 'N' },
      { test: 'CREA', value: '1.1', unit: 'mg/dL', refRange: '0.7-1.3', flag: 'N' },
    ],
  });
  await matched1;
  console.log('  ✓ sent: ACC-777001 (GLU 95, CREA 1.1)');

  const matched2 = sim.sendResult({
    patientId: 'P-1001',
    sampleId: 'S-001',
    accession: 'ACC-777001',
    results: [
      { test: 'NA', value: '140', unit: 'mEq/L', refRange: '136-145', flag: 'N' },
    ],
  });
  await matched2;
  console.log('  ✓ sent: ACC-777001 (NA 140)');

  const stray = sim.sendResult({
    patientId: 'P-UNKNOWN',
    sampleId: 'S-999',
    accession: 'ACC-UNKNOWN',
    results: [
      { test: 'GLU', value: '200', unit: 'mg/dL', refRange: '70-100', flag: 'H' },
    ],
  });
  await stray;
  console.log('  ✓ sent: ACC-UNKNOWN (stray — should be HELD for review)');
  console.log();

  sim.disconnect();

  // Wait for the pipeline to process
  await new Promise((r) => setTimeout(r, 1500));

  // ── 10. Show results ─────────────────────────────────────────────────
  console.log('─── Pipeline Results ───');
  const stats = await jget('/api/v1/stats') as Record<string, number>;
  console.log('  message counts:', JSON.stringify(stats));

  const held = await jget('/api/v1/held') as unknown[];
  console.log(`  held queue: ${held.length} message(s) — the stray result is here for review`);

  const orders = await jget('/api/v1/orders') as unknown[];
  console.log(`  expected orders: ${orders.length}`);

  const devices = await jget('/api/v1/devices') as unknown[];
  console.log(`  registered devices: ${devices.length}`);
  console.log();

  // ── 11. Print the API walkthrough ────────────────────────────────────
  const curl = (method: string, path: string, body?: string) => {
    const parts = [`curl -s -X ${method}`];
    if (adminKey) parts.push(`-H "Authorization: Bearer $KEY"`);
    if (body) parts.push(`-H "Content-Type: application/json" -d '${body}'`);
    parts.push(`${base}${path}`);
    return parts.join(' \\\n       ');
  };

  console.log('═'.repeat(72));
  console.log('  API Walkthrough');
  console.log('═'.repeat(72));
  console.log();
  if (adminKey) {
    console.log(`  export KEY="${adminKey}"`);
    console.log();
  }

  console.log('  ── OpenAPI Spec ──');
  console.log(`  curl ${base}/api/v1/openapi.json | jq .info`);
  console.log();

  console.log('  ── Health ──');
  console.log(`  curl ${base}/api/v1/health`);
  console.log(`  curl ${base}/api/v1/stats`);
  console.log(`  curl ${base}/api/v1/version`);
  console.log();

  console.log('  ── Messages ──');
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/messages`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/messages?status=ROUTED`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/messages?status=HELD`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/messages/<id>  # full detail`);
  console.log();

  console.log('  ── Queue ──');
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/dlq`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/held`);
  console.log('  # release a held message:');
  console.log(`  curl -X POST -H "Authorization: Bearer $KEY" ${base}/api/v1/messages/<id>/release`);
  console.log();

  console.log('  ── Devices ──');
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/devices`);
  console.log(`  curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\`);
  console.log(`       -d '{"name":"My Analyzer","protocol":"ASTM","transport":"tcp"}' \\`);
  console.log(`       ${base}/api/v1/devices`);
  console.log();

  console.log('  ── Profiles ──');
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/profiles`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/profiles/acme-chem-200`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/profiles/acme-chem-200/conformance`);
  console.log();

  console.log('  ── Routing ──');
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/destinations`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/routes`);
  console.log();

  console.log('  ── Orders (LIS seam) ──');
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/orders`);
  console.log(`  curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\`);
  console.log(`       -d '{"id":"ACC-NEW","patientId":"P-999","tests":["GLUCOSE"],"status":"active"}' \\`);
  console.log(`       ${base}/api/v1/orders`);
  console.log();

  console.log('  ── Admissions ──');
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/admissions`);
  console.log();

  console.log('  ── Alerts ──');
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/alert-rules`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/alerts`);
  console.log();

  console.log('  ── Webhooks ──');
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/webhooks`);
  console.log(`  curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\`);
  console.log(`       -d '{"url":"https://example.com/hook","events":"*"}' \\`);
  console.log(`       ${base}/api/v1/webhooks`);
  console.log(`  curl -X POST -H "Authorization: Bearer $KEY" ${base}/api/v1/webhooks/test`);
  console.log();

  console.log('  ── FHIR R4 ──');
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/fhir/metadata`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/fhir/Patient`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/fhir/Observation`);
  console.log();

  console.log('  ── Security ──');
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/me`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/keys`);
  console.log(`  curl -H "Authorization: Bearer $KEY" ${base}/api/v1/audit`);
  console.log();

  console.log('═'.repeat(72));
  console.log('  Done — hub is running. Press Ctrl+C to stop.');
  console.log('═'.repeat(72));

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
