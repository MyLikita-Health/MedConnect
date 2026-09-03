import type { MappingTable } from '@integration-hub/shared';

/**
 * Default device test-code -> canonical test-code mappings (PRD §17–18).
 * Analyzer codes vary by vendor (GLU / GLUC / GLUCOSE); the pipeline maps
 * them into a single canonical space before routing. Replace/extend per
 * facility via configuration in a real deployment.
 */
export const DEFAULT_MAPPINGS: MappingTable = {
  GLU: 'GLUCOSE',
  GLUC: 'GLUCOSE',
  GLUCOSE: 'GLUCOSE',
  CREA: 'CREATININE',
  CREAT: 'CREATININE',
  UREA: 'UREA',
  BUN: 'UREA',
  ALT: 'ALT',
  AST: 'AST',
  GGT: 'GGT',
  ALP: 'ALKALINE_PHOSPHATASE',
  WBC: 'WBC',
  RBC: 'RBC',
  HGB: 'HEMOGLOBIN',
  HCT: 'HEMATOCRIT',
  PLT: 'PLATELET_COUNT',
  NEUT: 'NEUTROPHILS',
  LYMPH: 'LYMPHOCYTES',
  NA: 'SODIUM',
  K: 'POTASSIUM',
  CL: 'CHLORIDE',
  CA: 'CALCIUM',
};