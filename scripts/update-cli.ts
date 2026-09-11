#!/usr/bin/env tsx
/**
 * `hub-update` — operator tooling for signed hub releases (plan G3, M2
 * installer + remote update; W5 release automation, docs §8.5).
 *
 *   npx tsx scripts/update-cli.ts keygen [--dir keys]
 *       Generates an Ed25519 update keypair: keys/update-key.pem (PRIVATE —
 *       keep on the signing machine) and keys/update-key.pub.pem (SPKI —
 *       configure on every hub via UPDATE_PUBLIC_KEY).
 *
 *   npx tsx scripts/update-cli.ts sign manifest.json --key keys/update-key.pem \
 *       --key-id update-key -o manifest.signed.json
 *       Signs a manifest (writes the canonical JSON + embedded signature).
 *
 *   npx tsx scripts/update-cli.ts verify manifest.signed.json --pub keys/update-key.pub.pem
 *       Verifies a signed manifest; exit 0 only when the signature is valid.
 *
 *   npx tsx scripts/update-cli.ts release --version 0.2.0 --url <exe-url> \
 *       --sha256 <hex> [--size <bytes>] [--min-hub-version 0.1.0] \
 *       [--key keys/update-key.pem] [--key-id update-key] -o manifest.signed.json
 *       W5: builds the release manifest from the release inputs and — when
 *       --key is given — signs it in one step (what release.yml runs). The
 *       generated manifest is a REAL UpdateManifest: verify consumes it
 *       unchanged, and the update agent applies it through UPDATE_SOURCE.
 *
 * Example manifest the release command produces (signed):
 *   { "schemaVersion": 1,
 *     "release": { "id": "v0.2.0", "version": "0.2.0", "platform": "any",
 *                  "minHubVersion": "0.1.0", ... },
 *     "artifact": { "kind": "payload", "url": "https://…/setup.exe",
 *                   "sha256": "<64 hex>", "size": 12345 },
 *     "signature": { "algorithm": "ed25519", ... } }
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  generateUpdateKeyPair,
  signManifest,
  updateManifestSchema,
  verifyManifestSignature,
  type UpdateManifest,
} from '@integration-hub/core';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', short: 'd', default: 'keys' },
    key: { type: 'string', short: 'k' },
    'key-id': { type: 'string', default: 'update-key' },
    pub: { type: 'string', short: 'p' },
    out: { type: 'string', short: 'o' },
    version: { type: 'string' },
    url: { type: 'string' },
    sha256: { type: 'string' },
    size: { type: 'string' },
    'min-hub-version': { type: 'string' },
    'release-id': { type: 'string' },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
});

const subcommand = positionals[0];

/** Build an (unsigned) release manifest from release inputs. Exported for the
 *  W5 invariant tests — the CLI path and the tests exercise the same builder. */
export function buildReleaseManifest(input: {
  version: string;
  url: string;
  sha256: string;
  size?: number;
  minHubVersion?: string;
  releaseId?: string;
  changelog?: string;
}): UpdateManifest {
  const releaseId = input.releaseId ?? `v${input.version}`;
  const manifest = {
    schemaVersion: 1 as const,
    release: {
      id: releaseId,
      version: input.version,
      platform: 'any',
      minHubVersion: input.minHubVersion ?? '0.1.0',
      publishedAt: new Date().toISOString(),
      changelog: input.changelog ?? '',
    },
    artifact: {
      kind: 'payload' as const,
      sha256: input.sha256.toLowerCase(),
      ...(input.size !== undefined ? { size: input.size } : {}),
      url: input.url,
    },
  };
  // Validate at the boundary: a release that generates an invalid manifest
  // must fail HERE, not at some edge's update poll hours later.
  return updateManifestSchema.parse(manifest);
}

