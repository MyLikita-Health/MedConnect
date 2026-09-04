/**
 * Vendor-variant HL7 simulator (workstream B4 / profile testing): the HL7
 * sibling of `Hl7OruSimulator` that emits **B4-deviant** ORU^R01 / ORM^O01
 * transcripts — real vendors deviate from the generic PID/OBR/OBX positions
 * (name at PID-6, code at OBX-3^2, order id at ORC-4, a lying MSH-2 …), and
 * a hub parses each deviation correctly only when the device's profile binds
 * the matching `hl7` layout (`Hl7Gateway.resolveLayout`).
 *
 * Each variant ships its `Hl7RecordLayout` override (`VARIANT_DEFS`), so the
 * same deterministic transcript doubles as the conformance oracle: feed the
 * wire through `hl7ToCanonical`/`hl7ToOrder` without the layout → it fails
 * or misreads; with the layout → the exact canonical payload. That is the
 * layout-based conformance machinery goldens-in-CI will run against real
 * vendor transcripts (plan §13.15).
 */
import net from 'node:net';
import { once } from 'node:events';
import { MllpClient, parseMessage, segmentField } from '@integration-hub/hl7';
import type { Hl7RecordLayout } from '@integration-hub/shared';
import { formatTimestamp, randInt, sleep } from './analyzer.js';

export type VariantKind = 'oru' | 'orm';
export type VariantName = 'pid6-name' | 'obx-swap' | 'delimiters' | 'pid4-id' | 'orc4-id';

export interface VariantDef {
  /** Human description of the deviation (shown by the CLI). */
  description: string;
  /** The B4 profile `hl7` layout that decodes this deviation. */
  layout: Hl7RecordLayout;
}

export const VARIANT_DEFS: Record<VariantName, VariantDef> = {
  'pid6-name': {
    description: 'patient name at PID-6 (PID-5 empty)',
    layout: { patient: { name: { field: 6 } } },
  },
  'obx-swap': {
    description: 'OBX-3 carries name^code (identifier at component 2)',
    layout: { result: { testCode: { field: 3, component: 2 }, testName: { field: 3, component: 1 } } },
  },
  delimiters: {
    description: "MSH-2 lies — declares '&' as the component separator, the wire uses '^'",
    layout: { delimiters: { component: '^' } },
  },
  'pid4-id': {
    description: 'patient id at PID-4 (PID-3 empty)',
    layout: { patient: { id: { field: 4, component: 1 } } },
  },
  'orc4-id': {
    description: 'order id at ORC-4 (filler) instead of ORC-3',
    layout: { order: { fillerId: { field: 4, component: 1 } } },
  },
};

export interface Hl7VariantSimulatorOptions {
  host: string;
  port: number;
  /** MSH-3 sending application — the device identity the hub records. */
  deviceName?: string;
  kind?: VariantKind;
  variant?: VariantName;
  count?: number;
  /** Delay between messages, ms. */
  intervalMs?: number;
  debug?: (line: string) => void;
}

export interface TransmittedVariant {
  raw: string;
  ackStatus?: string;
  summary: { patientId: string; orderId: string; tests: number };
}

/**
 * Deterministic vendor-variant transcript (the fixture the conformance oracle
 * asserts against): patient PID-1001 / order ACC-424242 / GLU + CREA. Pass a
 * frozen `timestamp` + `controlId` to reproduce a recorded golden byte-for-
 * byte; defaults stay time-random for live simulation.
 */
