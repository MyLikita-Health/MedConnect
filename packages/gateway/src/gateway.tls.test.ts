/**
 * TLS termination on the device listener (PRD §42 / §45, plan §4.3): with
 * PEM key/cert the ASTM gateway accepts TLS connections. Devices that trust
 * the hub certificate (or its CA) complete the normal ENQ/ACK session; a
 * client that does not trust the certificate is rejected by the handshake.
 *
 * Fixtures (test-fixtures/hub-key.pem + hub-cert.pem) are a self-signed cert
 * with SAN localhost/127.0.0.1 — tests trust it by pinning it as the CA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';
import { once } from 'node:events';
import { AstmGateway } from './gateway.js';
import { AstmClient, type AstmRecord } from '@integration-hub/astm';
import type { CanonicalMessage } from '@integration-hub/shared';

const KEY = fileURLToPath(new URL('../../../test-fixtures/hub-key.pem', import.meta.url));
const CERT = fileURLToPath(new URL('../../../test-fixtures/hub-cert.pem', import.meta.url));

const SAMPLE: AstmRecord[] = [
  { type: 'H', fields: ['\\^&', '', '', '', 'SIM-BS430^SIM-001', '', '', '', '', '', '', 'P', '1', '20260903143000'] },
  { type: 'P', fields: ['1', '', 'PID-9001', 'Doe^John', '', '19900101', 'M'] },
  { type: 'O', fields: ['1', 'S-48291', 'ACC-991001', '^GLU^Glucose'] },
  { type: 'R', fields: ['1', '^GLU^Glucose', '95', 'mg/dL', '70-110', 'N', '', 'F'] },
  { type: 'L', fields: ['1', 'N'] },
];

async function startTlsGateway(t: any): Promise<{ port: number; received: CanonicalMessage[] }> {
  const [key, cert] = await Promise.all([readFile(KEY, 'utf8'), readFile(CERT, 'utf8')]);
  const received: CanonicalMessage[] = [];
  const gateway = new AstmGateway({
    host: '127.0.0.1',
    port: 0,
    sink: { record: (m) => void received.push(m) },
    tls: { key, cert },
  });
  const { port } = await gateway.start();
  t.after(() => gateway.stop());
  return { port, received };
}

test('ASTM device completes a session over a TLS-terminated listener (trusted CA)', async (t) => {
  const { port, received } = await startTlsGateway(t);

  const socket = tls.connect({ host: '127.0.0.1', port, ca: await readFile(CERT, 'utf8'), rejectUnauthorized: true });
  t.after(() => socket.destroy());
  await once(socket, 'secureConnect');

  const client = new AstmClient(socket, { timeoutMs: 3000 });
  const result = await client.run(SAMPLE);
  await once(socket, 'close');

  assert.equal(result.framesSent, SAMPLE.length);
  assert.equal(result.nakCount, 0);
  await waitFor(() => received.length >= 1, 'gateway recorded the TLS-delivered message');
  assert.equal(received[0]?.deviceId, 'SIM-BS430');
  assert.equal(received[0]?.payload?.results?.[0]?.value, '95');
});

test('a client that does not trust the certificate is rejected at the handshake', async (t) => {
  const { port } = await startTlsGateway(t);

  const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: true }); // system trust store: no CA
  t.after(() => socket.destroy());
  const err = await new Promise<Error | undefined>((resolve) => {
    socket.once('secureConnect', () => resolve(undefined));
    socket.once('error', (e) => resolve(e));
  });
  assert.ok(err, 'untrusted TLS handshake must fail');
  assert.match(err?.message ?? '', /self.signed|certificate|unauthorized|unable to verify/i);
});

async function waitFor(pred: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
