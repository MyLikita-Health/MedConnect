/**
 * Inbound MLLP server over real TCP/TLS (workstream B1a): per-connection
 * sessions decode MLLP frames and answer each message with an application
 * MSH^ACK — AA on success (or an explicit decision), AE with reason text on a
 * handler error, in message order. Payloads without an MSH cannot be
 * acknowledged and surface via onSessionError.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MllpServer } from './mllp-server.js';
import type { MllpSessionOptions } from './mllp-session.js';
import { MllpDecoder, wrapMessage } from './mllp.js';
import { MSH_SLOTS, parseMessage, segmentField } from './message.js';

const KEY = fileURLToPath(new URL('../../../test-fixtures/hub-key.pem', import.meta.url));
const CERT = fileURLToPath(new URL('../../../test-fixtures/hub-cert.pem', import.meta.url));

const ORU = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG0001|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'OBR|1|ORD-77|ACC-88|GLU^Glucose',
  'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
].join('\r');

/** Client-side reader: collects every ACK payload it receives. */
class AckReader {
  readonly acks: string[] = [];
  private readonly decoder: MllpDecoder;
  constructor() {
    this.decoder = new MllpDecoder({
      onMessage: (payload) => {
        this.acks.push(payload);
      },
    });
  }
  onData(chunk: Buffer): void {
    this.decoder.feed(chunk);
  }
}

function connectPlain(port: number): Promise<{ socket: net.Socket; reader: AckReader }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const reader = new AckReader();
      socket.on('data', (c: Buffer) => reader.onData(c));
      resolve({ socket, reader });
    });
    socket.once('error', reject);
  });
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function startServer(t: any, onMessage: MllpSessionOptions['onMessage'], opts: { tls?: boolean } = {}): Promise<number> {
  const tlsCreds = opts.tls ? { key: await readFile(KEY, 'utf8'), cert: await readFile(CERT, 'utf8') } : undefined;
  const server = new MllpServer({ host: '127.0.0.1', port: 0, tls: tlsCreds, onMessage });
  const { port } = await server.start();
  t.after(() => server.stop());
  return port;
}

function msa(ack: string): { status?: string; originalControlId?: string; text?: string } {
  const msg = parseMessage(ack);
  const msaSeg = msg.segments.find((s) => s.id === 'MSA');
  return {
    status: msaSeg ? segmentField(msaSeg, 0) : undefined,
    originalControlId: msaSeg ? segmentField(msaSeg, 1) : undefined,
    text: msaSeg ? segmentField(msaSeg, 2) : undefined,
  };
}

test('server ACKs each ORU with AA and echoes the original control id', async (t) => {
  const received: string[] = [];
  const port = await startServer(t, (p) => void received.push(p));
  const { socket, reader } = await connectPlain(port);
  t.after(() => socket.destroy());

  socket.write(wrapMessage(ORU));
  await waitFor(() => reader.acks.length >= 1, 'AA ack');
  await waitFor(() => received.length >= 1, 'server handled the message');

  const ack = parseMessage(reader.acks[0]!);
  const msh = ack.segments[0]!;
  assert.equal(segmentField(msh, MSH_SLOTS.messageType), 'ACK');
  assert.equal(msa(reader.acks[0]!).status, 'AA');
  assert.equal(msa(reader.acks[0]!).originalControlId, 'MSG0001');
  assert.equal(received[0], ORU);
});

test('handler decision AE/AR carries reason text in MSA-3', async (t) => {
  const port = await startServer(t, () => ({ status: 'AE', text: 'order unknown to LIS' }));
  const { socket, reader } = await connectPlain(port);
  t.after(() => socket.destroy());

  socket.write(wrapMessage(ORU));
  await waitFor(() => reader.acks.length >= 1, 'AE ack');
  assert.equal(msa(reader.acks[0]!).status, 'AE');
  assert.equal(msa(reader.acks[0]!).text, 'order unknown to LIS');
});

