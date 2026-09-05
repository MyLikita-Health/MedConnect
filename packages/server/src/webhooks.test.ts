/**
 * D3 slice 2 e2e proof — the webhook event bus is wired at the hub's real
 * seams (exactly how `startHub` runs): a real MLLP session drives the fire
 * points and every delivery is verified against the subscription secret.
 *
 *   ORM over MLLP  → device.connected (peer id from MSH-3) + order.received
 *   ORU over MLLP  → result.received (accepted into the pipeline)
 *   rule → dead destination → DLQ → message.failed + result.failed
 *   socket close   → device.disconnected
 *
 * Each captured delivery is checked: X-IntegrationHub-Event / -Event-Id /
 * -Timestamp headers match the envelope, and the HMAC signature verifies with
 * `verifyWebhookSignature` against the raw body (the D exit criterion
 * "signature verification tested", end-to-end).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MllpDecoder, wrapMessage } from '@integration-hub/hl7';
import { verifyWebhookSignature, type WebhookEventType, type WebhookSubscription } from '@integration-hub/core';
import { startHub } from './index.js';
import type { Hub } from './index.js';

const SECRET = 'webhook-test-secret';

const ORM = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORM^O01|ORD-9|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'ORC|NW|PL-77|ACC-424242|GLU^Glucose',
  'OBR|1|PL-77|ACC-424242|GLU^Glucose',
].join('\r');

const ORU = [
  'MSH|^~\\&|ACME_LIS|FAC1|HUB|FAC2|20260904120000||ORU^R01|MSG0001|P|2.3.1',
  'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M',
  'OBR|1|ORD-77|ACC-424242|GLU^Glucose',
  'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
].join('\r');

// ---------------------------------------------------------------------------
// Delivery capture: a local HTTP endpoint that records every webhook POST.
// ---------------------------------------------------------------------------

interface Delivery {
  type: string;
  eventId: string;
  signature: string;
  timestamp: string;
  raw: string;
  body: { id: string; type: WebhookEventType; occurredAt: string; source: string; data: Record<string, unknown> };
}

async function startCapture(): Promise<{ url: string; received: Delivery[]; close(): Promise<void> }> {
  const received: Delivery[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      received.push({
        type: (req.headers['x-integration-hub-event'] as string) ?? '',
        eventId: (req.headers['x-integration-hub-event-id'] as string) ?? '',
        signature: (req.headers['x-integration-hub-signature'] as string) ?? '',
        timestamp: (req.headers['x-integration-hub-timestamp'] as string) ?? '',
        raw,
        body: JSON.parse(raw),
      });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function subscription(url: string): WebhookSubscription {
  return {
    id: 'test-sub',
    name: 'test endpoint',
    url,
    secret: SECRET,
    events: '*',
    enabled: true,
    retry: { maxAttempts: 1, backoffMs: 1, backoffFactor: 1, jitter: false },
    createdAt: new Date().toISOString(),
  };
}

async function startHubWithWebhooks(t: any, url: string): Promise<Hub> {
  const hub = await startHub({
    authDisabled: true,
    hl7Port: 0,
    httpPort: 0,
    devicePort: 0,
    seedDefaultAlerts: false,
    webhooks: { subscriptions: [subscription(url)] },
  });
  t.after(() => hub.stop());
  return hub;
}

function connect(port: number): Promise<{ socket: net.Socket; acks: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const acks: string[] = [];
      const decoder = new MllpDecoder({ onMessage: (p) => void acks.push(p) });
      socket.on('data', (c: Buffer) => decoder.feed(c));
      resolve({ socket, acks });
    });
    socket.once('error', reject);
  });
}

async function waitFor(pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function deliveryOf(received: Delivery[], type: string): Delivery {
  const delivery = received.find((d) => d.type === type);
  if (!delivery) throw new Error(`no ${type} delivery captured`);
  return delivery;
}

/** Every D3 delivery must be HMAC-signed + header-consistent with its body. */
function assertSigned(delivery: Delivery): void {
  assert.ok(delivery.signature.startsWith('sha256='), 'signature header present');
  assert.equal(verifyWebhookSignature(SECRET, delivery.raw, delivery.signature), true, 'signature verifies');
  assert.equal(delivery.eventId, delivery.body.id, 'X-IntegrationHub-Event-Id matches the envelope id');
  assert.equal(delivery.type, delivery.body.type, 'X-IntegrationHub-Event matches the envelope type');
  assert.equal(delivery.timestamp, delivery.body.occurredAt, 'X-IntegrationHub-Timestamp matches occurredAt');
  assert.equal(delivery.body.source, 'hub:127.0.0.1', 'envelope carries the hub source');
}

