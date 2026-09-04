/**
 * DicomOrthancAdapter (workstream M3.1, plan §7.C1 + §3.2): the hub's DICOM
 * window is **Orthanc's REST API** — never a hand-written Node DICOM stack
 * (decision §3.2, risk R6). This module is the thin REST client wrapper:
 *
 *   metadata reads      list/get patients·studies·series·instances (mapped to
 *                       the canonical imaging shapes — §6.2, pixels never in
 *                       the hub DB; storage URLs point back at Orthanc)
 *   find                POST /tools/find (study-level queries)
 *   forwarding          store to a configured DICOM peer/modality (C3) +
 *                       echo for modality health (C4)
 *   lifecycle           delete resources; peer/modality listing
 *
 * The adapter is tested against a mock Orthanc HTTP server; real integration
 * (worklist creation for MWL — C2) lands in M3.2 on the same REST substrate.
 */
import type {
  ImagingInstance,
  ImagingPatient,
  ImagingPeer,
  ImagingSeries,
  ImagingStudy,
} from '@integration-hub/shared';

export interface OrthancAdapterOptions {
  /** Base URL of the Orthanc REST API, e.g. http://127.0.0.1:8042 (no trailing slash). */
  baseUrl: string;
  /** Optional HTTP Basic credentials (Orthanc remote-access users). */
  username?: string;
  password?: string;
  /** Per-request timeout (ms). Default 10s. */
  timeoutMs?: number;
}

export interface OrthancSystemInfo {
  version: string;
  name?: string;
}

/** An Orthanc resource reference for store/forward calls. */
export interface OrthancResourceRef {
  id: string;
  type: 'Patient' | 'Study' | 'Series' | 'Instance';
}

export type OrthancResourceKind = 'patients' | 'studies' | 'series' | 'instances';

export interface OrthancPeerInfo extends ImagingPeer {
  /** Peer URL when Orthanc reports one (DicomPeers config). */
  url?: string;
}

/** Typed error: HTTP status + a body excerpt surface the Orthanc failure. */
export class OrthancError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'OrthancError';
  }
}

const RESOURCE_TYPE: Record<OrthancResourceKind, OrthancResourceRef['type']> = {
  patients: 'Patient',
  studies: 'Study',
  series: 'Series',
  instances: 'Instance',
};

