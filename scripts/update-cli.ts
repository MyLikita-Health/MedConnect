#!/usr/bin/env tsx
/**
 * `hub-update` — operator tooling for signed hub releases (plan G3, M2
 * installer + remote update).
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
 * A minimal unsigned manifest to sign:
 *   { "schemaVersion": 1,
 *     "release": { "id": "v0.2.0", "version": "0.2.0", "platform": "any",
 *                  "minHubVersion": "0.1.0",
 *                  "payload": { "env": { "HUB_VERSION": "0.2.0" } } },
 *     "artifact": { "kind": "payload" } }
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { generateUpdateKeyPair, signManifest, updateManifestSchema, verifyManifestSignature } from '@integration-hub/core';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', short: 'd', default: 'keys' },
    key: { type: 'string', short: 'k' },
    'key-id': { type: 'string', default: 'update-key' },
    pub: { type: 'string', short: 'p' },
    out: { type: 'string', short: 'o' },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
});

const subcommand = positionals[0];

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
    default:
      throw new Error(
        `unknown subcommand ${subcommand ?? '(none)'} — expected keygen | sign | verify (see the header comment for usage)`,
      );
  }
}

main().catch((err) => {
  console.error(`hub-update: ${(err as Error).message}`);
  process.exit(1);
});
