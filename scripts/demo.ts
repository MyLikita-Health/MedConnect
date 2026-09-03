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

  const simulator = run([
    'packages/simulator/src/cli.ts',
    '--count', '3',
    '--interval', '500',
    '--debug',
  ]);
  const code = await exitCode(simulator);
  if (code !== 0) throw new Error('simulator exited with non-zero code');

  const base = 'http://127.0.0.1:3000/api/v1';

  // Delivery is asynchronous (dedup → queue → worker → ROUTED); wait for the
  // queue to drain so the summary shows terminal states only.
  for (let i = 0; i < 100; i++) {
    const stats = (await (await fetch(`${base}/stats`)).json()) as { pending: number };
    if (stats.pending === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const stats = await (await fetch(`${base}/stats`)).json();
  const messages = await (await fetch(`${base}/messages`)).json();
  const results = await (await fetch(`${base}/results`)).json();

  console.log('\n=== Demo summary ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log(`messages: ${messages.length}`);
  for (const m of messages.slice(0, 3)) {
    console.log(`  ${m.id.slice(0, 8)}  ${m.status.padEnd(7)} ${m.deviceId}  patient=${m.payload?.patient.name}  results=${m.payload?.results.length}`);
  }
  console.log(`results: ${results.length}`);
  console.log('\nOpen the console UI: http://127.0.0.1:3000/');
}

main()
  .catch((err) => {
    console.error(`demo failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) child.kill();
  });