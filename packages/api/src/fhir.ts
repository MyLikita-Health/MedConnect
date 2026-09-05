/**
 * D1 — FHIR R4 REST surface (workstream D / M4, plan §7.D D1). Serves the
 * platform's own stores AS FHIR resources, so an LIS/HIS/EHR/PMS vendor can
 * integrate against a standard R4 base instead of the hub's JSON API:
 *
 *   GET /api/v1/fhir/metadata            → CapabilityStatement
 *   GET /api/v1/fhir/:type               → searchset Bundle (?_id= filters)
 *   GET /api/v1/fhir/:type/:id           → single resource (404 = OperationOutcome)
 *
 * Mounted under /api/v1 so the route inherits key auth + the fail-closed
 * ROUTE_SCOPES table (every GET here is `api:read`; the client points its
 * FHIR base at <hub>/api/v1/fhir).
 *
 * Resources are projected from what the hub actually stores:
 *   - lab messages (payload)  → Patient, ServiceRequest, DiagnosticReport,
 *     one Observation per result  (canonicalToFhir, @integration-hub/fhir)
 *   - imaging messages (M3.3) → ImagingStudy          (imagingToFhir)
 *   - the device registry     → Device                (deviceToFhir)
 * When several messages carry the same resource (a corrected result re-sent
 * for one accession), the NEWEST message wins.
 *
 * v1 limits: read + search only (no write/update); `_id` is the only search
 * param; imaging series detail (Orthanc ids) has no FHIR representation, so
 * ImagingStudy carries study-level metadata + numberOfSeries.
 */
import type { FastifyInstance } from 'fastify';
import {
  canonicalToFhir,
  imagingToFhir,
  deviceToFhir,
  type FhirResource,
} from '@integration-hub/fhir';
import type { DeviceBackend, StoreBackend } from './backend.js';

const RESOURCE_TYPES = ['Patient', 'ServiceRequest', 'DiagnosticReport', 'Observation', 'ImagingStudy', 'Device'];

function operationOutcome(code: string, diagnostics: string) {
  return {
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code, diagnostics }],
  };
}

function capabilityStatement(): unknown {
  const resource = (type: string) => ({
    type,
    interaction: [{ code: 'read' }, { code: 'search-type' }],
  });
  return {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: new Date().toISOString(),
    kind: 'instance',
    fhirVersion: '4.0.1',
    format: ['application/fhir+json'],
    implementation: { description: 'Integration Hub FHIR R4 outward surface (D1)' },
    rest: [
      {
        mode: 'server',
        resource: RESOURCE_TYPES.map(resource),
      },
    ],
  };
}

/**
 * Collect every FHIR resource currently derivable from the stores. Newest
 * message wins for duplicate ids (a correction supersedes the earlier send).
 */
async function collect(opts: { store: StoreBackend; devices: DeviceBackend }): Promise<Map<string, FhirResource>> {
  const byKey = new Map<string, FhirResource>();
  const put = (r: FhirResource): void => {
    byKey.set(`${r.resourceType}/${r.id ?? ''}`, r);
  };

  const messages = await opts.store.list({ limit: 500 });
  // store.list is newest-first; walk oldest → newest so `put` overwrites with
  // the newest version of any duplicated resource.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.payload) {
      for (const r of canonicalToFhir(m.payload)) put(r);
    }
    if (m?.imaging) put(imagingToFhir(m.imaging));
  }
  for (const device of await opts.devices.list()) put(deviceToFhir(device));
  return byKey;
}

export function registerFhirRoutes(app: FastifyInstance, opts: { store: StoreBackend; devices: DeviceBackend }): void {
  const fhirReply = (reply: { type: (t: string) => unknown }): void => {
    reply.type('application/fhir+json');
  };

  app.get('/api/v1/fhir/metadata', async (_req, reply) => {
    fhirReply(reply);
    return capabilityStatement();
  });

  // Search: GET /api/v1/fhir/:type[?_id=id]
  app.get('/api/v1/fhir/:type', async (req, reply) => {
    fhirReply(reply);
    const { type } = req.params as { type: string };
    if (!RESOURCE_TYPES.includes(type)) {
      return reply.code(404).send(operationOutcome('not-found', `unknown resource type: ${type}`));
    }
    const query = req.query as { _id?: string };
    const resources = [...(await collect(opts)).values()].filter(
      (r) => r.resourceType === type && (!query._id || r.id === query._id),
    );
    return {
      resourceType: 'Bundle',
      type: 'searchset',
      total: resources.length,
      entry: resources.map((resource) => ({ resource, search: { mode: 'match' } })),
    };
  });

  // Read: GET /api/v1/fhir/:type/:id
  app.get('/api/v1/fhir/:type/:id', async (req, reply) => {
    fhirReply(reply);
    const { type, id } = req.params as { type: string; id: string };
    if (!RESOURCE_TYPES.includes(type)) {
      return reply.code(404).send(operationOutcome('not-found', `unknown resource type: ${type}`));
    }
    const resource = (await collect(opts)).get(`${type}/${id}`);
    if (!resource) {
      return reply.code(404).send(operationOutcome('not-found', `${type}/${id} not found`));
    }
    return resource;
  });
}