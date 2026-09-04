import { parseArgs } from 'node:util';
import { startHub } from './index.js';

const { values } = parseArgs({
  options: {
    devicePort: { type: 'string', default: process.env.DEVICE_PORT ?? '5000' },
    hl7Port: { type: 'string', default: process.env.HL7_PORT },
    httpPort: { type: 'string', default: process.env.PORT ?? '3000' },
    host: { type: 'string', default: process.env.HOST ?? '127.0.0.1' },
  },
});

const devicePort = Number(values.devicePort);
const httpPort = Number(values.httpPort);
const host = values.host!;
// HL7 v2 inbound is opt-in: no flag/env → the hub speaks ASTM only.
const hl7Port = values.hl7Port !== undefined && values.hl7Port !== '' ? Number(values.hl7Port) : undefined;

const hub = await startHub({ devicePort, hl7Port, httpPort, host });

console.log(`[gateway] ASTM listening on tcp://${host}:${hub.ports.device}`);
if (hub.ports.hl7 !== undefined) {
  console.log(`[gateway] HL7 v2 (MLLP) listening on tcp://${host}:${hub.ports.hl7}`);
}
console.log(`[api]     REST listening on http://${host}:${hub.ports.http}  (console UI at /)`);
console.log('[hub]     started — run "npm run simulate" (ASTM) or "npm run simulate:hl7" (ORU over MLLP)');

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