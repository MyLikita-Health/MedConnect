import { parseArgs } from 'node:util';
import { Hl7OruSimulator } from './hl7-oru.js';
import { Hl7VariantSimulator, VARIANT_DEFS, type VariantKind, type VariantName } from './hl7-variant.js';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '6000' },
    count: { type: 'string', default: '3' },
    interval: { type: 'string', default: '1000' },
    device: { type: 'string', default: 'SIM-HL7' },
    fixed: { type: 'boolean', default: false },
    // B4 profile testing: emit deviant wire for a vendor variant.
    kind: { type: 'string', default: 'oru' },
    variant: { type: 'string' },
    debug: { type: 'boolean', default: false },
  },
});

const host = values.host!;
const port = Number(values.port);
const count = Number(values.count);
const intervalMs = Number(values.interval);
const debug = values.debug ? (line: string) => console.log(`  ${line}`) : undefined;

const kind = values.kind as VariantKind;
const variant = values.variant as VariantName | undefined;

if (variant && !(variant in VARIANT_DEFS)) {
  console.error(`[simulator:hl7] unknown variant '${variant}' — choices: ${Object.keys(VARIANT_DEFS).join(', ')}`);
  process.exit(1);
}

if (variant) {
  const def = VARIANT_DEFS[variant]!;
  console.log(`[simulator:hl7] ${values.device} -> tcp://${host}:${port} (MLLP) · ${count} ${kind.toUpperCase()} message(s) · variant '${variant}'`);
  console.log(`[simulator:hl7] deviation: ${def.description}`);
  console.log(`[simulator:hl7] hub must bind profile hl7 layout: ${JSON.stringify(def.layout)} (B4 resolveLayout)`);
  const simulator = new Hl7VariantSimulator({
    host,
    port,
    deviceName: values.device,
    kind,
    variant,
    count,
    intervalMs,
    debug,
  });
  const transmitted = await simulator.run();
  for (const m of transmitted) {
    const { patientId, orderId, tests } = m.summary;
    console.log(
      `[simulator:hl7] patient=${patientId} order=${orderId} tests=${tests} ack=${m.ackStatus ?? '—'}`,
    );
  }
  const rejected = transmitted.filter((m) => m.ackStatus === 'AE' || m.ackStatus === 'AR');
  console.log(`[simulator:hl7] done — ${transmitted.length} message(s) sent, ${rejected.length} rejected`);
  process.exit(0);
}

const simulator = new Hl7OruSimulator({
  host,
  port,
  deviceName: values.device,
  count,
  intervalMs,
  fixed: values.fixed,
  debug,
});

console.log(`[simulator:hl7] ${values.device} -> tcp://${host}:${port} (MLLP) · ${count} ORU^R01 message(s)`);
if (values.fixed) console.log('[simulator:hl7] fixed fixture: patient PID-1001, order ACC-424242');

try {
  const transmitted = await simulator.run();
  for (const m of transmitted) {
    const { patientId, orderId, tests } = m.summary;
    console.log(
      `[simulator:hl7] patient=${patientId} order=${orderId} tests=${tests} ack=${m.ackStatus ?? '—'}`,
    );
  }
  const rejected = transmitted.filter((m) => m.ackStatus === 'AE' || m.ackStatus === 'AR');
  console.log(`[simulator:hl7] done — ${transmitted.length} message(s) sent, ${rejected.length} rejected`);
} catch (err) {
  console.error(`[simulator:hl7] failed: ${(err as Error).message}`);
  process.exit(1);
}
