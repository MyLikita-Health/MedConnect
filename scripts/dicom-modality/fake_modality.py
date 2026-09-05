#!/usr/bin/env python3
"""
M3 exit drill — fake DICOM modality (workstream K).

A pynetdicom AE that stands in for a real imaging modality in the drill:

  serve     --ae FAKE-CT --port 11112
              Run the modality's DICOM listener (answers C-ECHO so Orthanc's
              ModalityMonitor can probe it; also answers C-STORE from Orthanc
              when --accept-store is passed). Background process.

  find-mwl  --orthanc 127.0.0.1 --port 4242 --orthanc-ae ORTHANC --ae FAKE-CT
              C-FIND the Orthanc worklist (Modality Worklist Information Model
              - FIND); print the matched items (accession / patient / modality).

  store     --orthanc 127.0.0.1 --port 4242 --orthanc-ae ORTHANC --ae FAKE-CT
              --accession ACC-X --patient-id PID-1 --patient-name "Doe^John"
              --modality CT [--description "..."] [--refuse]
              C-STORE a synthetic CT study into Orthanc (the "performed
              study"). With --refuse the C-STORE fails (modality-side storage
              failure) and nothing lands — the worklist item stays.

Failure injection: killing the `serve` process (or pointing the modality at an
unreachable host) makes Orthanc's C-ECHO fail -> the hub's ModalityMonitor
flips the modality's device row to disconnected + fires device-offline.

Run inside the project venv:  .venv/bin/python scripts/dicom-modality/fake_modality.py ...
"""
import argparse
import sys
import time

from pydicom.dataset import Dataset
from pydicom.uid import generate_uid, ExplicitVRLittleEndian, ImplicitVRLittleEndian
from pynetdicom import AE, StoragePresentationContexts
from pynetdicom.sop_class import (
    ModalityWorklistInformationFind,
    CTImageStorage,
    Verification,
)

ORTHANC_AE = "ORTHANC"
TRANSFER_SYNTAXES = [ExplicitVRLittleEndian, ImplicitVRLittleEndian]


def serve(args: argparse.Namespace) -> int:
    ae = AE(ae_title=args.ae)
    ae.add_supported_context(Verification)
    if args.accept_store:
        ae.add_supported_context(CTImageStorage, TRANSFER_SYNTAXES)
    print(f"[modality] listening on {args.host}:{args.port} (AET {args.ae}, "
          f"accept-store={args.accept_store})", flush=True)
    ae.start_server((args.host, args.port), block=True)
    return 0


def _connect(args: argparse.Namespace, sop_classes):
    from pynetdicom.presentation import PresentationContext
    ae = AE(ae_title=args.ae)
    ctxs = []
    for sop in sop_classes:
        pc = PresentationContext()
        pc.abstract_syntax = sop
        pc.transfer_syntax = [ExplicitVRLittleEndian, ImplicitVRLittleEndian]
        ctxs.append(pc)
    ae.requested_contexts = ctxs
    assoc = ae.associate(args.orthanc, args.port, ae_title=args.orthanc_ae)
    if not assoc.is_established:
        raise RuntimeError("association to Orthanc failed")
    return ae, assoc


def find_mwl(args: argparse.Namespace) -> int:
    ae, assoc = _connect(args, [ModalityWorklistInformationFind])
    # Modality Worklist Information Model - FIND: the query dataset is a
    # mixture of matching keys (filled) and return keys (empty). No
    # QueryRetrieveLevel (the worklist model has none).
    query = Dataset()
    # Empty values are RETURN keys (ask Orthanc for the value), matching what
    # real modalities send; a literal "*" would require the tag to EXIST on
    # the worklist item, which silently excludes items Orthanc created without
    # that tag (e.g. a hub item whose patient name never reached the registry).
    query.PatientName = args.patient_name or ""
    query.PatientID = args.patient_id or ""
    query.AccessionNumber = args.accession or ""
    query.Modality = args.modality or ""
    query.ScheduledProcedureStepStartDate = args.start_date or ""
    query.ScheduledProcedureStepSequence = [Dataset()]
    query.ScheduledProcedureStepSequence[0].Modality = args.modality or ""
    query.ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartDate = args.start_date or ""
    responses = assoc.send_c_find(query, ModalityWorklistInformationFind)
    found = []
    for status, ds in responses:
        if status and status.Status in (0xFF00, 0xFF01):  # Pending
            found.append(_item_summary(ds))
        elif status and status.Status in (0x0000, 0x0101, 0x0102, 0x0103, 0x0104, 0x0105, 0x0106, 0xA700, 0xA900, 0xC000, 0xFE00):
            break
    assoc.release()
    print(f"[modality] C-FIND worklist: {len(found)} item(s)", flush=True)
    for f in found:
        print(f"[modality]   {f}", flush=True)
    if args.expect and len(found) == 0:
        print("[modality] EXPECTED_ITEM_MISSING", flush=True)
        return 2
    return 0