test('a throwing handler yields an AE ack with the error and onSessionError', async (t) => {
  const errors: Error[] = [];
  const s = new MllpServer({
    host: '127.0.0.1',
    port: 0,
    onMessage: () => Promise.reject(new Error('sink down')),
    onSessionError: (e) => errors.push(e),
  });
  const { port } = await s.start();
  t.after(() => s.stop());

  const { socket, reader } = await connectPlain(port);
  t.after(() => socket.destroy());
  socket.write(wrapMessage(ORU));
  await waitFor(() => reader.acks.length >= 1, 'AE ack from throwing handler');
  await waitFor(() => errors.length >= 1, 'session error surfaced');
  assert.equal(msa(reader.acks[0]!).status, 'AE');
  assert.match(msa(reader.acks[0]!)!.text ?? '', /sink down/);
  assert.match(errors[0]!.message, /sink down/);
});

test('two messages on one connection get two ACKs in order', async (t) => {
  const port = await startServer(t, (p) => {
    if (p.includes('MSG0001')) return { status: 'AA' };
    return { status: 'AR', text: 'second rejected' };
  });
  const { socket, reader } = await connectPlain(port);
  t.after(() => socket.destroy());

  const second = ORU.replace('MSG0001', 'MSG0002');
  socket.write(Buffer.concat([wrapMessage(ORU), wrapMessage(second)]));
  await waitFor(() => reader.acks.length >= 2, 'both ACKs');
  assert.equal(msa(reader.acks[0]!).status, 'AA');
  assert.equal(msa(reader.acks[1]!).status, 'AR');
  assert.equal(msa(reader.acks[1]!).originalControlId, 'MSG0002');
});

test('payloads without an MSH are not acknowledged and surface an error', async (t) => {
  const errors: Error[] = [];
  const s = new MllpServer({
    host: '127.0.0.1',
    port: 0,
    onMessage: () => {},
    onSessionError: (e) => errors.push(e),
  });
  const { port } = await s.start();
  t.after(() => s.stop());

  const { socket, reader } = await connectPlain(port);
  t.after(() => socket.destroy());
  socket.write(wrapMessage('this is not an hl7 message'));
  await waitFor(() => errors.length >= 1, 'no-MSH error surfaced');
  assert.match(errors[0]!.message, /no MSH/);
  assert.equal(reader.acks.length, 0);

  // The connection stays usable for the next (valid) message.
  socket.write(wrapMessage(ORU));
  await waitFor(() => reader.acks.length >= 1, 'subsequent good message acked');
  assert.equal(msa(reader.acks[0]!).status, 'AA');
});

test('TLS-terminated listener serves a trusted client (fixture CA)', async (t) => {
  const received: string[] = [];
  const port = await startServer(t, (p) => void received.push(p), { tls: true });

  const socket = tls.connect({
    host: '127.0.0.1',
    port,
    ca: await readFile(CERT, 'utf8'),
    rejectUnauthorized: true,
  });
  t.after(() => socket.destroy());
  await once(socket, 'secureConnect');

  const reader = new AckReader();
  socket.on('data', (c: Buffer) => reader.onData(c));
  socket.write(wrapMessage(ORU));
  await waitFor(() => reader.acks.length >= 1, 'AA ack over TLS');
  await waitFor(() => received.length >= 1, 'server handled over TLS');
  assert.equal(msa(reader.acks[0]!).status, 'AA');
  assert.equal(received[0], ORU);
});

test('a client that does not trust the certificate is rejected at the handshake', async (t) => {
  const port = await startServer(t, () => {}, { tls: true });

  const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: true });
  t.after(() => socket.destroy());
  const err = await new Promise<Error | undefined>((resolve) => {
    socket.once('secureConnect', () => resolve(undefined));
    socket.once('error', (e) => resolve(e));
  });
  assert.ok(err, 'untrusted TLS handshake must fail');
  assert.match(err?.message ?? '', /self.signed|certificate|unauthorized|unable to verify/i);
});