async function main(): Promise<void> {
  switch (subcommand) {

    case 'keygen': {
      const keyPair = generateUpdateKeyPair();
      await mkdir(values.dir!, { recursive: true });
      const privPath = join(values.dir!, 'update-key.pem');
      const pubPath = join(values.dir!, 'update-key.pub.pem');
      await writeFile(privPath, keyPair.privateKeyPem);
      await writeFile(pubPath, keyPair.publicKeyPem);
      console.log(`wrote ${privPath}  (PRIVATE — never ship this to hubs)`);
      console.log(`wrote ${pubPath}  (set UPDATE_PUBLIC_KEY to this on every hub)`);
      return;
    }
    case 'sign': {
      const key = values.key;
      if (!key) throw new Error('sign needs --key <private.pem>');
      const manifestPath = positionals[1];
      if (!manifestPath) throw new Error('usage: sign <manifest.json> --key <private.pem>');
      const manifest = updateManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
      const privateKeyPem = await readFile(key, 'utf8');
      const signed = signManifest(manifest, privateKeyPem, values['key-id']!);
      const out = values.out ?? manifestPath.replace(/\.json$/, '.signed.json');
      await writeFile(out, `${JSON.stringify(signed, null, 2)}\n`);
      console.log(`signed ${manifest.release.id} (${manifest.release.version}) → ${out}`);
      return;
    }
    case 'verify': {
      const pub = values.pub;
      if (!pub) throw new Error('verify needs --pub <public.pem>');
      const manifestPath = positionals[1];
      if (!manifestPath) throw new Error('usage: verify <manifest.json> --pub <public.pem>');
      const manifest = updateManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
      const publicKeyPem = await readFile(pub, 'utf8');
      verifyManifestSignature(manifest, publicKeyPem);
      console.log(`OK: signature on ${manifest.release.id} (${manifest.release.version}) is valid`);
      return;
    }
    case 'release': {
      if (!values.version) throw new Error('release needs --version <semver> (e.g. 0.2.0)');
      if (!values.url) throw new Error('release needs --url <installer asset URL>');
      if (!values.sha256) throw new Error('release needs --sha256 <64-hex checksum of the installer>');
      if (!/^[0-9a-fA-F]{64}$/.test(values.sha256)) throw new Error('--sha256 must be 64 hex characters');
      const size = values.size !== undefined ? Number(values.size) : undefined;
      if (size !== undefined && (!Number.isInteger(size) || size < 0)) {
        throw new Error('--size must be a non-negative integer (bytes)');
      }
      const manifest = buildReleaseManifest({
        version: values.version,
        url: values.url,
        sha256: values.sha256,
        size,
        minHubVersion: values['min-hub-version'],
        releaseId: values['release-id'],
      });
      const out = values.out ?? 'manifest.signed.json';
      if (values.key) {
        const privateKeyPem = await readFile(values.key, 'utf8');
        const signed = signManifest(manifest, privateKeyPem, values['key-id']!);
        await writeFile(out, `${JSON.stringify(signed, null, 2)}\n`);
        console.log(`signed release ${manifest.release.id} → ${out}`);
      } else {
        // Unsigned publish: allowed (the agent refuses unsigned manifests via
        // UPDATE_PUBLIC_KEY), but loud — release notes must state it.
        await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`);
        console.log(`WARNING: wrote UNSIGNED manifest ${manifest.release.id} → ${out}`);
        console.log('  an edge with UPDATE_PUBLIC_KEY set will REFUSE this manifest — pass --key to sign.');
      }
      return;
    }
    default:
      throw new Error(
        `unknown subcommand ${subcommand ?? '(none)'} — expected keygen | sign | verify | release (see the header comment for usage)`,
      );
  }
}

// Run only when invoked directly (`npx tsx scripts/update-cli.ts …`); the W5
// release tests import buildReleaseManifest and must not trigger main().
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(pathToFileURL(import.meta.url).fsPath);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`hub-update: ${(err as Error).message}`);
    process.exit(1);
  });
}
