import { parseArgs } from 'node:util';
import { startHub } from './index.js';

const { values } = parseArgs({
  options: {
    devicePort: { type: 'string', default: process.env.DEVICE_PORT ?? '5000' },
    httpPort: { type: 'string', default: process.env.PORT ?? '3000' },
    host: { type: 'string', default: process.env.HOST ?? '127.0.0.1' },
  },
});

const devicePort = Number(values.devicePort);
const httpPort = Number(values.httpPort);
const host = values.host!;

const hub = await startHub({ devicePort, httpPort, host });

console.log(`[gateway] ASTM listening on tcp://${host}:${hub.ports.device}`);
console.log(`[api]     REST listening on http://${host}:${hub.ports.http}  (console UI at /)`);
console.log('[hub]     started — run "npm run simulate" in another terminal to send device messages');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[hub] ${signal} received — shutting down`);
  await hub.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));