import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { AstmClient } from './client.js';
import { AstmSession } from './session.js';
import type { AstmRecord } from './records.js';

const SAMPLE: AstmRecord[] = [
  { type: 'H', fields: ['\\^&', '', '', '', 'SIM-BS430^SIM-001', '', '', '', '', '', '', 'P', '1', '20260903143000'] },
  { type: 'P', fields: ['1', '', 'PID-9001', 'Doe^John', '', '19900101', 'M'] },
  { type: 'O', fields: ['1', 'S-48291', 'ACC-991001', '^GLU^Glucose'] },
  { type: 'R', fields: ['1', '^GLU^Glucose', '95', 'mg/dL', '70-110', 'N', '', 'F'] },
  { type: 'L', fields: ['1', 'N'] },
];

async function startHost(handlers: { onMessage: (r: AstmRecord[]) => void; onError?: (e: Error) => void }): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const session = new AstmSession(socket, {
      onMessage: (records) => handlers.onMessage(records),
      onError: (err) => handlers.onError?.(err),
    });
    session.start();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () => {
      for (const socket of connections) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('client and session complete a multi-frame ASTM exchange over TCP', async (t) => {
  const received: AstmRecord[][] = [];
  const host = await startHost({ onMessage: (r) => received.push(r) });
  t.after(() => host.close());

  const socket = net.createConnection({ host: '127.0.0.1', port: host.port });
  t.after(() => socket.destroy());
  await once(socket, 'connect');

  const client = new AstmClient(socket, { timeoutMs: 3000 });
  const result = await client.run(SAMPLE);
  await once(socket, 'close');

  assert.equal(result.framesSent, SAMPLE.length);
  assert.equal(result.nakCount, 0);
  assert.deepEqual(received[0], SAMPLE);
});

test('client retries corrupted frames after NAK until they pass', async (t) => {
  const received: AstmRecord[][] = [];
  const errors: Error[] = [];
  const host = await startHost({ onMessage: (r) => received.push(r), onError: (e) => errors.push(e) });
  t.after(() => host.close());

  const socket = net.createConnection({ host: '127.0.0.1', port: host.port });
  t.after(() => socket.destroy());
  await once(socket, 'connect');

  // corruptRate 1 -> every first attempt is rejected, then retried clean
  const client = new AstmClient(socket, { timeoutMs: 3000, maxRetries: 3, corruptRate: 1 });
  const result = await client.run(SAMPLE);
  await once(socket, 'close');

  assert.equal(result.nakCount, SAMPLE.length);
  assert.equal(result.retries, SAMPLE.length);
  assert.deepEqual(received[0], SAMPLE);
  assert.equal(errors.length, SAMPLE.length); // one checksum error per frame
});

test('client gives up after maxRetries NAKs', async (t) => {
  const host = await startHost({ onMessage: () => {} });
  t.after(() => host.close());

  const socket = net.createConnection({ host: '127.0.0.1', port: host.port });
  t.after(() => socket.destroy());
  await once(socket, 'connect');

  const client = new AstmClient(socket, { timeoutMs: 3000, maxRetries: 1, corruptRate: 1 });
  await assert.rejects(() => client.run(SAMPLE), /rejected after 1 retries/);
});