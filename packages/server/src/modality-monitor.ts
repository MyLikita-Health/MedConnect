/**
 * M3 modality-health monitor (plan §7.C4 / §13.16, C6 close-out): Orthanc
 * knows which DICOM modalities are configured (C-STORE/C-ECHO targets), so
 * the hub mirrors each one into the device registry + device-offline alerting
 * exactly like a wire device. Every tick this loop lists Orthanc's configured
 * modalities and C-ECHOs each one (the adapter's REST-only probe — no Node
 * DICOM stack, §3.2/R6); the `onStates` seam reports the per-modality outcome
 * so the wiring can flip device rows and alerts. Orthanc itself is tracked
 * separately by the MWL monitor (`orthanc-down`); this is the modality layer
 * under it — when the list call itself fails (Orthanc unreachable) nothing is
 * reported and the last known modality states stay put.
 *
 * Pure orchestration over DicomOrthancAdapter — enabled in startHub when
 * ORTHANC_URL (or opts.orthanc) is set.
 */
import { DicomOrthancAdapter } from '@integration-hub/dicom';

export interface ModalityState {
  /** Orthanc modality config name (the device id/row key). */
  name: string;
  state: 'connected' | 'disconnected';
  /** C-ECHO failure detail when disconnected. */
  error?: string;
  /** When this state was observed. */
  at: string;
}

export interface ModalityMonitorOptions {
  /** Orthanc REST base URL (env ORTHANC_URL). */
  baseUrl: string;
  username?: string;
  password?: string;
  /** Pre-built adapter (startHub shares one with the MWL monitor + router). */
  adapter?: DicomOrthancAdapter;
  /** C-ECHO cadence in ms (env MODALITY_POLL_MS). Default 30s. */
  pollMs?: number;
  /**
   * Health seam: called once per successful tick with the state of every
   * modality Orthanc currently lists. Not called when the list call fails —
   * a down Orthanc leaves the last-known states (and device rows) unchanged.
   */
  onStates?: (states: ModalityState[]) => void | Promise<void>;
  log?: (line: string) => void;
}

export interface ModalityMonitorStatus {
  enabled: boolean;
  baseUrl?: string;
  pollMs?: number;
  lastRunAt?: string;
  lastError?: string;
  /** Latest known state per configured modality. */
  modalities: ModalityState[];
}

export class ModalityMonitor {
  private readonly adapter: DicomOrthancAdapter;
  private readonly log: (line: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private lastRunAt?: string;
  private lastError?: string;
  private states: ModalityState[] = [];
  /** Tail of the probe chain — ticks are serialized (list-then-echo). */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ModalityMonitorOptions) {
    this.adapter = opts.adapter ?? new DicomOrthancAdapter({ baseUrl: opts.baseUrl, username: opts.username, password: opts.password });
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /** Start the standing loop: one tick immediately, then every pollMs. */
  start(): void {
    if (this.timer) return;
    const pollMs = this.opts.pollMs ?? 30_000;
    this.timer = setInterval(() => {
      void this.poll();
    }, pollMs);
    this.timer.unref?.();
    void this.poll();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.tail;
  }

  status(): ModalityMonitorStatus {
    return {
      enabled: true,
      baseUrl: this.opts.baseUrl,
      pollMs: this.opts.pollMs ?? 30_000,
      lastRunAt: this.lastRunAt,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      modalities: this.states,
    };
  }

  /** One list+echo pass — the states observed, or undefined when it failed. */
  poll(): Promise<ModalityState[] | undefined> {
    const run = this.tail.then(() => this.runOnce());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runOnce(): Promise<ModalityState[] | undefined> {
    try {
      const started = Date.now();
      const names = await this.adapter.listModalities();
      const states: ModalityState[] = [];
      for (const name of names) {
        const at = new Date().toISOString();
        try {
          await this.adapter.echoModality(name);
          states.push({ name, state: 'connected', at });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          states.push({ name, state: 'disconnected', error: msg, at });
          this.log(`[modality] ${name} C-ECHO failed: ${msg}`);
        }
      }
      this.lastRunAt = new Date().toISOString();
      this.lastError = undefined;
      this.states = states;

      // Report only on a successful list — a down Orthanc (list throw) below
      // reports nothing, so the last-known rows/alerts are untouched.
      await this.reportStates(states);

      const ms = Date.now() - started;
      const up = states.filter((s) => s.state === 'connected').length;
      this.log(`[modality] C-ECHO ${names.length} modality(ies): ${up} up, ${states.length - up} down (${ms}ms)`);
      return states;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.log(`[modality] modality poll failed: ${msg}`);
      return undefined;
    }
  }

  /** Feed the health seam without ever failing the tick on its errors. */
  private async reportStates(states: ModalityState[]): Promise<void> {
    if (!this.opts.onStates) return;
    try {
      await this.opts.onStates(states);
    } catch (err) {
      this.log(`[modality] state report failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
