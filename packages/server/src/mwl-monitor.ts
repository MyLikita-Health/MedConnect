/**
 * M3.2 MWL study monitor (plan §7.C2 / §13.16): the standing loop that points
 * the hub at a real Orthanc — every tick it pushes the order registry's active
 * orders onto the Orthanc worklist (idempotently, via WorklistService) and
 * polls for the studies the modalities have performed (C-STORE landing =
 * accession match). Performed studies are retired from the worklist and
 * surfaced on the monitor's status (`hub.mwl`); routing their metadata onward
 * (storage routing / M3.3) belongs to the caller/wiring.
 *
 * Pure orchestration over the registries + DicomOrthancAdapter — enabled in
 * startHub when ORTHANC_URL (or opts.orthanc) is set.
 */
import { DicomOrthancAdapter, WorklistService, type MwlOrder, type MwlPerformedStudy, type MwlRunResult } from '@integration-hub/dicom';
import type { AdmissionRegistry, OrderRegistry } from '@integration-hub/core';

export interface MwlMonitorOptions {
  /** Orthanc REST base URL (env ORTHANC_URL). */
  baseUrl: string;
  username?: string;
  password?: string;
  /**
   * Pre-built adapter (startHub shares one with the storage-router forwarding
   * leg). Defaults to a fresh adapter over baseUrl/username/password.
   */
  adapter?: DicomOrthancAdapter;
  /** Sync+poll cadence in ms (env MWL_POLL_MS). Default 60s. */
  pollMs?: number;
  /** Orders destined for the modality worklist (the LIS seam). */
  orders: OrderRegistry;
  /** Optional patient-admission registry — enriches items with the patient name. */
  admissions?: AdmissionRegistry;
  /** Scheduled modality for registry orders that carry none (default CT). */
  defaultModality?: string;
  /**
   * M3.3 storage routing seam: invoked with each poll's performed studies
   * AFTER the worklist item was retired but BEFORE they count as done — when
   * it throws, the poll fails and the accession is NOT marked retired, so the
   * next cycle re-syncs the item and routes again (never a lost study event).
   */
  onPerformed?: (performed: MwlPerformedStudy[]) => void | Promise<void>;
  /**
   * Alerting seam (workstream I): called with each poll's outcome — a failed
   * poll raises the `orthanc-down` alert (consecutive count, subject = the
   * monitor's baseUrl), a successful poll clears it. Errors are logged, never
   * allowed to fail the poll itself.
   */
  alerts?: { orthancPoll: (ok: boolean, error?: string) => void | Promise<void> };
  log?: (line: string) => void;
}

/** A performed study observed by the monitor, with the time it was seen. */
export interface MwlPerformedRecord extends MwlPerformedStudy {
  at: string;
}

export interface MwlMonitorStatus {
  enabled: boolean;
  baseUrl?: string;
  pollMs?: number;
  lastRunAt?: string;
  lastError?: string;
  /** Outcome of the last successful poll. */
  lastRun?: MwlRunResult;
  /** Performed studies observed so far (most recent first). */
  performed: MwlPerformedRecord[];
  /** Cumulative worklist pushes across polls. */
  totals: { created: number; queued: number; failed: number };
}

/** One live worklist item as Orthanc reports it (the worklist view). */
export interface MwlWorklistItem {
  worklistId: string;
  accession?: string;
  patientId?: string;
  patientName?: string;
  modality?: string;
  scheduledDate?: string;
}

