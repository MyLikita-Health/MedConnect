/**
 * TLS termination on the REST API (PRD §42, §45): when the ApiServer gets
 * PEM key/cert it serves HTTPS (the console UI is on the same listener).
 * Verified here: a client that trusts the hub certificate (pinned as CA) can
 * call /api/v1/health over TLS; a client without the CA is rejected.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { ApiServer } from './server.js';
import { DeviceRegistry } from './devices.js';
import { MessageStore } from './store.js';

const KEY = fileURLToPath(new URL('../../../test-fixtures/hub-key.pem', import.meta.url));
const CERT = fileURLToPath(new URL('../../../test-fixtures/hub-cert.pem', import.meta.url));

const servers: ApiServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.stop()));
});

async function startTlsApi(): Promise<number> {
  const [key, cert] = await Promise.all([readFile(KEY, 'utf8'), readFile(CERT, 'utf8')]);
  const api = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    store: new MessageStore(),
    devices: new DeviceRegistry(),
    tls: { key, cert },
  });
  servers.push(api);
  const { port } = await api.start();
  return port;
}

function getJson(port: number, ca?: string, rejectUnauthorized = true): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/health',
        rejectUnauthorized,
        ...(ca ? { ca } : {}),
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`));
            else resolve(JSON.parse(raw));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('API serves HTTPS when given key/cert; a CA-trusting client is served', async (t) => {
  const port = await startTlsApi();
  const cert = await readFile(CERT, 'utf8');
  const health = (await getJson(port, cert)) as { status: string; version: string };
  assert.equal(health.status, 'ok');
  assert.match(health.version, /^\d+\.\d+\.\d+/);
});

test('an untrusted client cannot complete the TLS handshake with the API', async (t) => {
  const port = await startTlsApi();
  const err = await getJson(port).then(
    () => undefined,
    (e: Error) => e,
  );
  assert.ok(err, 'untrusted https request must fail');
  assert.match(err.message, /self.signed|certificate|unauthorized|unable to verify/i);
});
