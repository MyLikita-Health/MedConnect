import { parseArgs } from 'node:util';
import { AnalyzerSimulator } from './analyzer.js';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '5000' },
    count: { type: 'string', default: '3' },
    interval: { type: 'string', default: '1000' },
    corruptRate: { type: 'string', default: '0' },
    device: { type: 'string', default: 'SIM-BS430' },
    id: { type: 'string', default: 'SIM-001' },
    debug: { type: 'boolean', default: false },
  },
});

const host = values.host!;
const port = Number(values.port);
const count = Number(values.count);
const intervalMs = Number(values.interval);
const corruptRate = Math.min(1, Math.max(0, Number(values.corruptRate)));

const simulator = new AnalyzerSimulator({
  host,
  port,
  deviceName: values.device,
  deviceId: values.id,
  count,
  intervalMs,
  corruptRate,
  debug: values.debug ? (line) => console.log(`  ${line}`) : undefined,
});

console.log(`[simulator] ${values.device} (${values.id}) -> tcp://${host}:${port} · ${count} message(s)`);
if (corruptRate > 0) console.log(`[simulator] corruptRate=${corruptRate} (exercising NAK/retry)`);

try {
  const transmitted = await simulator.run();
  for (const m of transmitted) {
    const { patientId, orderId, tests } = m.summary;
    console.log(
      `[simulator] patient=${patientId} order=${orderId} tests=${tests} frames=${m.result.framesSent} naks=${m.result.nakCount}`,
    );
  }
  console.log(`[simulator] done — ${transmitted.length} message(s) transmitted`);
} catch (err) {
  console.error(`[simulator] failed: ${(err as Error).message}`);
  process.exit(1);
}