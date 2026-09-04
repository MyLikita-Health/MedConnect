/**
 * HL7 v2 ORU^R01 simulator (workstream K / B demo): the HL7 sibling of the
 * ASTM `AnalyzerSimulator`. It generates realistic ORU^R01 result messages
 * (MSH/PID/OBR/OBX — the same deterministic fixture pool) and transmits them
 * to the hub's MLLP listener as an LIS/analyzer middleware would, awaiting
 * the application ACK for each. `--fixed` reuses the PID-1001/ACC-424242
 * fixture so the hub can match against a pre-registered expected order.
 */
import net from 'node:net';
import { once } from 'node:events';
import { MllpClient, parseMessage, segmentField } from '@integration-hub/hl7';
import { PATIENTS, TEST_POOL, formatTimestamp, randInt, randomResult, sleep } from './analyzer.js';

export interface Hl7OruSimulatorOptions {
  host: string;
  port: number;
  /** MSH-3 sending application — the device identity the hub records. */
  deviceName?: string;
  count?: number;
  /** Delay between messages, ms. */
  intervalMs?: number;
  /** Deterministic patient/order (demo/certification fixtures). */
  fixed?: boolean;
  debug?: (line: string) => void;
}

export interface TransmittedOru {
  raw: string;
  ackStatus?: string;
  summary: { patientId: string; orderId: string; tests: number };
}

export class Hl7OruSimulator {
  private readonly deviceName: string;
  private readonly count: number;
  private readonly intervalMs: number;
  private readonly fixed: boolean;
  private readonly debug?: (line: string) => void;

  constructor(private readonly opts: Hl7OruSimulatorOptions) {
    this.deviceName = opts.deviceName ?? 'SIM-HL7';
    this.count = opts.count ?? 3;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.fixed = opts.fixed ?? false;
    this.debug = opts.debug;
  }

  async run(): Promise<TransmittedOru[]> {
    const transmitted: TransmittedOru[] = [];
    for (let i = 0; i < this.count; i++) {
      if (i > 0 && this.intervalMs > 0) await sleep(this.intervalMs);
      transmitted.push(await this.runOnce());
    }
    return transmitted;
  }

  async runOnce(): Promise<TransmittedOru> {
    const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
    socket.on('error', (err) => {
      throw new Error(`cannot connect to the hub at ${this.opts.host}:${this.opts.port}: ${err.message}`);
    });
    await once(socket, 'connect');
    try {
      const raw = this.buildOru();
      const client = new MllpClient(socket, { debug: this.debug });
      const ack = await client.send(raw);
      const msa = parseMessage(ack).segments.find((s) => s.id === 'MSA');
      const ackStatus = msa ? segmentField(msa, 0) : undefined;
      if (ackStatus === 'AE' || ackStatus === 'AR') {
        const text = msa ? segmentField(msa, 2) ?? '' : '';
        this.debug?.(`[simulator] rejected (${ackStatus}): ${text}`);
      }
      socket.end();
      await once(socket, 'close');
      return { raw, ackStatus, summary: summarize(raw) };
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  private buildOru(): string {
    const now = new Date();
    const patient = this.fixed ? PATIENTS[0]! : PATIENTS[randInt(0, PATIENTS.length - 1)]!;
    const orderId = this.fixed ? 'ACC-424242' : `ACC-${randInt(100000, 999999)}`;
    const tests = this.fixed
      ? [TEST_POOL[0]!, TEST_POOL[1]!]
      : pickN(TEST_POOL, 2 + randInt(0, 2));

    const nameParts = patient.name.split('^'); // e.g. 'Adeyemi^Tunde'
    const family = nameParts[0] ?? patient.name;
    const given = nameParts[1];

    const segments: string[] = [
      [
        'MSH', '^~\\&', this.deviceName, 'FAC1', 'HUB', 'FAC2', formatTimestamp(now), '', 'ORU^R01',
        `HL7-${randInt(100000, 999999)}`, 'P', '2.5.1',
      ].join('|'),
      // PID fields 1..8 positional — PID-4 (alias) stays empty so PID-5 is the name.
      ['PID', '1', '', `${patient.id}^^^FAC1^PI`, '', given ? `${family}^${given}` : family, '', patient.dob, patient.gender].join('|'),
      ['OBR', '1', '', orderId, `${tests[0]!.code}^${tests[0]!.name}`, '', '', formatTimestamp(now)].join('|'),
    ];

    tests.forEach((test, i) => {
      const { value, flag } = randomResult(test);
      // OBX fields 1..11 positional (OBX-11 = result status F).
      segments.push(['OBX', String(i + 1), 'NM', `${test.code}^${test.name}`, '', value, test.unit, test.ref, flag, '', '', 'F'].join('|'));
    });

    return segments.join('\r');
  }
}

function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < Math.min(n, copy.length); i++) {
    const idx = randInt(0, copy.length - 1);
    out.push(copy.splice(idx, 1)[0]!);
  }
  return out;
}

function summarize(raw: string): TransmittedOru['summary'] {
  const msg = parseMessage(raw);
  const pid = msg.segments.find((s) => s.id === 'PID');
  const obr = msg.segments.find((s) => s.id === 'OBR');
  const results = msg.segments.filter((s) => s.id === 'OBX');
  return {
    patientId: pid ? segmentField(pid, 2) ?? '?' : '?',
    orderId: obr ? segmentField(obr, 2) ?? '?' : '?',
    tests: results.length,
  };
}
