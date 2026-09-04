/**
 * M3.3 storage routing (plan §7.C3): the performed studies the MWL monitor
 * observes become hub messages that flow through the dispatcher — dedup →
 * DB-driven route rules (RouteStore) → delivery (console/http built-ins,
 * retry/DLQ) — so study metadata is routed, persisted and auditable exactly
 * like lab messages. Pixels never enter the hub: the message carries the
 * canonical ImagingStudy metadata whose storageUrl points back at Orthanc.
 *
 * The imaging messages ride in the envelope's `imaging` field (not the lab
 * `payload`): they are hub-originated events, not parse→map translations.
 */
import { randomUUID } from 'node:crypto';
import type { CanonicalMessage } from '@integration-hub/shared';
import type { MwlPerformedStudy } from '@integration-hub/dicom';
import type { Dispatcher } from '@integration-hub/core';

/**
 * Build the hub message that records + routes one performed study. The `raw`
 * text is stable per study (protocol + device + raw feed the dedup key), so a
 * repeated observation of the same study dedups instead of double-routing;
 * the message id is unique per observation.
 */
export function buildStudyMessage(performed: MwlPerformedStudy, at = new Date().toISOString()): CanonicalMessage {
  const { study, order } = performed;
  const raw = `ORTHANC study ${study.studyInstanceUid ?? study.orthancId} accession ${order.accession} performed`;
  return {
    id: randomUUID(),
    protocol: 'REST',
    direction: 'device-to-host',
    deviceId: 'orthanc',
    receivedAt: at,
    raw,
    imaging: { kind: 'imaging', study, accession: order.accession, performedAt: at },
    status: 'MAPPED',
    errors: [],
    timeline: [
      { stage: 'RECEIVED', at, note: 'performed study observed by the MWL monitor' },
      { stage: 'MAPPED', at, note: `study ${study.orthancId.slice(0, 8)}… accession ${order.accession} — routing` },
    ],
  };
}

/** Routes performed studies into the dispatcher (the M3.3 event leg). */
export class ImagingRouter {
  constructor(readonly dispatcher: Dispatcher) {}

  async routePerformed(performed: MwlPerformedStudy[]): Promise<void> {
    for (const study of performed) {
      await this.dispatcher.record(buildStudyMessage(study));
    }
  }
}
