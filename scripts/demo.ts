/**
 * End-to-end demo: starts the hub (gateway + API), runs the device simulator
 * against it, then prints what the API recorded. Requires no extra services.
 */
import { spawn, type ChildProcess } from 'node:child_process';

const children: ChildProcess[] = [];

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
  console.log('=== Integration Hub demo ===\n');
  const server = run(['packages/server/src/cli.ts'], { PORT: '3000', DEVICE_PORT: '5000', HOST: '127.0.0.1' });
  await waitForOutput(server, 'REST listening');

  const base = 'http://127.0.0.1:3000/api/v1';

  // 1. The LIS seam: register the expected order so incoming results can be
  //    matched (PRD §27). PID-1001 / ACC-424242 / S-4242 is the simulator's
  //    fixed fixture.
  console.log('[demo] registering expected order ACC-424242 (LIS seam)');
  const orderRes = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'ACC-424242', patientId: 'PID-1001', sampleId: 'S-4242', tests: ['GLUCOSE', 'CREATININE'] }),
  });
  if (orderRes.status !== 201) throw new Error(`order registration failed: ${orderRes.status}`);

  // 2. Alerting: the demo focuses on one rule — a growing held-backlog pages
  //    the operator (PRD §33). Threshold 1 = the first unreviewed result fires.
  //    The seeded default rules (device offline etc.) are removed so the demo
  //    assertions are deterministic; the simulator's normal disconnect would
  //    otherwise fire a legitimate device-offline alert at the end.
  for (const seeded of ['dev-offline', 'dest-down', 'dlq-growth']) {
    await fetch(`${base}/alert-rules/${seeded}`, { method: 'DELETE' });
  }
  console.log('[demo] adding alert rule: held results awaiting review (threshold 1)');
  const ruleRes = await fetch(`${base}/alert-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo-held', kind: 'held-backlog', name: 'Results awaiting review', threshold: 1 }),
  });
  if (ruleRes.status !== 201) throw new Error(`alert rule registration failed: ${ruleRes.status}`);

  // 3. Two matched results (fixed fixture) + one stray result from an unknown
  //    patient (random fixture) that cannot be matched → held for review.
  const matched = run(['packages/simulator/src/cli.ts', '--count', '2', '--interval', '500', '--fixed']);
  if ((await exitCode(matched)) !== 0) throw new Error('simulator (fixed) exited with non-zero code');
  const stray = run(['packages/simulator/src/cli.ts', '--count', '1']);
  if ((await exitCode(stray)) !== 0) throw new Error('simulator (random) exited with non-zero code');

  // Delivery is asynchronous (match → queue → worker → ROUTED); wait for the
  // queue to drain so the summary shows terminal states only.
  await waitForPending(base, 0);

  // 4. The stray result sits in the HELD exception queue — and the alert fired.
  const held = (await (await fetch(`${base}/held`)).json()) as Array<{ id: string; status: string; match: { status: string } }>;
  console.log(`\n[held] ${held.length} message(s) in the exception queue`);
  for (const m of held) {
    console.log(`  ${m.id.slice(0, 8)}  ${m.status}  match=${m.match?.status}`);
  }
  const firing = (await (await fetch(`${base}/alerts?firing=true`)).json()) as Array<{ kind: string; message: string }>;
  console.log(`[alerts] ${firing.length} firing`);
  for (const a of firing) console.log(`  FIRING  ${a.kind} — ${a.message}`);

  // 5. The operator reviews the held result and releases it; the alert resolves.
  for (const m of held) {
    const release = await fetch(`${base}/messages/${m.id}/release`, { method: 'POST' });
    if (release.status !== 200) throw new Error(`release failed: ${release.status}`);
    console.log(`  → released by operator, re-entering delivery`);
  }
  await waitForPending(base, 0);
  const after = (await (await fetch(`${base}/alerts?firing=true`)).json()) as unknown[];
  console.log(`[alerts] ${after.length} firing after review (held backlog cleared)`);
  if (after.length > 0) throw new Error('expected all demo alerts resolved after review');
  await fetch(`${base}/alert-rules/demo-held`, { method: 'DELETE' });

  const stats = await (await fetch(`${base}/stats`)).json();
  const messages = await (await fetch(`${base}/messages`)).json();
  const results = await (await fetch(`${base}/results`)).json();

  console.log('\n=== Demo summary ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log(`messages: ${messages.length}`);
  for (const m of messages.slice(0, 4)) {
    console.log(
      `  ${m.id.slice(0, 8)}  ${m.status.padEnd(7)} match=${(m.match?.status ?? '—').padEnd(9)} ${m.deviceId}  patient=${m.payload?.patient.name}  results=${m.payload?.results.length}`,
    );
  }
  console.log(`results: ${results.length}`);
  console.log('\nOpen the console UI: http://127.0.0.1:3000/');
}

async function waitForPending(base: string, target: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const stats = (await (await fetch(`${base}/stats`)).json()) as { pending: number };
    if (stats.pending === target) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for delivery to drain');
}

main()
  .catch((err) => {
    console.error(`demo failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) child.kill();
  });