/**
 * Single source of truth for the hub's release identity (plan §4.3, G3).
 *
 * `HUB_VERSION` defaults to the scaffold version (kept in sync with the root
 * package.json). The supervisor overrides it per installed release via env —
 * a release payload is a version + env bundle here (see packages/core
 * updates); production artifacts swap the image/checkout instead, and the
 * version the process reports comes from the same env mechanism.
 */
export const HUB_VERSION = process.env.HUB_VERSION ?? '0.1.0';

/** process.platform (node); release manifests can target a platform. */
export const HUB_PLATFORM: string = process.platform;

export interface HubVersionInfo {
  version: string;
  platform: string;
  node: string;
}

export function hubVersionInfo(): HubVersionInfo {
  return {
    version: HUB_VERSION,
    platform: HUB_PLATFORM,
    node: process.version,
  };
}
