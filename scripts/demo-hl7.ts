/**
 * End-to-end HL7 demo (workstream B2b): starts the hub with the inbound HL7
 * v2 (MLLP) listener alongside the ASTM gateway, runs the HL7 ORU simulator
 * against it, and prints what the API recorded — two matched results (fixed
 * fixture) plus one stray result that lands in the HELD exception queue, then
 * operator review + release. Requires no extra services.
 */
import { spawn, type ChildProcess } from 'node:child_process';

const children: ChildProcess[] = [];

// The API is authenticated (PRD §34); the whole demo runs as this admin key.
const DEMO_KEY = 'ihk_demo_dev_key_001';

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
  console.log('=== Integration Hub demo — HL7 v2 (ORU^R01 over MLLP) ===\n');
  const server = run(['packages/server/src/cli.ts'], {
    PORT: '3001',
    DEVICE_PORT: '5001',
    HL7_PORT: '6000',
    HOST: '127.0.0.1',
    HUB_ADMIN_KEY: DEMO_KEY,
  });
  await waitForOutput(server, 'HL7 v2 (MLLP) listening');

  const base = 'http://127.0.0.1:3001/api/v1';

  // 1. The LIS seam: register the expected order the fixed-fixture ORU will
  //    carry (PRD §27) so the incoming results can be matched.
  console.log('[demo] registering expected order ACC-424242 (LIS seam)');
  const orderRes = await fetchApi(`${base}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'ACC-424242', patientId: 'PID-1001', sampleId: 'S-4242', tests: ['GLUCOSE', 'CREATININE'] }),
  });
  if (orderRes.status !== 201) throw new Error(`order registration failed: ${orderRes.status}`);

  // 2. Two matched ORUs (fixed fixture) + one stray result from an unknown
  //    patient (random fixture) that cannot be matched → held for review.
  const matched = run(['packages/simulator/src/cli-hl7.ts', '--count', '2', '--interval', '500', '--fixed']);
  if ((await exitCode(matched)) !== 0) throw new Error('HL7 simulator (fixed) exited with non-zero code');
  const stray = run(['packages/simulator/src/cli-hl7.ts', '--count', '1']);
  if ((await exitCode(stray)) !== 0) throw new Error('HL7 simulator (random) exited with non-zero code');

  // Delivery is asynchronous (match → queue → worker → ROUTED); wait for the
  // queue to drain and the stray result to reach the HELD queue.
  await waitForPending(base, 0);
  await waitForHeld(base);

  const held = (await (await fetchApi(`${base}/held`)).json()) as Array<{ id: string; status: string; match: { status: string } }>;
  console.log(`\n[held] ${held.length} message(s) in the exception queue (unmatched ORU)`);
  for (const m of held) {
    console.log(`  ${m.id.slice(0, 8)}  ${m.status}  match=${m.match?.status}`);
  }

  // 3. Operator review: release the held ORU into delivery.
  for (const m of held) {
    const release = await fetchApi(`${base}/messages/${m.id}/release`, { method: 'POST' });
    if (release.status !== 200) throw new Error(`release failed: ${release.status}`);
    console.log(`  → released by operator, re-entering delivery`);
  }
  await waitForPending(base, 0);

  const stats = await (await fetchApi(`${base}/stats`)).json();
  const messages = (await (await fetchApi(`${base}/messages`)).json()) as Array<{
    id: string;
    status: string;
    protocol: string;
    deviceId: string;
    payload?: { patient?: { name?: string }; results?: unknown[] };
  }>;
  const results = await (await fetchApi(`${base}/results`)).json();

  console.log('\n=== Demo summary ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log(`messages: ${messages.length} (protocol = ${[...new Set(messages.map((m) => m.protocol))].join(', ')})`);
  for (const m of messages.slice(0, 4)) {
    console.log(
      `  ${m.id.slice(0, 8)}  ${m.status.padEnd(7)} ${m.protocol.padEnd(4)} ${m.deviceId}  patient=${m.payload?.patient?.name}  results=${m.payload?.results?.length ?? 0}`,
    );
  }
  console.log(`results: ${results.length}`);
  console.log(`\nOpen the console UI: http://127.0.0.1:3001/  (API key: ${DEMO_KEY})`);
}

async function waitForPending(base: string, target: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const stats = (await (await fetchApi(`${base}/stats`)).json()) as { pending: number };
    if (stats.pending === target) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for delivery to drain');
}

async function waitForHeld(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const held = (await (await fetchApi(`${base}/held`)).json()) as unknown[];
    if (held.length > 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for the stray ORU to reach the HELD queue');
}

main()
  .catch((err) => {
    console.error(`demo failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) child.kill();
  });
