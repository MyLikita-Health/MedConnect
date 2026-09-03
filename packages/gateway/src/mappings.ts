/**
 * Default device test-code -> canonical test-code mappings (PRD §17–18).
 * Canonical home is @integration-hub/shared so the API/DB layer can seed and
 * serve the same table; re-exported here for gateway callers.
 */
export { DEFAULT_MAPPINGS } from '@integration-hub/shared';
export type { MappingTable } from '@integration-hub/shared';