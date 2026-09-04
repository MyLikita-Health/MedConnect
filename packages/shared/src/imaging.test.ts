/**
 * Imaging shape sanity (M3.1): the canonical shapes compile + serialize —
 * metadata only (no pixel fields ever enter the canonical model).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ImagingStudy } from './imaging.js';

test('an ImagingStudy carries metadata + a storage URL, never pixels', () => {
  const study: ImagingStudy = {
    orthancId: '9ad2b0da-a406c43c-6e0df76d-1204b86f-78d12c15',
    patientOrthancId: '07a6ec1c-1be5920b-18ef5358-d24441f3-10e926ea',
    accessionNumber: 'ACC-424242',
    studyInstanceUid: '1.2.840.113704.1.111.7016.1342451220.40',
    studyDescription: 'CT CHEST',
    series: [],
    storageUrl: 'http://orthanc:8042/studies/9ad2b0da/archive',
  };
  const json = JSON.parse(JSON.stringify(study)) as ImagingStudy;
  assert.equal(json.accessionNumber, 'ACC-424242');
  assert.equal(json.storageUrl, 'http://orthanc:8042/studies/9ad2b0da/archive');
  assert.ok(Array.isArray(json.series));
  // The canonical shape has no pixel/payload field by construction.
  assert.ok(!('pixels' in json));
});