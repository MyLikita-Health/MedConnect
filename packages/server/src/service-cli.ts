/**
 * W2 — local service entry (docs/windows-desktop-installer.md §8.2).
 *
 * The process the OS service manager (Windows SCM, launchd, systemd) runs.
 * It differs from supervisor-cli.ts in its LOCAL defaults and service-mode
 * hygiene — the supervision semantics stay HubSupervisor's (crash restart,
 * health gate, rollback), which this launcher simply drives:
 *
 *   - SQLite store at <dataDir>/hub.sqlite (W1 local mode; no Docker, no DB service)
 *   - signed-update state at <dataDir>/state (HUB_STATE_DIR)
 *   - logs to <dataDir>/logs/hub.log (console is unreliable under a service context)
 *   - first-boot setup surface on (HUB_LOCAL_SETUP defaults on for SQLite)
 *
 * Env contract (written by the service definition, see packaging/):
 *   HUB_DATA_DIR   data dir (default ./hub-data)
 *   PORT           console/API port (default 3000)
 *   DEVICE_PORT    ASTM listener port (default 5000)
 *   HL7_PORT       optional HL7 MLLP listener
 *   HUB_TLS_CERT / HUB_TLS_KEY   optional API + device TLS
 *   UPDATE_SOURCE / UPDATE_PUBLIC_KEY  signed updates (W4 pairing will set these)
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubSupervisor } from '@integration-hub/core';

const dataDir = process.env.HUB_DATA_DIR ?? 'hub-data';
const httpPort = Number(process.env.PORT ?? 3000);
const stateDir = join(dataDir, 'state');
const logDir = join(dataDir, 'logs');
const logFile = join(logDir, 'hub.log');

mkdirSync(stateDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

// Service-mode logging: mirror supervisor output into the log file. Console
// writes still happen (useful when run manually) but are not load-bearing.
function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try {
    appendFileSync(logFile, stamped + '\n');
  } catch {
    // logging must never take the service down
  }
}

const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url));
const tlsEnabled = Boolean(process.env.HUB_TLS_CERT && process.env.HUB_TLS_KEY);
const healthUrl =
  process.env.HUB_HEALTH_URL ??
  `${tlsEnabled ? 'https' : 'http'}://127.0.0.1:${httpPort}/api/v1/health`;
let healthRejectUnauthorized = true;
if (tlsEnabled && process.env.HUB_TLS_VERIFY_PROBE !== '1') healthRejectUnauthorized = false;

const supervisor = new HubSupervisor({
  stateDir,
  command: [process.execPath, '--import', 'tsx', CLI_PATH],
  // Local mode pins the backend: DB=sqlite makes startHub ignore any
  // inherited DATABASE_URL (a dev shell leak must not flip the service to PG).
  env: { ...process.env, DB: 'sqlite', HUB_SQLITE_FILE: join(dataDir, 'hub.sqlite') },
  healthUrl,
  healthRejectUnauthorized,
  bootTimeoutMs: 30_000,
  log,
});

log(`[service] data dir: ${dataDir}`);
log(`[service] state dir: ${stateDir} · log: ${logFile}`);
log(`[service] health gate: ${healthUrl}`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`[service] ${signal} — stopping hub`);
  await supervisor.stop();
  process.exit(0);
}
// Windows service hosts deliver stop via CTRL_SHUTDOWN/CTRL_BREAK; node maps
// the common ones onto these signals — the SCM wrapper sends TERM.
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGHUP', () => void shutdown('SIGHUP'));

try {
  await supervisor.manage();
} catch (err) {
  log(`[service] supervisor exited: ${(err as Error).message}`);
  process.exit(1);
}
