-- 0011_adt_admissions.sql — B2c extension: ADT^A01 patient-admission feed.
-- Additive: admissions the HIS announces via ADT^A01/A04/A08 (the patient
-- side of the LIS seam), keyed by patient id like the order registry.
CREATE TABLE IF NOT EXISTS admission_registry (
  patient_id    text PRIMARY KEY,
  name          text,
  date_of_birth text,
  gender        text,
  visit_id      text,
  status        text NOT NULL DEFAULT 'admitted',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);