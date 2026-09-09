/**
 * D11 e2e — startHub edge wiring: a hub started with `cloudSync` opts (and a
 * PG store, DB-gated) attaches the outbox write-through, stamps rows with the
 * tenancy, starts the syncer, and ships a device + message entry to a fake
 * cloud ingest endpoint. Run with `npm run test:db` (needs Postgres — the
 * write-through and outbox only exist on the PG stores).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHub, type Hub } from './index.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skip = !DB_URL;

test('startHub + cloudSync ships outbox entries to the cloud ingest (DB-gated)', { skip }, async (t) => {
  // Fake cloud: verifies the gateway headers and returns appliedThrough.
  const batches: { gatewayId: string; apiKey: string; count: number }[] = [];
  const cloud = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { entries: unknown[] };
      batches.push({
        gatewayId: (req.headers['x-hub-gateway'] as string) ?? '',
        apiKey: ((req.headers.authorization as string) ?? '').replace(/^Bearer /, ''),
        count: body.entries.length,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ appliedThrough: body.entries.length }));
    });
  });
  await new Promise<void>((resolve) => cloud.listen(0, '127.0.0.1', resolve));
  const { port: cloudPort } = cloud.address() as AddressInfo;
  t.after(() => new Promise<void>((resolve) => cloud.close(() => resolve())));

  // The edge reuses the shared test edge DB (the pg-outbox tests own its
  // lifecycle; migrations are idempotent and rows are additive).
  const edgeUrl = new URL(DB_URL!);
  edgeUrl.pathname = '/hub_test_edge';

  let hub: Hub | undefined;
  try {
    hub = await startHub({
      authDisabled: true,
      httpPort: 0,
      devicePort: 0,
      seedDefaultAlerts: false,
      databaseUrl: edgeUrl.toString(),
      cloudSync: {
        cloudBaseUrl: `http://127.0.0.1:${cloudPort}`,
        gatewayId: 'gw-e2e',
        apiKey: 'ihk_gw_e2e_secret',
        pollMs: 100,
        batchSize: 100,
      },
    });

    // Deliver one ASTM session so the hub records a message (the device
    // upsert also appends an outbox entry via the write-through).
    const { AnalyzerSimulator } = await import('@integration-hub/simulator');
    const sim = new AnalyzerSimulator({ host: '127.0.0.1', port: hub.ports.device, count: 1, intervalMs: 0 });
    await sim.runOnce();

    // The syncer ships within a couple of poll intervals.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && batches.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(batches.length >= 1, 'at least one batch shipped');
    assert.equal(batches[0]!.gatewayId, 'gw-e2e');
    assert.equal(batches[0]!.apiKey, 'ihk_gw_e2e_secret');
    assert.ok(batches[0]!.count >= 1, 'entries carried');
  } finally {
    if (hub) await hub.stop();
  }
});
