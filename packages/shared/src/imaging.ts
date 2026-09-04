/**
 * Canonical imaging shapes (workstream M3 / plan §6.2 phase 2 — the DICOM
 * side). The platform's invariant holds here too: the integration core never
 * sees DICOM; `@integration-hub/dicom` translates Orthanc REST payloads into
 * these shapes, and downstream machinery (route/DLQ/console) consumes only
 * metadata — **pixels never enter the hub database** (plan §6.2: metadata +
 * storage URLs only; the pixel store is Orthanc/PACS).
 */

/** Imaging modality (DICOM: CT/MR/CR/US/PX… — free string v1). */
export type ImagingModality = string;

/** A study's status in the hub's imaging workflow (plan §6.2). */
export type ImagingStudyStatus = 'received' | 'routed' | 'failed';

/** Canonical patient-level identity as Orthanc reports it. */
export interface ImagingPatient {
  /** Orthanc resource id (the hub's pointer into Orthanc). */
  orthancId: string;
  /** DICOM PatientID (0010,0020). */
  patientId: string;
  /** DICOM PatientName (0010,0010), typically "Family^Given". */
  name?: string;
  /** DICOM PatientBirthDate (0010,0030), YYYYMMDD. */
  birthDate?: string;
  /** DICOM PatientSex (0010,0040): M/F/O. */
  sex?: string;
  /** Orthanc ids of this patient's studies. */
  studies: string[];
}

/**
 * Canonical study metadata (accession-level, the unit the hub routes).
 * `storageUrl` points at Orthanc (raw archive / DICOMweb later) — the hub
 * stores the pointer, never the pixels.
 */
export interface ImagingStudy {
  /** Orthanc resource id. */
  orthancId: string;
  /** Orthanc id of the parent patient. */
  patientOrthancId: string;
  /** DICOM AccessionNumber (0008,0050) — the RIS order link (ImagingRequest.id). */
  accessionNumber?: string;
  /** DICOM StudyInstanceUID (0020,000D). */
  studyInstanceUid?: string;
  /** DICOM StudyDate (0008,0020), YYYYMMDD. */
  studyDate?: string;
  /** DICOM StudyDescription (0008,1030). */
  studyDescription?: string;
  /** DICOM StudyID (0020,0010) — the local study number. */
  studyId?: string;
  /** Patient tags embedded in the study resource (Orthanc PatientMainDicomTags). */
  patient?: { patientId?: string; name?: string };
  /** Orthanc ids of the study's series. */
  series: string[];
  /** DICOM tags for storage URLs (Modality present via series, aggregated here). */
  storageUrl: string;
}

/** Canonical series metadata under a study. */
export interface ImagingSeries {
  /** Orthanc resource id. */
  orthancId: string;
  /** Orthanc id of the parent study. */
  studyOrthancId: string;
  /** DICOM Modality (0008,0060), e.g. CT/MR/CR. */
  modality?: string;
  /** DICOM SeriesInstanceUID (0020,000E). */
  seriesInstanceUid?: string;
  /** DICOM SeriesDescription (0008,103E). */
  description?: string;
  /** DICOM ProtocolName (0018,1030). */
  protocolName?: string;
  /** Orthanc ids of the series' instances. */
  instances: string[];
  /** DICOM instance count when known (ExpectedNumberOfInstances). */
  expectedInstances?: number;
  /** DICOM tags for storage URLs. */
  storageUrl: string;
}

/** Canonical instance metadata (the pixel pointer — file URL at Orthanc). */
export interface ImagingInstance {
  /** Orthanc resource id. */
  orthancId: string;
  /** Orthanc id of the parent series. */
  seriesOrthancId: string;
  /** DICOM SOPInstanceUID (0008,0018). */
  sopInstanceUid?: string;
  /** Stored file size in bytes (DICOM FileSize). */
  fileSize?: number;
  /** Orthanc file download URL (raw DICOM; pixels stay in Orthanc). */
  fileUrl: string;
}

/** An Orthanc DICOM peer/modality configured for forwarding (C3). */
export interface ImagingPeer {
  /** Configuration name (Orthanc /peers or /modalities key). */
  name: string;
}

/** The RIS-side order that becomes a worklist item (plan §6.2 ImagingRequest). */
export interface ImagingRequest {
  /** Accession number — the hub's order id from the RIS (B2c ORM feed). */
  id: string;
  patientId: string;
  /** Requested procedure description (DICOM 0032,1060). */
  requestedProcedure?: string;
  /** Requested modality. */
  modality?: string;
  priority?: string;
  /** Which imaging workflow stage the request has reached. */
  status: 'ordered' | 'in-worklist' | 'performed' | 'cancelled';
  /** ISO timestamp when the RIS order reached the hub. */
  receivedAt: string;
}