/**
 * Signed update manifests (plan G3 "signed update packages", §4.3 remote
 * updates; M2 "installer + remote update" gate item).
 *
 * A manifest describes one installable release. Integrity comes from two
 * layers: the manifest itself is signed with Ed25519 by the vendor's update
 * key, and file-backed artifacts carry a sha256. The hub verifies the
 * signature against a configured public key before it will even consider an
 * update; nothing is fetched/applied on trust.
 *
 * Release payload: this scaffold's artifact kind is `payload` — the release
 * is a version + env bundle the supervisor hands the hub process (production
 * swaps the image/checkout instead; kinds `tarball`/`docker-image` are
 * reserved for that path). The version a release declares is what the hub
 * reports on /health, so the "applied 0.2.0" assertion is observable.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const updateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  release: z.object({
    id: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    /** Semver of the release, e.g. "0.2.0". */
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    /** Target platform: hub platform or "any". */
    platform: z.string().default('any'),
    /** Earliest hub version this release can install on. */
    minHubVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    /** Optional upper bound (exclusive). */
    maxHubVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
      .optional(),
    publishedAt: z.string().datetime().default(() => new Date().toISOString()),
    changelog: z.string().default(''),
    /** Env bundle applied when the hub runs this release (payload kind). */
    payload: z.object({ env: z.record(z.string(), z.string()) }).optional(),
  }),
  artifact: z.object({
    /** payload = env bundle for this scaffold; tarball/docker-image reserved. */
    kind: z.enum(['payload', 'tarball', 'docker-image']).default('payload'),
    /** sha256 hex of the artifact file (required for file-backed kinds). */
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    size: z.number().int().nonnegative().optional(),
  }),
  signature: z
    .object({
      algorithm: z.literal('ed25519'),
      /** Display name of the key (publicKeyId on the manifest). */
      keyId: z.string(),
      /** hex signature over the canonical manifest (below). */
      value: z.string().regex(/^[0-9a-f]+$/),
    })
    .optional(),
});

export type UpdateManifest = z.infer<typeof updateManifestSchema>;
export type UpdateRelease = UpdateManifest['release'];
export type UpdateArtifact = UpdateManifest['artifact'];

// ---------------------------------------------------------------------------
// Canonical serialization (signature covers exactly these bytes)
// ---------------------------------------------------------------------------

/**
 * Stable JSON: object keys sorted recursively, excluding the top-level
 * `signature` field. Sign and verify must agree byte-for-byte.
 */
export function canonicalizeManifest(manifest: UpdateManifest): Buffer {
  const { signature: _sig, ...body } = manifest;
  return Buffer.from(JSON.stringify(sortKeys(body)), 'utf8');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Keys + signing
// ---------------------------------------------------------------------------

export interface UpdateKeyPair {
  /** PEM (PKCS8) — keep on the signing machine, never ship to hubs. */
  privateKeyPem: string;
  /** PEM (SPKI) — configure on the hub via UPDATE_PUBLIC_KEY. */
  publicKeyPem: string;
}

export function generateUpdateKeyPair(): UpdateKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function keyFromPem(privatePem?: string, publicPem?: string): { privateKey?: KeyObject; publicKey?: KeyObject } {
  return {
    privateKey: privatePem ? createPrivateKey(privatePem) : undefined,
    publicKey: publicPem ? createPublicKey(publicPem) : undefined,
  };
}

export function signManifest(manifest: UpdateManifest, privateKeyPem: string, keyId = 'update-key'): UpdateManifest {
  const { privateKey } = keyFromPem(privateKeyPem);
  if (!privateKey) throw new Error('private key required to sign');
  const canonical = canonicalizeManifest(manifest);
  const sig = edSign(null, canonical, privateKey);
  const signed: UpdateManifest = updateManifestSchema.parse({
    ...manifest,
    signature: { algorithm: 'ed25519', keyId, value: sig.toString('hex') },
  });
  return signed;
}

/** Verifies the embedded signature. Throws with a clear reason when invalid. */
export function verifyManifestSignature(manifest: UpdateManifest, publicKeyPem: string): void {
  if (!manifest.signature) throw new Error('manifest is not signed');
  const { publicKey } = keyFromPem(undefined, publicKeyPem);
  if (!publicKey) throw new Error('public key required to verify');
  const canonical = canonicalizeManifest(manifest);
  const ok = edVerify(null, canonical, publicKey, Buffer.from(manifest.signature.value, 'hex'));
  if (!ok) throw new Error(`bad signature on release ${manifest.release.id} (key ${manifest.signature.keyId})`);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Semver compare (minimal — enough for range policy, no deps)
// ---------------------------------------------------------------------------

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  const [ma, na, oa] = pa.core;
  const [mb, nb, ob] = pb.core;
  if (ma !== mb) return ma < mb ? -1 : 1;
  if (na !== nb) return na < nb ? -1 : 1;
  if (oa !== ob) return oa < ob ? -1 : 1;
  // No prerelease > any prerelease.
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const as = pa.pre.split('.');
  const bs = pb.pre.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const av = as[i];
    const bv = bs[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av !== bv) {
      const an = Number(av);
      const bn = Number(bv);
      const aNum = Number.isInteger(an) && !isNaN(an);
      const bNum = Number.isInteger(bn) && !isNaN(bn);
      if (aNum && bNum) return an < bn ? -1 : 1;
      if (aNum) return -1; // numeric identifiers sort before alpha
      if (bNum) return 1;
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

interface ParsedSemver {
  core: [number, number, number];
  pre?: string;
}

function parseSemver(v: string): ParsedSemver {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) throw new Error(`not a semver: ${v}`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] };
}