export function buildVariantMessage(
  kind: VariantKind,
  variant: VariantName,
  opts: { deviceName?: string; controlId?: string; timestamp?: string } = {},
): string {
  const device = opts.deviceName ?? 'SIM-HL7';
  const controlId = opts.controlId ?? `HL7-${randInt(100000, 999999)}`;
  const ts = opts.timestamp ?? formatTimestamp(new Date());
  const component = variant === 'delimiters' ? '&' : '^';
  const msh9 = kind === 'oru' ? 'ORU^R01' : 'ORM^O01';

  // PID: pid4-id variant carries the id in PID-4, PID-3 empty.
  // PID field counting is positional: pid4-id puts the id in PID-4 (PID-3
  // empty, name stays at PID-5); pid6-name puts the name in PID-6 (PID-5
  // empty, dob/gender stay at PID-7/8).
  const pid = variant === 'pid4-id'
    ? 'PID|1|||PID-1001^^^FAC1^PI|Adeyemi^Tunde||19850312|M'
    : variant === 'pid6-name'
      ? 'PID|1||PID-1001^^^FAC1^PI|||Adeyemi^Tunde|19850312|M'
      : 'PID|1||PID-1001^^^FAC1^PI||Adeyemi^Tunde||19850312|M';

  const segments = [
    `MSH|${component}~\\&|${device}|FAC1|HUB|FAC2|${ts}||${msh9}|${controlId}|P|2.5.1`,
    pid,
  ];

  if (kind === 'oru') {
    segments.push(
      'OBR|1||ACC-424242|GLU^Glucose',
      // obx-swap: name^code (identifier at component 2 of OBX-3).
      variant === 'obx-swap'
        ? 'OBX|1|NM|Glucose^GLU||95|mg/dL|70-110|N|||F'
        : 'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
      variant === 'obx-swap'
        ? 'OBX|2|NM|Creatinine^CREA||1.2|mg/dL|0.6-1.3|N|||F'
        : 'OBX|2|NM|CREA^Creatinine||1.2|mg/dL|0.6-1.3|N|||F',
    );
  } else {
    // orc4-id: the order id rides in ORC-4 (their filler position), ORC-3
    // empty; requested tests still live on the OBR rows.
    const orc = variant === 'orc4-id'
      ? 'ORC|NW|PL-77||LIS-ORD-9|GLU^Glucose'
      : 'ORC|NW|PL-77|ACC-424242|GLU^Glucose';
    segments.push(
      orc,
      variant === 'orc4-id'
        ? 'OBR|1|PL-77||GLU^Glucose'
        : 'OBR|1|PL-77|ACC-424242|GLU^Glucose',
      variant === 'orc4-id'
        ? 'OBR|2|PL-77||CREA^Creatinine'
        : 'OBR|2|PL-77|ACC-424242|CREA^Creatinine',
    );
  }

  return segments.join('\r');
}

/** Vendor-variant simulator: deviant wire → MLLP → application ACK. */
export class Hl7VariantSimulator {
  private readonly deviceName: string;
  private readonly kind: VariantKind;
  private readonly variant: VariantName;
  private readonly count: number;
  private readonly intervalMs: number;
  private readonly debug?: (line: string) => void;

  constructor(private readonly opts: Hl7VariantSimulatorOptions) {
    this.deviceName = opts.deviceName ?? 'SIM-HL7';
    this.kind = opts.kind ?? 'oru';
    this.variant = opts.variant ?? 'pid6-name';
    this.count = opts.count ?? 3;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.debug = opts.debug;
  }

  async run(): Promise<TransmittedVariant[]> {
    const transmitted: TransmittedVariant[] = [];
    for (let i = 0; i < this.count; i++) {
      if (i > 0 && this.intervalMs > 0) await sleep(this.intervalMs);
      transmitted.push(await this.runOnce());
    }
    return transmitted;
  }

  async runOnce(): Promise<TransmittedVariant> {
    const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
    socket.on('error', (err) => {
      throw new Error(`cannot connect to the hub at ${this.opts.host}:${this.opts.port}: ${err.message}`);
    });
    await once(socket, 'connect');
    try {
      const raw = buildVariantMessage(this.kind, this.variant, { deviceName: this.deviceName });
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
}

function summarize(raw: string): TransmittedVariant['summary'] {
  const msg = parseMessage(raw);
  const pid = msg.segments.find((s) => s.id === 'PID');
  const orc = msg.segments.find((s) => s.id === 'ORC');
  const obr = msg.segments.find((s) => s.id === 'OBR');
  const results = msg.segments.filter((s) => s.id === 'OBX');
  const orderId = obr ? segmentField(obr, 2) ?? undefined : undefined;
  return {
    patientId: pid ? segmentField(pid, 2) ?? '?' : '?',
    orderId: orderId ?? (orc ? segmentField(orc, 2) ?? '?' : '?'),
    tests: results.length,
  };
}