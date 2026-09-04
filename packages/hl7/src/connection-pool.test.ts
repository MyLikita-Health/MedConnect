/**
 * Outbound connection-manager tests (workstream B3.3 refinement). A raw MLLP
 * server counts connections so reuse/reconnect/idle behavior is observable:
 * successive sends share one held-open connection, a connection killed by
 * the peer is transparently re-established, idle connections are closed, and
 * deliverHl7 uses the pool when wired.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { CanonicalMessage } from '@integration-hub/shared';
import { MllpConnectionPool } from './connection-pool.js';
import { MllpDecoder, wrapMessage } from './mllp.js';
import { buildAck } from './ack.js';
import { deliverHl7 } from './deliver.js';

const MSG = (id: string): string =>
  [
    `MSH|^~\\&|HUB||LIS||20260904120000||ORU^R01|${id}|P|2.5.1`,
    'PID|1||PID-1001^^^HUB^PI||Doe^Jane||19850312|F',
  ].join('\r');

interface Lis {
  port: number;
  connections: () => number;
  closes: () => number;
  received: string[];
  close: () => Promise<void>;
}

/** Raw MLLP server counting connections/closes; `killAfter` drops the socket. */
async function startLIS(t: any, killAfter = Infinity): Promise<Lis> {
  let connections = 0;
  let closes = 0;
  let messages = 0;
  const received: string[] = [];
  const server = net.createServer((socket) => {
    connections++;
    socket.on('close', () => closes++);
    const decoder = new MllpDecoder({
      onMessage: (payload) => {
        received.push(payload);
        messages++;
        socket.write(wrapMessage(buildAck(payload)));
        if (messages >= killAfter) socket.destroy();
      },
    });
    socket.on('data', (c: Buffer) => decoder.feed(c));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  const close = () => new Promise<void>((r) => server.close(() => r()));
  t.after(() => server.close());
  return { port, connections: () => connections, closes: () => closes, received, close };
}

function message(id: string): CanonicalMessage {
  return {
    id,
    protocol: 'HL7',
    direction: 'host-to-device',
    deviceId: 'HUB',
    receivedAt: new Date().toISOString(),
    raw: '',
    payload: {
      patient: { id: 'PID-1001' },
      order: { id: 'ACC-424242', tests: [] },
      results: [{ testCode: 'GLUCOSE', value: '95' }],
    },
    status: 'MAPPED',
    errors: [],
    timeline: [],
  };
}

test('successive sends reuse one held-open connection', async (t) => {
  const lis = await startLIS(t);
  const pool = new MllpConnectionPool({ idleMs: 5_000 });
  t.after(() => pool.close());

  await pool.send({ host: '127.0.0.1', port: lis.port }, MSG('C-1'));
  await pool.send({ host: '127.0.0.1', port: lis.port }, MSG('C-2'));

  assert.equal(lis.connections(), 1);
  assert.equal(lis.received.length, 2);
  assert.ok(lis.received[0]!.includes('C-1'));
  assert.ok(lis.received[1]!.includes('C-2'));
});

test('a connection killed by the peer is re-established on the next send', async (t) => {
  const lis = await startLIS(t, 1); // server destroys the socket after the 1st message
  const pool = new MllpConnectionPool({ idleMs: 60_000 });
  t.after(() => pool.close());

  await pool.send({ host: '127.0.0.1', port: lis.port }, MSG('first'));
  assert.equal(lis.connections(), 1);

  // Peer dropped the connection — the pool must transparently reconnect to
  // the SAME endpoint on the next send.
  await pool.send({ host: '127.0.0.1', port: lis.port }, MSG('second'));

  assert.equal(lis.connections(), 2);
  assert.equal(lis.received.length, 2);
  assert.ok(lis.received[1]!.includes('second'));
});

test('idle connections are closed after the idle window', async (t) => {
  const lis = await startLIS(t);
  const pool = new MllpConnectionPool({ idleMs: 60 });
  t.after(() => pool.close());

  await pool.send({ host: '127.0.0.1', port: lis.port }, MSG('ping'));
  assert.equal(lis.connections(), 1);
  assert.equal(lis.closes(), 0);

  await new Promise((r) => setTimeout(r, 250));
  assert.equal(lis.closes(), 1, 'the pool closed the idle connection');
});

test('deliverHl7 uses the pool when wired (one connection, two deliveries)', async (t) => {
  const lis = await startLIS(t);
  const pool = new MllpConnectionPool({ idleMs: 5_000 });
  t.after(() => pool.close());

  await deliverHl7({ host: '127.0.0.1', port: lis.port }, message('m-1'), { pool });
  await deliverHl7({ host: '127.0.0.1', port: lis.port }, message('m-2'), { pool });

  assert.equal(lis.connections(), 1);
  assert.equal(lis.received.length, 2);
  assert.ok(lis.received[0]!.includes('ORU^R01'));
  assert.ok(lis.received[1]!.includes('HUB-m-2')); // deterministic control id per message
});