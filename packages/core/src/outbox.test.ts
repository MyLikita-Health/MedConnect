/**
 * D11 — OutboxSyncer unit tests (pure: a fake OutboxReader + a local HTTP
 * ingest endpoint stand in for the edge store + cloud platform).
 *
 * Covers the G4 contract: batch ship, ack on success, retry-after-failure
 * (outbox keeps the backlog), redelivery idempotency at the shipper level,
 * and clean stop draining.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OutboxSyncer, shipBatch, type OutboxEntry, type OutboxReader } from './outbox.js';

interface Capture {
  url: string;
  batches: { entries: OutboxEntry[]; gatewayId: string; apiKey: string }[];
  failNext: number;
  close(): Promise<void>;
}

async function startCapture(): Promise<Capture> {
  const batches: Capture['batches'] = [];
  let failNext = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      if (failNext > 0) {
        failNext -= 1;
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('simulated outage');
        return;
      }
      const body = JSON.parse(raw) as { entries: OutboxEntry[] };
      batches.push({
        entries: body.entries,
        gatewayId: (req.headers['x-hub-gateway'] as string) ?? '',
        apiKey: ((req.headers.authorization as string) ?? '').replace(/^Bearer /, ''),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ appliedThrough: Math.max(...body.entries.map((e) => e.seq)) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    batches,
    get failNext() {
      return failNext;
    },
    set failNext(n: number) {
      failNext = n;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

class FakeOutbox implements OutboxReader {
  rows: { entry: OutboxEntry; acked: boolean }[] = [];
  private nextSeq = 1;

  append(entry: Omit<OutboxEntry, 'seq' | 'createdAt'>): number {
    const full: OutboxEntry = { ...entry, seq: this.nextSeq++, createdAt: new Date().toISOString() };
    this.rows.push({ entry: full, acked: false });
    return full.seq;
  }

  async listUnacked(limit: number): Promise<OutboxEntry[]> {
    return this.rows.filter((r) => !r.acked).slice(0, limit).map((r) => r.entry);
  }

  async markAcked(throughSeq: number): Promise<number> {
    let n = 0;
    for (const row of this.rows) {
      if (!row.acked && row.entry.seq <= throughSeq) {
        row.acked = true;
        n++;
      }
    }
    return n;
  }

  async maxSeq(): Promise<number> {
    return this.nextSeq - 1;
  }

  get unacked(): number {
    return this.rows.filter((r) => !r.acked).length;
  }
}

function entry(pk: string, table: 'messages' | 'devices' = 'messages'): Omit<OutboxEntry, 'seq' | 'createdAt'> {
  return { table, op: 'INSERT', pk, payload: { id: pk }, facilityId: 'fac-1', orgId: 'org-1' };
}

test('shipBatch posts one JSON batch with gateway headers and returns appliedThrough', async (t) => {
  const cloud = await startCapture();
  t.after(() => cloud.close());
  const outbox = new FakeOutbox();
  outbox.append(entry('m-1'));
  outbox.append(entry('m-2'));
  const batch = await outbox.listUnacked(200);

  const applied = await shipBatch({ cloudBaseUrl: cloud.url, gatewayId: 'gw-1', apiKey: 'k-1' }, batch);
  assert.equal(applied, 2);
  assert.equal(cloud.batches.length, 1);
  assert.equal(cloud.batches[0]!.gatewayId, 'gw-1');
  assert.equal(cloud.batches[0]!.apiKey, 'k-1');
  assert.deepEqual(
    cloud.batches[0]!.entries.map((e) => e.pk),
    ['m-1', 'm-2'],
  );
});

test('shipOnce acks only through the applied seq; a failed batch keeps the backlog', async (t) => {
  const cloud = await startCapture();
  t.after(() => cloud.close());
  const outbox = new FakeOutbox();
  outbox.append(entry('m-1'));
  outbox.append(entry('m-2'));

  cloud.failNext = 1; // first attempt fails
  const syncer = new OutboxSyncer({
    reader: outbox,
    cloudBaseUrl: cloud.url,
    gatewayId: 'gw-1',
    apiKey: 'k-1',
    batchSize: 10,
  });
  const first = await syncer.shipOnce();
  assert.equal(first, undefined, 'failed batch ships nothing');
  assert.equal(outbox.unacked, 2, 'backlog intact after failure');

  const second = await syncer.shipOnce();
  assert.equal(second, 2, 'retry ships the whole backlog');
  assert.equal(outbox.unacked, 0, 'all rows acked');
  assert.equal(cloud.batches.length, 1, 'the failed POST never reached the handler');
});

test('redelivery after a lost ack re-ships; the cloud dedups (ingest idempotency contract)', async (t) => {
  const cloud = await startCapture();
  t.after(() => cloud.close());
  const outbox = new FakeOutbox();
  outbox.append(entry('m-1'));
  const syncer = new OutboxSyncer({ reader: outbox, cloudBaseUrl: cloud.url, gatewayId: 'gw-1', apiKey: 'k-1' });

  await syncer.shipOnce();
  assert.equal(outbox.unacked, 0);

  // Simulate the crash-between-cloud-write-and-ack: the row is unacked again
  // (edge restarted before markAcked) and re-ships.
  for (const row of outbox.rows) row.acked = false;
  await syncer.shipOnce();
  assert.equal(cloud.batches.length, 2, 'redelivered');
  assert.deepEqual(
    cloud.batches[0]!.entries.map((e) => e.seq),
    cloud.batches[1]!.entries.map((e) => e.seq),
    'same (facility, seq) pairs — the cloud ingest dedups them',
  );
});

test('stop() drains the remaining backlog', async (t) => {
  const cloud = await startCapture();
  t.after(() => cloud.close());
  const outbox = new FakeOutbox();
  outbox.append(entry('m-1'));
  outbox.append(entry('m-2'));
  outbox.append(entry('dev-1', 'devices'));
  const syncer = new OutboxSyncer({ reader: outbox, cloudBaseUrl: cloud.url, gatewayId: 'gw-1', apiKey: 'k-1' });
  await syncer.stop();
  assert.equal(outbox.unacked, 0, 'stop drained everything');
});
