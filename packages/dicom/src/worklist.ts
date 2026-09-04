/**
 * Modality-worklist sync + performed-study monitor (workstream M3.2, plan
 * §7.C2): the hub side of the MWL workflow —
 *
 *   RIS order (the hub's order registry / ORM feed) → Orthanc worklist item
 *     (the new Worklists plugin REST API via DicomOrthancAdapter) → the
 *     modality C-FINDs it (DICOM MWL), performs the study, C-STOREs it into
 *     Orthanc → the hub POLLS for the performed study (accession match via
 *     POST /tools/find) and retires the worklist item.
 *
 * The service is pure orchestration over the adapter — no core imports (the
 * structural `MwlOrder` mirrors what the hub's order registry hands over);
 * marking ImagingRequest.status 'performed' and routing the study metadata
 * (M3.3) belong to the caller/wiring.
 *
 * Live caveat (plan §13.16): the running compose image ships the legacy
 * folder-based worklist plugin, not the REST one; the client targets the new
 * plugin's documented API and is pinned against a mock. Packaging
 * libOrthancWorklists into the container is C5 work.
 */
import type { ImagingStudy } from '@integration-hub/shared';
import type { DicomOrthancAdapter } from './adapter.js';

/** An order destined for a modality worklist (structural — registry-shaped). */
export interface MwlOrder {
  /** Accession number — the hub's order id (the RIS/ORM link). */
  accession: string;
  patientId: string;
  patientName?: string;
  /** Requested procedure description (0032,1060 / scheduled-step description). */
  requestedProcedure?: string;
  /** Scheduled modality, e.g. CT/MR/CR. Falls back to the service default. */
  modality?: string;
  /** ScheduledProcedureStepStartDate (YYYYMMDD); defaults to today. */
  scheduledDate?: string;
}

/** DICOM keyword tags for a worklist item, per the plugin's REST contract. */
export function orderToWorklistTags(order: MwlOrder, defaultModality = 'CT'): Record<string, unknown> {
  const tags: Record<string, unknown> = {
    PatientID: order.patientId,
    AccessionNumber: order.accession,
  };
  if (order.patientName) tags.PatientName = order.patientName;
  if (order.requestedProcedure) tags.RequestedProcedureDescription = order.requestedProcedure;
  tags.ScheduledProcedureStepSequence = [
    {
      Modality: order.modality ?? defaultModality,
      ScheduledProcedureStepStartDate: order.scheduledDate ?? new Date().toISOString().slice(0, 10).replaceAll('-', ''),
      ...(order.requestedProcedure ? { ScheduledProcedureStepDescription: order.requestedProcedure } : {}),
      // A stable scheduled-step id lets a modality echo it back (and helps
      // the operator match the worklist item to the RIS order).
      ScheduledProcedureStepID: order.accession,
    },
  ];
  return tags;
}

/** Per-order worklist status after a sync. */
export interface MwlSyncEntry {
  accession: string;
  worklistId?: string;
  /** 'created' when this sync placed the item; 'queued' when it already existed. */
  state: 'created' | 'queued' | 'failed';
  error?: string;
}

export interface MwlSyncResult {
  entries: MwlSyncEntry[];
  created: string[];
  queued: string[];
  failed: string[];
}

/** A study found for an outstanding order on this poll (not yet retired). */
export interface MwlPerformedStudy {
  order: MwlOrder;
  study: ImagingStudy;
}

export interface MwlRunResult extends MwlSyncResult {
  /** Studies found on this poll + the orders they performed. */
  performed: MwlPerformedStudy[];
}

/** AccessionNumber helper: tolerate the plugin's nested `Tags` or flat body. */
function accessionOf(item: { Tags?: Record<string, unknown> } & Record<string, unknown>): string | undefined {
  const tags = item.Tags ?? item;
  const value = tags.AccessionNumber;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Worklist sync + performed-study monitor. `sync(orders)` is idempotent:
 * items already on the worklist for an accession are left in place, missing
 * ones are created. `run(orders)` = sync, then poll Orthanc for studies whose
 * accession matches an order and retire those items — the modality's C-STORE
 * landing is how the hub learns the study was performed (MPPS would be more
 * immediate; that is an M5 refinement, plan §8.1).
 */
export class WorklistService {
  constructor(
    private readonly adapter: DicomOrthancAdapter,
    private readonly opts: { defaultModality?: string } = {},
  ) {}

  async sync(orders: MwlOrder[]): Promise<MwlSyncResult> {
    const entries: MwlSyncEntry[] = [];
    // Existing items, indexed by accession (small worklist volumes v1 — the
    // plugin has no query-by-accession, so we reconcile by listing + reading).
    const existing = new Map<string, string>();
    for (const id of await this.adapter.listWorklistIds()) {
      const accession = accessionOf(await this.adapter.getWorklistItem(id));
      if (accession) existing.set(accession, id);
    }

    for (const order of orders) {
      const already = existing.get(order.accession);
      if (already) {
        entries.push({ accession: order.accession, worklistId: already, state: 'queued' });
        continue;
      }
      try {
        const { id } = await this.adapter.createWorklistItem(orderToWorklistTags(order, this.opts.defaultModality));
        entries.push({ accession: order.accession, worklistId: id, state: 'created' });
      } catch (err) {
        entries.push({
          accession: order.accession,
          state: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return summarize(entries);
  }

  /** Poll for studies performed against the given orders; retire their items. */
  async pollPerformed(orders: MwlOrder[], worklistIds: Map<string, string>): Promise<MwlPerformedStudy[]> {
    const performed: MwlPerformedStudy[] = [];
    for (const order of orders) {
      const studies = await this.adapter.findStudies({ AccessionNumber: order.accession });
      if (studies.length === 0) continue;
      // The study landed: it is performed. Retire the worklist item (the
      // plugin can also auto-delete via DeleteWorklistsOnStableStudy when a
      // StudyInstanceUID is set — belt and braces either way).
      const worklistId = worklistIds.get(order.accession);
      if (worklistId) await this.adapter.deleteWorklistItem(worklistId).catch(() => undefined);
      performed.push({ order, study: studies[0]! });
    }
    return performed;
  }

  /** sync + poll in one pass — the standing M3.2 loop body. */
  async run(orders: MwlOrder[]): Promise<MwlRunResult> {
    const sync = await this.sync(orders);
    const worklistIds = new Map(
      sync.entries.filter((e) => e.worklistId !== undefined).map((e) => [e.accession, e.worklistId!]),
    );
    const performed = await this.pollPerformed(orders, worklistIds);
    return { ...sync, performed };
  }
}

function summarize(entries: MwlSyncEntry[]): MwlSyncResult {
  return {
    entries,
    created: entries.filter((e) => e.state === 'created').map((e) => e.accession),
    queued: entries.filter((e) => e.state === 'queued').map((e) => e.accession),
    failed: entries.filter((e) => e.state === 'failed').map((e) => e.accession),
  };
}