export class MwlMonitor {
  private readonly service: WorklistService;
  private readonly adapter: DicomOrthancAdapter;
  private readonly log: (line: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private lastRunAt?: string;
  private lastError?: string;
  private lastRun?: MwlRunResult;
  private performed: MwlPerformedRecord[] = [];
  private totals = { created: 0, queued: 0, failed: 0 };
  /** Accessions whose study already landed — no longer synced (the registry
   *  order stays active for lab matching, so the monitor tracks retirement). */
  private readonly retired = new Set<string>();

  constructor(private readonly opts: MwlMonitorOptions) {
    this.adapter = opts.adapter ?? new DicomOrthancAdapter({ baseUrl: opts.baseUrl, username: opts.username, password: opts.password });
    this.service = new WorklistService(this.adapter, { defaultModality: opts.defaultModality ?? 'CT' });
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /**
   * The live Orthanc worklist right now (adapter listing — the operator view
   * of what modalities will C-FIND). Throws when Orthanc is unreachable.
   */
  async worklist(): Promise<MwlWorklistItem[]> {
    const out: MwlWorklistItem[] = [];
    for (const id of await this.adapter.listWorklistIds()) {
      const item = await this.adapter.getWorklistItem(id);
      const tags = (item.Tags ?? item) as Record<string, unknown>;
      const step = Array.isArray(tags.ScheduledProcedureStepSequence)
        ? (tags.ScheduledProcedureStepSequence as Record<string, unknown>[])[0]
        : undefined;
      out.push({
        worklistId: id,
        ...(typeof tags.AccessionNumber === 'string' ? { accession: tags.AccessionNumber } : {}),
        ...(typeof tags.PatientID === 'string' ? { patientId: tags.PatientID } : {}),
        ...(typeof tags.PatientName === 'string' ? { patientName: tags.PatientName } : {}),
        ...(step && typeof step.Modality === 'string' ? { modality: step.Modality } : {}),
        ...(step && typeof step.ScheduledProcedureStepStartDate === 'string' ? { scheduledDate: step.ScheduledProcedureStepStartDate } : {}),
      });
    }
    return out;
  }

  /** Tail of the poll chain — polls are serialized so a boot tick and a
   *  scheduled tick never run concurrently (sync is list-then-create; two
   *  overlapping syncs would double-create an accession). */
  private tail: Promise<unknown> = Promise.resolve();

  /** Start the standing loop: one poll immediately, then every pollMs. */
  start(): void {
    if (this.timer) return;
    const pollMs = this.opts.pollMs ?? 60_000;
    this.timer = setInterval(() => {
      void this.poll();
    }, pollMs);
    // Never hold the process open on the timer alone (hub.stop clears it too).
    this.timer.unref?.();
    void this.poll();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Let an in-flight/queued poll finish so no request outlives the hub.
    await this.tail;
  }

  status(): MwlMonitorStatus {
    return {
      enabled: true,
      baseUrl: this.opts.baseUrl,
      pollMs: this.opts.pollMs ?? 60_000,
      lastRunAt: this.lastRunAt,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      ...(this.lastRun ? { lastRun: this.lastRun } : {}),
      performed: this.performed,
      totals: { ...this.totals },
    };
  }

  /** One sync+poll pass — returns the outcome, or undefined when it failed. */
  poll(): Promise<MwlRunResult | undefined> {
    const run = this.tail.then(() => this.runOnce());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runOnce(): Promise<MwlRunResult | undefined> {
    try {
      const started = Date.now();
      const result = await this.service.run(await this.collectOrders());
      this.lastRunAt = new Date().toISOString();
      this.lastError = undefined;
      this.lastRun = result;
      this.totals.created += result.created.length;
      this.totals.queued += result.queued.length;
      this.totals.failed += result.failed.length;
      for (const p of result.performed) {
        this.performed.unshift({ ...p, at: new Date().toISOString() });
      }
      if (this.performed.length > 100) this.performed.length = 100;

      // Route performed studies onward (M3.3 seam). Only when routing succeeds
      // are the accessions retired — a throw leaves them re-syncable so the
      // next poll re-creates the item and routes again (no lost event).
      if (result.performed.length > 0 && this.opts.onPerformed) {
        await this.opts.onPerformed(result.performed);
      }
      for (const p of result.performed) {
        this.retired.add(p.order.accession);
      }

      // The poll succeeded — Orthanc answered, so any open orthanc-down alert
      // (raised by consecutive failures) is cleared.
      await this.reportAlert(true);

      const ms = Date.now() - started;
      const summary = `[mwl] sync+poll: ${result.created.length} created, ${result.queued.length} queued, ${result.failed.length} failed · ${result.performed.length} performed (${ms}ms)`;
      if (result.failed.length === 0) {
        this.log(summary);
      } else {
        this.log(`${summary} — failed accessions: ${result.failed.join(', ')}`);
      }
      for (const p of result.performed) {
        this.log(`[mwl]   study ${p.study.orthancId.slice(0, 8)}… performed accession ${p.order.accession} — worklist item retired`);
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.log(`[mwl] poll failed: ${msg}`);
      await this.reportAlert(false, msg);
      return undefined;
    }
  }

  /** Feed the alerting seam without ever failing the poll on its errors. */
  private async reportAlert(ok: boolean, error?: string): Promise<void> {
    if (!this.opts.alerts) return;
    try {
      await this.opts.alerts.orthancPoll(ok, error);
    } catch (err) {
      this.log(`[mwl] alert update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Active registry orders → worklist orders (patient name from admissions). */
  private async collectOrders(): Promise<MwlOrder[]> {
    const active = (await this.opts.orders.list()).filter(
      (order) => order.status === 'active' && !this.retired.has(order.id),
    );
    const out: MwlOrder[] = [];
    for (const order of active) {
      // The order registry carries the accession (id) + patient id only; the
      // admission registry adds the patient name for the modality's display.
      let patientName: string | undefined;
      if (this.opts.admissions) {
        const records = await this.opts.admissions.find(order.patientId);
        patientName = records[records.length - 1]?.name;
      }
      out.push({
        accession: order.id,
        patientId: order.patientId,
        ...(patientName ? { patientName } : {}),
      });
    }
    return out;
  }
}
