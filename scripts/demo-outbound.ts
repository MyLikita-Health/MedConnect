/**
 * Outbound HL7 demo (workstream B3.3): boots the hub with the HL7 inbound
 * listener, runs an in-process mock LIS (an MLLP server that AA-acks and
 * records what it receives), registers an `hl7` destination + route rule via
 * the API, then sends one fixed ORU through the simulator. The result flows
 * inbound (matching → HELD-free ROUTED path) and is delivered outbound over
 * MLLP to the mock LIS — the store-and-forward LIS leg, live.
 *
 * Requires no extra services.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { MllpServer } from '@integration-hub/hl7';

const children: ChildProcess[] = [];
const DEMO_KEY = 'ihk_demo_outbound_001';
let lis: MllpServer | undefined;

function fetchApi(url: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${DEMO_KEY}`,
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  return fetch(url, { ...init, headers });
}

function run(args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  children.push(child);
  return child;
}

function waitForOutput(child: ChildProcess, marker: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    let acc = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for "${marker}"`));
    }, timeoutMs);
    const onData = (d: Buffer) => {
      acc += d.toString();
      if (acc.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
    };
    child.stdout?.on('data', onData);
  });
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on('exit', resolve));
}

async function main(): Promise<void> {
  console.log('=== Integration Hub demo — outbound HL7 v2 (results to a mock LIS over MLLP) ===\n');

  // The mock LIS lives in this process; the hub (spawned below) connects out
  // to it over TCP/MLLP exactly as it would a real LIS.
  const lisReceived: string[] = [];
  lis = new MllpServer({
    host: '127.0.0.1',
    port: 0,
    onMessage: (payload) => {
      lisReceived.push(payload);
      console.log(`[mock-lis] received ORU^R01 (${payload.split('\r')[0]?.slice(0, 60)}…)`);
    },
  });
  const { port: lisPort } = await lis.start();

  const server = run(['packages/server/src/cli.ts'], {
    PORT: '3002',
    DEVICE_PORT: '5002',
    HL7_PORT: '6002',
    HOST: '127.0.0.1',
    HUB_ADMIN_KEY: DEMO_KEY,
  });
  await waitForOutput(server, 'HL7 v2 (MLLP) listening');
  const base = 'http://127.0.0.1:3002/api/v1';

  // 1. LIS seam: register the expected order the fixed ORU will carry.
  await fetchApi(`${base}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'ACC-424242', patientId: 'PID-1001', sampleId: 'S-4242', tests: ['GLUCOSE', 'CREATININE'] }),
  });
  console.log('[demo] registered expected order ACC-424242');

  // 2. Outbound: an `hl7` destination pointing at the mock LIS + a route rule.
  const destRes = await fetchApi(`${base}/destinations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'mock-lis',
      name: 'Mock LIS (MLLP)',
      kind: 'hl7',
      hl7: { host: '127.0.0.1', port: lisPort, receivingApp: 'MOCK_LIS' },
    }),
  });
  if (destRes.status !== 201) throw new Error(`destination registration failed: ${destRes.status}`);
  await fetchApi(`${base}/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'r-mock-lis', destinationId: 'mock-lis', priority: 100 }),
  });
  console.log(`[demo] hl7 destination mock-lis → tcp://127.0.0.1:${lisPort} (MLLP) with a catch-all route`);

  // 3. One fixed ORU through the inbound listener.
  const sim = run(['packages/simulator/src/cli-hl7.ts', '--count', '1', '--port', '6002', '--fixed']);
  if ((await exitCode(sim)) !== 0) throw new Error('HL7 simulator exited with non-zero code');

  // 4. Wait for inbound delivery + the outbound leg to reach the mock LIS.
  await waitForMapped(base);
  await waitFor(() => lisReceived.length >= 1, 'mock LIS received the ORU');

  const messages = (await (await fetchApi(`${base}/messages`)).json()) as Array<{
    id: string;
    status: string;
    match?: { status: string };
  }>;
  console.log('\n=== Demo summary ===');
  for (const m of messages) {
    console.log(`  ${m.id.slice(0, 8)}  ${m.status.padEnd(7)} match=${m.match?.status ?? '—'}`);
  }
  console.log(`mock LIS received ${lisReceived.length} ORU(s) over MLLP`);
  console.log(`\nOpen the console UI: http://127.0.0.1:3002/  (API key: ${DEMO_KEY})`);
  console.log('The delivery attempt(s) are in /api/v1/messages/:id (timeline) and message_attempts.');
}

async function waitForMapped(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const stats = (await (await fetchApi(`${base}/stats`)).json()) as { pending: number };
    if (stats.pending === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for delivery to drain');
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

main()
  .catch((err) => {
    console.error(`demo failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const child of children) child.kill();
    if (lis) await lis.stop();
  });