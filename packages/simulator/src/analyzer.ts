/**
 * ASTM analyzer simulator (PRD §26): generates realistic H/P/O/R/L result
 * messages and transmits them to the gateway over TCP as a real device would.
 */
import net from 'node:net';
import { once } from 'node:events';
import { AstmClient, type AstmClientResult, type AstmRecord } from '@integration-hub/astm';

export interface AnalyzerSimulatorOptions {
  host: string;
  port: number;
  deviceName?: string;
  deviceId?: string;
  /** Number of messages to transmit. */
  count?: number;
  /** Delay between messages, ms. */
  intervalMs?: number;
  /** 0..1 chance of corrupting a frame (exercises NAK/retry). */
  corruptRate?: number;
  /** Deterministic patient/order/sample (for demos and matching fixtures). */
  fixed?: boolean;
  debug?: (line: string) => void;
}

export interface TransmittedMessage {
  records: AstmRecord[];
  result: AstmClientResult;
  summary: { patientId: string; orderId: string; tests: number };
}

export interface TestTemplate {
  code: string;
  name: string;
  unit: string;
  ref: string;
  min: number;
  max: number;
  decimals: number;
}

export const TEST_POOL: TestTemplate[] = [
  { code: 'GLU', name: 'Glucose', unit: 'mg/dL', ref: '70-110', min: 70, max: 110, decimals: 1 },
  { code: 'CREA', name: 'Creatinine', unit: 'mg/dL', ref: '0.6-1.3', min: 0.6, max: 1.3, decimals: 1 },
  { code: 'UREA', name: 'Urea', unit: 'mg/dL', ref: '15-40', min: 15, max: 40, decimals: 0 },
  { code: 'ALT', name: 'ALT', unit: 'U/L', ref: '7-56', min: 7, max: 56, decimals: 0 },
  { code: 'AST', name: 'AST', unit: 'U/L', ref: '10-40', min: 10, max: 40, decimals: 0 },
  { code: 'WBC', name: 'WBC', unit: '10^3/uL', ref: '4.0-11.0', min: 4, max: 11, decimals: 1 },
  { code: 'HGB', name: 'Hemoglobin', unit: 'g/dL', ref: '13.0-17.0', min: 13, max: 17, decimals: 1 },
  { code: 'PLT', name: 'Platelets', unit: '10^3/uL', ref: '150-450', min: 150, max: 450, decimals: 0 },
];

export const PATIENTS = [
  { id: 'PID-1001', name: 'Adeyemi^Tunde', dob: '19850312', gender: 'M' },
  { id: 'PID-1002', name: 'Okafor^Chioma', dob: '19921107', gender: 'F' },
  { id: 'PID-1003', name: 'Balogun^Femi', dob: '19760823', gender: 'M' },
  { id: 'PID-1004', name: 'Eze^Ngozi', dob: '20010415', gender: 'F' },
  { id: 'PID-1005', name: 'Adeleke^Bisi', dob: '19650930', gender: 'F' },
];

export class AnalyzerSimulator {
  private readonly deviceName: string;
  private readonly deviceId: string;
  private readonly count: number;
  private readonly intervalMs: number;
  private readonly corruptRate: number;
  private readonly fixed: boolean;
  private readonly debug?: (line: string) => void;

  constructor(private readonly opts: AnalyzerSimulatorOptions) {
    this.deviceName = opts.deviceName ?? 'SIM-BS430';
    this.deviceId = opts.deviceId ?? 'SIM-001';
    this.count = opts.count ?? 3;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.corruptRate = opts.corruptRate ?? 0;
    this.fixed = opts.fixed ?? false;
    this.debug = opts.debug;
  }

  async run(): Promise<TransmittedMessage[]> {
    const transmitted: TransmittedMessage[] = [];
    for (let i = 0; i < this.count; i++) {
      if (i > 0 && this.intervalMs > 0) await sleep(this.intervalMs);
      transmitted.push(await this.runOnce());
    }
    return transmitted;
  }

  async runOnce(): Promise<TransmittedMessage> {
    const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
    socket.on('error', (err) => {
      throw new Error(`cannot connect to gateway at ${this.opts.host}:${this.opts.port}: ${err.message}`);
    });
    await once(socket, 'connect');

    try {
      const client = new AstmClient(socket, { corruptRate: this.corruptRate, debug: this.debug });
      const records = this.buildResultMessage();
      const result = await client.run(records);
      socket.end();
      await once(socket, 'close');
      return { records, result, summary: summarize(records) };
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  private buildResultMessage(): AstmRecord[] {
    const now = new Date();
    // Fixed fixture (demo/certification): deterministic patient, order and tests
    // so the hub can match against a pre-registered expected order.
    const patient = this.fixed ? PATIENTS[0]! : pick(PATIENTS);
    const orderId = this.fixed ? 'ACC-424242' : `ACC-${randInt(100000, 999999)}`;
    const sampleId = this.fixed ? 'S-4242' : `S-${randInt(10000, 99999)}`;
    const tests = this.fixed ? [TEST_POOL[0]!, TEST_POOL[1]!] : pickN(TEST_POOL, 2 + randInt(0, 2));

    const records: AstmRecord[] = [
      {
        type: 'H',
        fields: [
          '\\^&', '', '', '', `${this.deviceName}^${this.deviceId}`,
          '', '', '', '', '', '', 'P', '1', formatTimestamp(now),
        ],
      },
      {
        type: 'P',
        fields: ['1', '', patient.id, patient.name, '', patient.dob, patient.gender],
      },
      {
        type: 'O',
        fields: ['1', sampleId, orderId, `^${tests[0]!.code}^${tests[0]!.name}`],
      },
    ];

    tests.forEach((test, i) => {
      const { value, flag } = randomResult(test);
      records.push({
        type: 'R',
        fields: [String(i + 1), `^${test.code}^${test.name}`, value, test.unit, test.ref, flag, '', 'F'],
      });
    });

    records.push({ type: 'L', fields: ['1', 'N'] });
    return records;
  }
}

export function randomResult(test: TestTemplate): { value: string; flag: string } {
  // ~15% abnormal results, flagged accordingly.
  const abnormal = Math.random() < 0.15;
  const high = abnormal && Math.random() < 0.6;
  const low = high ? false : abnormal;
  const value = abnormal
    ? high ? test.max + Math.random() * test.max * 0.2 : Math.max(0, test.min - Math.random() * test.min * 0.3)
    : test.min + Math.random() * (test.max - test.min);
  const formatted = value.toFixed(test.decimals);
  const flag = high ? 'H' : low ? 'L' : 'N';
  return { value: formatted, flag };
}

function summarize(records: AstmRecord[]): TransmittedMessage['summary'] {
  const patient = records.find((r) => r.type === 'P');
  const order = records.find((r) => r.type === 'O');
  const results = records.filter((r) => r.type === 'R');
  return {
    patientId: patient?.fields[2] ?? '?',
    orderId: order?.fields[2] ?? '?',
    tests: results.length,
  };
}

export function formatTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)]!;
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

export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}