export class DicomOrthancAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: OrthancAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  // -------------------------------------------------------------------------
  // System + discovery
  // -------------------------------------------------------------------------

  /** GET /system — reachability + version (the adapter's health probe). */
  async ping(): Promise<OrthancSystemInfo> {
    const raw = await this.request<{ Version?: string; Name?: string }>('GET', '/system');
    return { version: raw.Version ?? '', ...(raw.Name ? { name: raw.Name } : {}) };
  }

  /** List every resource id of a kind (GET /patients|/studies|/series|/instances). */
  async list(kind: OrthancResourceKind): Promise<string[]> {
    return this.request<string[]>('GET', `/${kind}`);
  }

  /**
   * Configured DICOM modalities (GET /modalities — a name→config map, or a
   * list on newer Orthanc). Modality health surfaces via echoModality (C4).
   */
  async listModalities(): Promise<string[]> {
    const raw = await this.request<Record<string, unknown> | string[]>('GET', '/modalities');
    return Array.isArray(raw) ? raw : Object.keys(raw);
  }

  /** Configured Orthanc peers (GET /peers) — PACS forwarding targets (C3). */
  async listPeers(): Promise<OrthancPeerInfo[]> {
    const raw = await this.request<Record<string, { Url?: string }> | string[]>('GET', '/peers');
    if (Array.isArray(raw)) return raw.map((name) => ({ name }));
    return Object.entries(raw).map(([name, cfg]) => ({ name, ...(cfg?.Url ? { url: cfg.Url } : {}) }));
  }

  // -------------------------------------------------------------------------
  // Canonical metadata reads (mapped from Orthanc MainDicomTags)
  // -------------------------------------------------------------------------

  async getPatient(orthancId: string): Promise<ImagingPatient> {
    const raw = await this.request<OrthancPatient>('GET', `/patients/${orthancId}`);
    return {
      orthancId: raw.ID,
      patientId: raw.MainDicomTags?.PatientID ?? '',
      ...(raw.MainDicomTags?.PatientName ? { name: raw.MainDicomTags.PatientName } : {}),
      ...(raw.MainDicomTags?.PatientBirthDate ? { birthDate: raw.MainDicomTags.PatientBirthDate } : {}),
      ...(raw.MainDicomTags?.PatientSex ? { sex: raw.MainDicomTags.PatientSex } : {}),
      studies: raw.Studies ?? [],
    };
  }

  async getStudy(orthancId: string): Promise<ImagingStudy> {
    const raw = await this.request<OrthancStudy>('GET', `/studies/${orthancId}`);
    const tags = raw.MainDicomTags ?? {};
    return {
      orthancId: raw.ID,
      patientOrthancId: raw.ParentPatient ?? '',
      ...(tags.AccessionNumber ? { accessionNumber: tags.AccessionNumber } : {}),
      ...(tags.StudyInstanceUID ? { studyInstanceUid: tags.StudyInstanceUID } : {}),
      ...(tags.StudyDate ? { studyDate: tags.StudyDate } : {}),
      ...(tags.StudyDescription ? { studyDescription: tags.StudyDescription } : {}),
      ...(tags.StudyID ? { studyId: tags.StudyID } : {}),
      ...(raw.PatientMainDicomTags?.PatientID || raw.PatientMainDicomTags?.PatientName
        ? {
            patient: {
              ...(raw.PatientMainDicomTags.PatientID ? { patientId: raw.PatientMainDicomTags.PatientID } : {}),
              ...(raw.PatientMainDicomTags.PatientName ? { name: raw.PatientMainDicomTags.PatientName } : {}),
            },
          }
        : {}),
      series: raw.Series ?? [],
      storageUrl: `${this.baseUrl}/studies/${orthancId}/archive`,
    };
  }

  async getSeries(orthancId: string): Promise<ImagingSeries> {
    const raw = await this.request<OrthancSeries>('GET', `/series/${orthancId}`);
    const tags = raw.MainDicomTags ?? {};
    return {
      orthancId: raw.ID,
      studyOrthancId: raw.ParentStudy ?? '',
      ...(tags.Modality ? { modality: tags.Modality } : {}),
      ...(tags.SeriesInstanceUID ? { seriesInstanceUid: tags.SeriesInstanceUID } : {}),
      ...(tags.SeriesDescription ? { description: tags.SeriesDescription } : {}),
      ...(tags.ProtocolName ? { protocolName: tags.ProtocolName } : {}),
      instances: raw.Instances ?? [],
      ...(raw.ExpectedNumberOfInstances !== undefined ? { expectedInstances: raw.ExpectedNumberOfInstances } : {}),
      storageUrl: `${this.baseUrl}/series/${orthancId}/archive`,
    };
  }

  async getInstance(orthancId: string): Promise<ImagingInstance> {
    const raw = await this.request<OrthancInstance>('GET', `/instances/${orthancId}`);
    const tags = raw.MainDicomTags ?? {};
    return {
      orthancId: raw.ID,
      seriesOrthancId: raw.ParentSeries ?? '',
      ...(tags.SOPInstanceUID ? { sopInstanceUid: tags.SOPInstanceUID } : {}),
      ...(typeof raw.FileSize === 'number' ? { fileSize: raw.FileSize } : {}),
      fileUrl: `${this.baseUrl}/instances/${orthancId}/file`,
    };
  }

  /**
   * Study-level find (POST /tools/find): DICOM keys are lowercase long names
   * (e.g. { PatientID: 'PID-1001', Modality: 'CT' }) — same shape the C-FIND
   * worklist/query uses. Returns expanded canonical study metadata.
   */
  async findStudies(query: Record<string, string>): Promise<ImagingStudy[]> {
    const expanded = await this.request<OrthancStudy[]>('POST', '/tools/find', {
      Level: 'Study',
      Query: query,
      Expand: true,
    });
    return expanded.map((raw) => {
      const tags = raw.MainDicomTags ?? {};
      return {
        orthancId: raw.ID,
        patientOrthancId: raw.ParentPatient ?? '',
        ...(tags.AccessionNumber ? { accessionNumber: tags.AccessionNumber } : {}),
        ...(tags.StudyInstanceUID ? { studyInstanceUid: tags.StudyInstanceUID } : {}),
        ...(tags.StudyDate ? { studyDate: tags.StudyDate } : {}),
        ...(tags.StudyDescription ? { studyDescription: tags.StudyDescription } : {}),
        series: raw.Series ?? [],
        storageUrl: `${this.baseUrl}/studies/${raw.ID}/archive`,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Synthetic creation + runtime config (C1 — MWL-ready resources, no modality
  // required: the hub can create patients/studies for worklists from JSON)
  // -------------------------------------------------------------------------

  /**
   * Create a DICOM instance from JSON tags (POST /tools/create-dicom). The
   * parent patient/study/series materialize with it — the C1 primitive for
   * building worklist-ready resources without a real modality. Keys are DICOM
   * keyword long names (PatientName, PatientID, AccessionNumber, …).
   */
  async createDicom(tags: Record<string, string | number>): Promise<{ instanceId: string; patientOrthancId?: string; studyOrthancId?: string }> {
    const raw = await this.request<{ ID: string; ParentPatient?: string; ParentStudy?: string }>('POST', '/tools/create-dicom', tags);
    return {
      instanceId: raw.ID,
      ...(raw.ParentPatient ? { patientOrthancId: raw.ParentPatient } : {}),
      ...(raw.ParentStudy ? { studyOrthancId: raw.ParentStudy } : {}),
    };
  }

  /**
   * Register/replace a DICOM modality at runtime (PUT /modalities/{name}) —
   * lets the demo/installer wire a PACS or a self-echo target without an
   * Orthanc config file edit (C3/C5).
   */
  async configureModality(name: string, cfg: { aet: string; host: string; port: number }): Promise<void> {
    await this.request('PUT', `/modalities/${encodeURIComponent(name)}`, { AET: cfg.aet, Host: cfg.host, Port: cfg.port });
  }

  // -------------------------------------------------------------------------
  // Modality worklist (M3.2 / plan §7.C2) — the Orthanc **Worklists plugin**
  // REST API (github.com/orthanc-server/orthanc-worklists; the folder-based
  // legacy sample plugin has no REST). A modality pulls these items via DICOM
  // C-FIND MWL; the hub creates them from RIS orders and deletes them once
  // the study is performed.
  // -------------------------------------------------------------------------

  /**
   * Create a worklist item (POST /worklists/create). `tags` are DICOM keyword
   * long names exactly as the plugin stores them — top-level patient/order
   * tags plus ScheduledProcedureStepSequence[] for the scheduled step.
   */
  async createWorklistItem(tags: Record<string, unknown>): Promise<{ id: string }> {
    const raw = await this.request<{ ID?: string; Path?: string }>('POST', '/worklists/create', { Tags: tags });
    if (!raw.ID) throw new OrthancError('Orthanc worklist create answered without an ID', 200);
    return { id: raw.ID };
  }

  /** List worklist item ids (GET /worklists/?format=Short — tolerant of shape). */
  async listWorklistIds(): Promise<string[]> {
    const raw = await this.request<unknown>('GET', '/worklists/?format=Short');
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => (typeof entry === 'string' ? entry : (entry as { ID?: string }).ID ?? '')).filter((id) => id.length > 0);
  }

  /** Raw worklist item content (GET /worklists/{id}) — Tags nested or flat. */
  async getWorklistItem(id: string): Promise<{ Tags?: Record<string, unknown> } & Record<string, unknown>> {
    return this.request('GET', `/worklists/${encodeURIComponent(id)}`);
  }

  /** Delete a worklist item (DELETE /worklists/{id}) — performed studies leave. */
  async deleteWorklistItem(id: string): Promise<void> {
    await this.request('DELETE', `/worklists/${encodeURIComponent(id)}`);
  }

  // -------------------------------------------------------------------------
  // Forwarding + lifecycle (C3 storage routing primitives)
  // -------------------------------------------------------------------------

  /** DICOM C-ECHO to a modality — the modality-health probe (C4). */
  async echoModality(name: string): Promise<void> {
    await this.request('POST', `/modalities/${encodeURIComponent(name)}/echo`);
  }

  /** Forward resources to a configured DICOM modality (C-STORE SCU via Orthanc). */
  async storeToModality(modality: string, resources: OrthancResourceRef[]): Promise<void> {
    await this.request('POST', `/modalities/${encodeURIComponent(modality)}/store`, { Resources: resources });
  }

  /** Forward resources to a configured Orthanc peer (HTTP peering to PACS). */
  async storeToPeer(peer: string, resources: OrthancResourceRef[]): Promise<void> {
    await this.request('POST', `/peers/${encodeURIComponent(peer)}/store`, { Resources: resources });
  }

  /** Delete a resource by kind + Orthanc id (DELETE /{kind}/{id}). */
  async delete(kind: OrthancResourceKind, orthancId: string): Promise<void> {
    await this.request('DELETE', `/${kind}/${orthancId}`);
  }

  // -------------------------------------------------------------------------
  // HTTP core
  // -------------------------------------------------------------------------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (this.opts.username) {
      headers.Authorization = `Basic ${Buffer.from(`${this.opts.username}:${this.opts.password ?? ''}`).toString('base64')}`;
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new OrthancError(`Orthanc request ${method} ${path} failed: ${reason}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OrthancError(`Orthanc ${method} ${path} answered ${res.status}`, res.status, text.slice(0, 300));
    }
    if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
    return (await res.json()) as T;
  }
}

// ---------------------------------------------------------------------------
// Raw Orthanc resource shapes (the JSON the REST API actually returns)
// ---------------------------------------------------------------------------

interface OrthancPatient {
  ID: string;
  MainDicomTags?: { PatientID?: string; PatientName?: string; PatientBirthDate?: string; PatientSex?: string };
  Studies?: string[];
}

interface OrthancStudy {
  ID: string;
  ParentPatient?: string;
  MainDicomTags?: {
    AccessionNumber?: string;
    StudyDate?: string;
    StudyDescription?: string;
    StudyID?: string;
    StudyInstanceUID?: string;
  };
  PatientMainDicomTags?: { PatientID?: string; PatientName?: string };
  Series?: string[];
}

interface OrthancSeries {
  ID: string;
  ParentStudy?: string;
  MainDicomTags?: {
    Modality?: string;
    SeriesDescription?: string;
    SeriesInstanceUID?: string;
    ProtocolName?: string;
  };
  Instances?: string[];
  ExpectedNumberOfInstances?: number;
}

interface OrthancInstance {
  ID: string;
  ParentSeries?: string;
  FileSize?: number;
  MainDicomTags?: { SOPInstanceUID?: string };
}