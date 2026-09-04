/**
 * Supervised hub launcher (plan §4.3 / G2–G3; M2 installer + remote update).
 *
 * Runs the real hub (packages/server/src/cli.ts) as a child process and
 * supervises it: restarts on crash, and when the in-hub update agent stages
 * a signed release (desired.json in HUB_STATE_DIR) it swaps the running
 * version, health-gates the new boot, and auto-rolls-back on failure.
 *
 * Usage:  HUB_STATE_DIR=.hub-state UPDATE_SOURCE=… UPDATE_PUBLIC_KEY=… \
 *         npm run start:supervised
 * (auth/admin key env vars pass through to the child; ports default 3000/5000.)
 */
import { fileURLToPath } from 'node:url';
import { HubSupervisor } from '@integration-hub/core';

const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url));

const httpPort = Number(process.env.PORT ?? 3000);
const stateDir = process.env.HUB_STATE_DIR ?? '.hub-state';
const healthUrl = process.env.HUB_HEALTH_URL ?? `http://127.0.0.1:${httpPort}/api/v1/health`;

const supervisor = new HubSupervisor({
  stateDir,
  command: [process.execPath, '--import', 'tsx', CLI_PATH],
  healthUrl,
  bootTimeoutMs: 30_000,
  log: (line) => console.log(line),
});

console.log(`[supervisor-cli] state dir: ${stateDir}`);
console.log(`[supervisor-cli] health gate: ${healthUrl}`);
console.log('[supervisor-cli] Ctrl-C to stop (child receives SIGTERM)');

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`\n[supervisor-cli] ${signal} — stopping child`);
  await supervisor.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await supervisor.manage();
} catch (err) {
  console.error(`[supervisor-cli] ${(err as Error).message}`);
  process.exit(1);
}
