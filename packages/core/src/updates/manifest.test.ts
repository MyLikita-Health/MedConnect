import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeManifest,
  compareSemver,
  generateUpdateKeyPair,
  isNewerVersion,
  signManifest,
  updateManifestSchema,
  verifyManifestSignature,
  type UpdateManifest,
} from './manifest.js';

function baseManifest(): UpdateManifest {
  // Parse through the schema so zod defaults (publishedAt et al.) are applied
  // the same way sign/verify see them.
  return updateManifestSchema.parse({
    schemaVersion: 1,
    release: {
      id: 'v0.2.0',
      version: '0.2.0',
      platform: 'any',
      minHubVersion: '0.1.0',
      payload: { env: { HUB_VERSION: '0.2.0' } },
    },
    artifact: { kind: 'payload' },
  });
}

test('semver compare handles core, prerelease and ordering rules', () => {
  assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
  assert.equal(compareSemver('0.2.0', '0.1.0'), 1);
  assert.equal(compareSemver('0.1.10', '0.1.9'), 1);
  assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
  // No prerelease > any prerelease of the same core.
  assert.equal(compareSemver('0.2.0', '0.2.0-rc.1'), 1);
  assert.equal(compareSemver('0.2.0-rc.2', '0.2.0-rc.1'), 1);
  // Numeric identifiers < alphanumeric ones.
  assert.equal(compareSemver('0.2.0-1', '0.2.0-alpha'), -1);
  assert.equal(isNewerVersion('0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.0', '0.2.0'), false);
  assert.throws(() => compareSemver('banana', '0.1.0'), /not a semver/);
});

test('canonical JSON is stable and excludes the signature', () => {
  const m = baseManifest();
  const a = canonicalizeManifest(m).toString('utf8');
  const b = canonicalizeManifest({ ...m, release: { ...m.release, changelog: 'added' } }).toString('utf8');
  // Key order never matters for equality.
  const shuffled = canonicalizeManifest(JSON.parse(b)).toString('utf8');
  assert.equal(shuffled, b);
  assert.notEqual(a, b);
  const signed = signManifest(m, generateUpdateKeyPair().privateKeyPem);
  // Signing adds `signature` at the top level only — the covered bytes change
  // only when content changes, never when re-signing.
  assert.equal(canonicalizeManifest(signed).toString('utf8'), canonicalizeManifest(m).toString('utf8'));
});

test('sign/verify round-trips and rejects tampering', () => {
  const { privateKeyPem, publicKeyPem } = generateUpdateKeyPair();
  const signed = signManifest(baseManifest(), privateKeyPem, 'facility-key');
  assert.equal(signed.signature?.algorithm, 'ed25519');
  assert.equal(signed.signature?.keyId, 'facility-key');
  assert.ok(signed.signature!.value.length > 100);
  assert.doesNotThrow(() => verifyManifestSignature(signed, publicKeyPem));

  // Tampering with the version breaks the signature.
  const tampered = {
    ...signed,
    release: { ...signed.release, version: '0.3.0' },
    signature: signed.signature,
  } as UpdateManifest;
  assert.throws(() => verifyManifestSignature(tampered, publicKeyPem), /bad signature/);

  // Unsigned manifests never verify.
  assert.throws(() => verifyManifestSignature(baseManifest(), publicKeyPem), /not signed/);

  // A different key does not verify.
  const other = generateUpdateKeyPair();
  assert.throws(() => verifyManifestSignature(signed, other.publicKeyPem), /bad signature/);
});

test('schema rejects malformed manifests (bad semver, unknown kind, no signature value)', () => {
  const bad = { ...baseManifest(), release: { ...baseManifest().release, version: 'two' } };
  assert.throws(() => updateManifestSchema.parse(bad));
  const badKind = { ...baseManifest(), artifact: { kind: 'floppy' } };
  assert.throws(() => updateManifestSchema.parse(badKind));
  const sig = { ...baseManifest(), signature: { algorithm: 'ed25519', keyId: 'x', value: 'zz-not-hex' } };
  assert.throws(() => updateManifestSchema.parse(sig));
});

test('generateUpdateKeyPair returns PEM keys that can actually sign', () => {
  const { privateKeyPem, publicKeyPem } = generateUpdateKeyPair();
  assert.match(privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.match(publicKeyPem, /BEGIN PUBLIC KEY/);
  const signed = signManifest(baseManifest(), privateKeyPem);
  assert.doesNotThrow(() => verifyManifestSignature(signed, publicKeyPem));
});
