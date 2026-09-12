/**
 * W5 — release/signing invariants (docs/windows-desktop-installer.md §8.5
 * exit proof). Static checks on the packaging sources in the installer-test
 * style (no Windows, no makensis, no secrets required) plus a LIVE round-trip
 * of the `update-cli release` manifest builder through the real core
 * signature path (keygen → build → sign → verify) — the release workflow and
 * the CLI share this builder, so the test exercises what ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateUpdateKeyPair, signManifest, verifyManifestSignature } from '@integration-hub/core';
import { buildReleaseManifest } from '../../scripts/update-cli.ts';

const packagingDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const signSh = readFileSync(join(packagingDir, 'installer', 'sign.sh'), 'utf8');
const buildSh = readFileSync(join(packagingDir, 'installer', 'build.sh'), 'utf8');
const releaseYml = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
const drillYml = readFileSync(join(repoRoot, '.github', 'workflows', 'smoke-drill.yml'), 'utf8');
const updateCli = readFileSync(join(repoRoot, 'scripts', 'update-cli.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 1. The sign wrapper (env-driven, D13-pluggable)
// ---------------------------------------------------------------------------

test('sign.sh: env-driven with a mandatory RFC-3161 timestamp and a loud unsigned no-op', () => {
  // The wrapper is the single signing implementation (used by build.sh AND CI).
  assert.match(signSh, /SIGN_COMMAND/, 'reads the signing command from the environment');
  assert.match(signSh, /SIGN_FILES/, 'reads the file list from the environment');
  // Timestamping is mandatory: refuses a command without an RFC-3161 flag.
  assert.match(signSh, /RFC-3161 timestamp flag/, 'enforces the timestamp requirement');
  assert.match(signSh, /-tr\*|\/tr |\*-ts/, 'checks the concrete -tr //tr //-ts flags');
  // Unsigned builds stay green — loud warning + exit 0, never a silent skip.
  assert.match(signSh, /WARNING: SIGN_COMMAND is not set/, 'loud unsigned warning');
  assert.match(signSh, /exit 0/, 'unsigned no-op exits 0');
  // A requested-but-failed signature fails the build (verify pass + non-zero).
  assert.match(signSh, /signtool verify \/pa/, 'verifies with signtool when available');
  assert.match(signSh, /osslsigncode verify/, 'verifies with osslsigncode on POSIX');
  assert.match(signSh, /exit 1/, 'failures exit non-zero');
  // Timestamp default authority is configured.
  assert.match(signSh, /timestamp\.digicert\.com/, 'default TSA');
});

test('build.sh signs after makensis (or skips loudly); package.json exposes installer:sign', () => {
  assert.match(buildSh, /sign\.sh/, 'build.sh invokes the signing wrapper after compile');
  assert.match(buildSh, /SKIP_SIGN/, 'an explicit escape hatch exists');
  assert.equal(pkg.scripts['installer:sign'], 'bash packaging/installer/sign.sh');
});

// ---------------------------------------------------------------------------
// 2. The release workflow (tag → compile → sign → checksums → manifest → release)
// ---------------------------------------------------------------------------

test('release workflow: tag trigger, both variants, windows signing, checksums, manifest, GitHub Release', () => {
  assert.match(releaseYml, /tags:\s*\n\s+- 'v\*'/, 'triggered by v* tags');
  assert.match(releaseYml, /workflow_dispatch/, 'manual dispatch for hotfixes');
  assert.match(releaseYml, /-DORTHANC/, 'compiles the imaging-bundle variant');
  assert.match(releaseYml, /windows-latest/, 'signing runs where signtool exists');
  assert.match(releaseYml, /sign\.sh/, 'signing goes through the same wrapper');
  assert.match(releaseYml, /SIGN_COMMAND_TEMPLATE/, 'the signing command is repo configuration (D13)');
  assert.match(releaseYml, /sha256sum.*SHA256SUMS\.txt/, 'publishes checksums');
  assert.match(releaseYml, /update-cli\.ts" release/, 'generates the update manifest');
  assert.match(releaseYml, /UPDATE_SIGNING_KEY/, 'manifest signing key comes from secrets');
  assert.match(releaseYml, /gh release create/, 'publishes a GitHub Release');
  assert.match(releaseYml, /UNSIGNED publish/, 'unsigned publishes are documented in the release body');
});

test('release workflow: the smoke drill is the required post-publish gate', () => {
  // The drill must run as a reusable-workflow CALL (needs: publish makes the
  // ordering real and a drill failure fails the release run) — a bare dispatch
  // cannot gate anything.
  const gate = releaseYml.match(/  smoke-drill:\n[\s\S]*$/);
  assert.ok(gate, 'a smoke-drill job exists in the release workflow');
  assert.match(gate[0], /needs: publish/, 'it runs after the release is published');
  assert.match(gate[0], /uses: \.\/\.github\/workflows\/smoke-drill\.yml/, 'it calls the drill as a reusable workflow');
  assert.match(gate[0], /secrets: inherit/, 'repo secrets are available to the drill');
  // The drill must consume the PUBLISHED tag — checkout of a sha without the
  // tag cannot resolve `gh release download <tag>`.
  assert.match(gate[0], /tag: v\$\{\{ needs\.publish\.outputs\.version \}\}/, 'it drills the published tag via the publish job output');
  assert.match(releaseYml, /version: \$\{\{ steps\.ver\.outputs\.version \}\}/, 'the publish job exposes the version as an output');
  // And the drill itself must accept the call.
  assert.match(drillYml, /workflow_call:/, 'smoke-drill.yml is callable');
});

// ---------------------------------------------------------------------------
// 3. The update-cli release subcommand (manifest from release inputs)
// ---------------------------------------------------------------------------

test('update-cli release: builder produces a schema-valid manifest carrying url + sha256', () => {
  const m = buildReleaseManifest({
    version: '0.2.0',
    url: 'https://github.com/acme/integration-hub/releases/download/v0.2.0/IntegrationHub-0.2.0-setup.exe',
    sha256: 'A'.repeat(64).toLowerCase(),
    size: 12345,
    minHubVersion: '0.1.0',
  });
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.release.id, 'v0.2.0');
  assert.equal(m.release.version, '0.2.0');
  assert.equal(m.release.minHubVersion, '0.1.0');
  assert.equal(m.artifact.kind, 'payload');
  assert.equal(m.artifact.sha256, 'a'.repeat(64));
  assert.equal(m.artifact.size, 12345);
  assert.match(m.artifact.url!, /^https:\/\//, 'points at the release asset');
  assert.equal(m.signature, undefined, 'builder output is unsigned until signManifest runs');
});

test('update-cli release: a generated manifest round-trips the REAL signature path', () => {
  // keygen → build → sign → verify: exactly what release.yml and an edge's
  // update agent do — the manifest is consumed by verify unchanged.
  const { privateKeyPem, publicKeyPem } = generateUpdateKeyPair();
  const manifest = buildReleaseManifest({
    version: '0.2.1',
    url: 'https://example.com/IntegrationHub-0.2.1-setup.exe',
    sha256: 'b'.repeat(64),
  });
  const signed = signManifest(manifest, privateKeyPem, 'release-key');
  assert.equal(signed.signature!.keyId, 'release-key');
  // No throw = valid; a tampered artifact must fail.
  verifyManifestSignature(signed, publicKeyPem);
  const tampered = { ...signed, artifact: { ...signed.artifact, sha256: 'c'.repeat(64) } };
  assert.throws(() => verifyManifestSignature(tampered, publicKeyPem), /signature|invalid|verification/i);
});

test('update-cli keeps the keygen/sign/verify subcommands the W4 docs promise', () => {
  for (const cmd of ['keygen', 'sign', 'verify', 'release']) {
    assert.match(updateCli, new RegExp(`case '${cmd}'`), `subcommand ${cmd} exists`);
  }
});