test('ORM/ORU MLLP session fires order.received, result.received and device.connected/disconnected', async (t) => {
  const capture = await startCapture();
  t.after(() => capture.close());
  const hub = await startHubWithWebhooks(t, capture.url);
  const { socket, acks } = await connect(hub.ports.hl7!);
  t.after(() => socket.destroy());

  // The ORM registers the expected order (the LIS seam): the gateway derives
  // the peer device id from MSH-3 on the first message, so device.connected
  // fires at the same moment as order.received.
  socket.write(wrapMessage(ORM));
  await waitFor(() => acks.length >= 1, 'ORM AA ack');
  await waitFor(() => capture.received.some((d) => d.type === 'order.received'), 'order.received delivery');
  await waitFor(() => capture.received.some((d) => d.type === 'device.connected'), 'device.connected delivery');

  const orderEvent = deliveryOf(capture.received, 'order.received');
  assertSigned(orderEvent);
  assert.equal(orderEvent.body.data.orderId, 'ACC-424242');
  assert.equal(orderEvent.body.data.patientId, 'PID-1001');
  assert.deepEqual(orderEvent.body.data.tests, ['GLUCOSE']);

  const connected = deliveryOf(capture.received, 'device.connected');
  assertSigned(connected);
  assert.equal(connected.body.data.deviceId, 'ACME_LIS');
  assert.equal(connected.body.data.protocol, 'HL7');
  assert.equal(connected.body.data.state, 'connected');

  // The matching ORU is accepted into the pipeline (result.received). With no
  // routing rules the message delivers to the built-in console → ROUTED.
  socket.write(wrapMessage(ORU));
  await waitFor(() => capture.received.some((d) => d.type === 'result.received'), 'result.received delivery');
  const receivedEvent = deliveryOf(capture.received, 'result.received');
  assertSigned(receivedEvent);
  assert.equal(receivedEvent.body.data.accession, 'ACC-424242');
  assert.equal(receivedEvent.body.data.patientId, 'PID-1001');
  assert.equal(receivedEvent.body.data.protocol, 'HL7');
  assert.equal(receivedEvent.body.data.deviceId, 'ACME_LIS');
  assert.ok(receivedEvent.body.data.messageId, 'messageId carried');
  await waitFor(async () => (await hub.store.get(receivedEvent.body.data.messageId as string))?.status === 'ROUTED', 'message ROUTED');

  // Closing the session flips the device row to disconnected.
  socket.destroy();
  await waitFor(() => capture.received.some((d) => d.type === 'device.disconnected'), 'device.disconnected delivery');
  assertSigned(deliveryOf(capture.received, 'device.disconnected'));
  assert.equal(deliveryOf(capture.received, 'device.disconnected').body.data.deviceId, 'ACME_LIS');
});

test('a delivery that DLQs fires message.failed + result.failed for the same message', async (t) => {
  const capture = await startCapture();
  t.after(() => capture.close());
  const hub = await startHubWithWebhooks(t, capture.url);
  const { socket, acks } = await connect(hub.ports.hl7!);
  t.after(() => socket.destroy());

  // Register the expected order so the ORU matches (and order.received fires).
  socket.write(wrapMessage(ORM));
  await waitFor(() => acks.length >= 1, 'ORM AA ack');
  await waitFor(() => capture.received.some((d) => d.type === 'order.received'), 'order.received delivery');

  // Point every ORU at a dead HTTP destination (nothing listens on port 1).
  await hub.routes.upsertDestination({
    id: 'dead',
    kind: 'http',
    name: 'dead endpoint',
    url: 'http://127.0.0.1:1',
    enabled: true,
    retry: { maxAttempts: 1, backoffMs: 1, backoffFactor: 1, jitter: false },
  });
  await hub.routes.upsertRule({ id: 'dead-rule', destinationId: 'dead', priority: 1, enabled: true });

  socket.write(wrapMessage(ORU));
  await waitFor(() => capture.received.some((d) => d.type === 'result.received'), 'result.received delivery');
  const receivedEvent = deliveryOf(capture.received, 'result.received');
  const messageId = receivedEvent.body.data.messageId as string;

  await waitFor(() => capture.received.some((d) => d.type === 'result.failed'), 'result.failed delivery');
  await waitFor(() => capture.received.some((d) => d.type === 'message.failed'), 'message.failed delivery');

  const failed = deliveryOf(capture.received, 'result.failed');
  assertSigned(failed);
  assert.equal(failed.body.data.messageId, messageId, 'same message id as result.received');
  assert.equal(failed.body.data.accession, 'ACC-424242');
  assert.match(String(failed.body.data.reason), /delivery failed/);

  const messageFailed = deliveryOf(capture.received, 'message.failed');
  assertSigned(messageFailed);
  assert.equal(messageFailed.body.data.messageId, messageId);
  assert.equal(messageFailed.body.data.kind, 'result');

  // The message really is on the DLQ with the marker set.
  const stored = await hub.store.get(messageId);
  assert.equal(stored?.status, 'FAILED');
  assert.ok(stored?.dlqAt, 'dlq marker set');
});