def _item_summary(ds: Dataset) -> str:
    seq = getattr(ds, "ScheduledProcedureStepSequence", None)
    modality = ""
    if seq and len(seq):
        modality = str(getattr(seq[0], "Modality", "") or "")
    return (f"accession={getattr(ds, 'AccessionNumber', '') or ''} "
            f"patient={getattr(ds, 'PatientName', '') or ''} "
            f"patientId={getattr(ds, 'PatientID', '') or ''} "
            f"modality={modality}")


def store(args: argparse.Namespace) -> int:
    ae, assoc = _connect(args, [CTImageStorage])
    ds = Dataset()
    ds.PatientName = args.patient_name
    ds.PatientID = args.patient_id
    ds.AccessionNumber = args.accession
    ds.StudyDescription = args.description or "CT CHEST - M3 exit drill (performed)"
    ds.Modality = args.modality
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = generate_uid()
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.StudyID = args.accession
    ds.SeriesNumber = 1
    ds.InstanceNumber = 1
    ds.PixelData = b"\x00\x00" * 32  # tiny 4x4x2 dummy pixel slab
    ds.Rows = 4
    ds.Columns = 4
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    from pydicom.uid import ExplicitVRLittleEndian as _evrle
    from pydicom.dataset import FileMetaDataset
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = CTImageStorage
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta.TransferSyntaxUID = _evrle
    ds.file_meta.ImplementationClassUID = generate_uid()
    # send_c_store(ds) returns a single status Dataset carrying (0000,0900)
    # Status (empty Dataset on timeout/abort); the abstract syntax comes from
    # ds.SOPClassUID (set above).
    status = assoc.send_c_store(ds)
    assoc.release()
    code = getattr(status, "Status", None)
    ok = not args.refuse and code is not None and int(code) in (0x0000, 0xFF00)
    if not ok:
        print(f"[modality] C-STORE FAILED (refuse={args.refuse} status={code})", flush=True)
        return 2
    print(f"[modality] C-STORE OK — study {ds.StudyInstanceUID} stored "
          f"(accession {args.accession})", flush=True)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="M3 exit drill fake modality")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp):
        sp.add_argument("--ae", default="FAKE-CT", help="our AET")
        sp.add_argument("--orthanc", default="127.0.0.1")
        sp.add_argument("--port", type=int, default=4242)
        sp.add_argument("--orthanc-ae", default=ORTHANC_AE)

    s = sub.add_parser("serve")
    s.add_argument("--ae", default="FAKE-CT")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=11112)
    s.add_argument("--accept-store", action="store_true")
    s.set_defaults(fn=serve)

    s = sub.add_parser("find-mwl")
    add_common(s)
    s.add_argument("--accession")
    s.add_argument("--patient-id")
    s.add_argument("--patient-name")
    s.add_argument("--modality")
    s.add_argument("--start-date")
    s.add_argument("--expect", action="store_true")
    s.set_defaults(fn=find_mwl)

    s = sub.add_parser("store")
    add_common(s)
    s.add_argument("--accession", required=True)
    s.add_argument("--patient-id", required=True)
    s.add_argument("--patient-name", required=True)
    s.add_argument("--modality", default="CT")
    s.add_argument("--description")
    s.add_argument("--refuse", action="store_true")
    s.set_defaults(fn=store)

    args = p.parse_args()
    try:
        return args.fn(args)
    except Exception as err:  # noqa: BLE001 — CLI
        print(f"[modality] ERROR: {err}", flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())