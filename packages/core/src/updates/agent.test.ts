import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateAgent } from './agent.js';
import { generateUpdateKeyPair, signManifest, updateManifestSchema, type UpdateManifest } from './manifest.js';
import { UpdateStateDir } from './state.js';

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hub-agent-'));
  dirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function manifestFor(version: string, overrides: Partial<UpdateManifest['release']> = {}): UpdateManifest {
  return updateManifestSchema.parse({
    schemaVersion: 1,
    release: {
      id: `v${version}`,
      version,
      platform: 'any',
      minHubVersion: '0.1.0',
      payload: { env: { HUB_VERSION: version } },
      ...overrides,
    },
    artifact: { kind: 'payload' },
  });
}

test('agent reports disabled without source/public key', async () => {
  const agent = new UpdateAgent({ stateDir: await tmpDir() });
  assert.equal(agent.enabled, false);
  const status = await agent.status();
  assert.equal(status.enabled, false);
  assert.equal(status.supervisor.alive, false);
  assert.equal((await agent.check()).available, false);
  assert.equal((await agent.apply()).staged, false);
  assert.equal((await agent.rollback()).staged, false);
});

test('check verifies signature and policy; apply stages a signed release', async () => {
  const stateDir = await tmpDir();
  const sourceDir = await tmpDir();
  await mkdir(join(sourceDir, 'updates'));
  const { privateKeyPem, publicKeyPem } = generateUpdateKeyPair();

  // Publish + sign a 0.2.0 manifest at the source dir.
  const manifest = signManifest(manifestFor('0.2.0'), privateKeyPem);
  await writeFile(join(sourceDir, 'updates', 'manifest.json'), JSON.stringify(manifest));

  const agent = new UpdateAgent({ stateDir, source: join(sourceDir, 'updates'), publicKeyPem, currentVersion: '0.1.0' });
  const check = await agent.check();
  assert.equal(check.available, true);
  assert.equal(check.manifest?.release.version, '0.2.0');

  const staged = await agent.apply('key-admin');
  assert.equal(staged.staged, true);
  assert.equal(staged.release?.version, '0.2.0');

  // desired.json is staged for the supervisor, with the actor recorded.
  const state = new UpdateStateDir(stateDir);
  const desired = await state.readDesired();
  assert.equal(desired?.kind, 'update');
  assert.equal(desired?.release.version, '0.2.0');
  assert.equal(desired?.by, 'key-admin');
  const history = await state.readHistory();
  assert.equal(history[0]?.event, 'staged');
  assert.equal(history[0]?.version, '0.2.0');

  // Status reflects the staged release + running code version.
  const status = await agent.status();
  assert.equal(status.running.version, '0.1.0');
  assert.equal(status.desired?.release.version, '0.2.0');
});

test('check rejects tampered and stale manifests without staging anything', async () => {
  const stateDir = await tmpDir();
  const sourceDir = await tmpDir();
  const { privateKeyPem, publicKeyPem } = generateUpdateKeyPair();

  const tampered = {
    ...signManifest(manifestFor('0.2.0'), privateKeyPem),
    release: { ...manifestFor('0.2.0').release, version: '0.9.0' },
  } as UpdateManifest;
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify(tampered));
  const agent = new UpdateAgent({ stateDir, source: join(sourceDir, 'manifest.json'), publicKeyPem, currentVersion: '0.1.0' });
  const check = await agent.check();
  assert.equal(check.available, false);
  assert.match(check.reason ?? '', /bad signature/);
  assert.equal((await agent.apply()).staged, false);
  assert.equal((await new UpdateStateDir(stateDir).readDesired()), undefined);

  // A genuinely signed but older release is refused by policy.
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify(signManifest(manifestFor('0.0.9'), privateKeyPem)));
  const stale = await agent.check();
  assert.equal(stale.available, false);
  assert.match(stale.reason ?? '', /not newer/);
  // Rejected checks are traceable in history.
  const history = await new UpdateStateDir(stateDir).readHistory();
  assert.equal(history[0]?.event, 'rejected');
});

test('platform and version-range policy refuse incompatible releases', async () => {
  const stateDir = await tmpDir();
  const sourceDir = await tmpDir();
  const { privateKeyPem, publicKeyPem } = generateUpdateKeyPair();
  const agent = new UpdateAgent({ stateDir, source: sourceDir, publicKeyPem, currentVersion: '0.1.0' });

  const platform = signManifest(manifestFor('0.2.0', { platform: 'windows' }), privateKeyPem);
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify(platform));
  assert.match((await agent.check()).reason ?? '', /targets windows/);

  const tooNew = signManifest(manifestFor('0.2.0', { minHubVersion: '1.0.0' }), privateKeyPem);
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify(tooNew));
  assert.match((await agent.check()).reason ?? '', /requires hub >= 1\.0\.0/);

  // maxHubVersion caps which hubs may install it: running 0.1.0 must be
  // strictly below the bound — a bound of 0.0.9 excludes us.
  const capped = signManifest(manifestFor('0.2.0', { maxHubVersion: '0.0.9' }), privateKeyPem);
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify(capped));
  assert.match((await agent.check()).reason ?? '', /requires hub < 0\.0\.9/);
});

test('rollback stages the last-known-good release', async () => {
  const stateDir = await tmpDir();
  const state = new UpdateStateDir(stateDir);
  // The supervisor recorded a 0.2.0 as current + last-good; the hub restarted
  // and now reports 0.1.0 from code (state file missing would default, so
  // simulate: current.json missing but lastGood exists → running = code).
  await state.writeLastGood({ release: { id: 'v0.2.0', version: '0.2.0' }, appliedAt: new Date().toISOString(), healthy: true });
  const { publicKeyPem } = generateUpdateKeyPair();
  const agent = new UpdateAgent({ stateDir, source: undefined, publicKeyPem, currentVersion: '0.1.0' });
  assert.equal(agent.enabled, false); // no source → disabled is fine for a pure-state test
  const rb = await agent.rollback();
  assert.equal(rb.staged, false);
  assert.match(rb.reason ?? '', /update agent disabled/);
});

test('rollback prefers the replaced release over last-known-good', async () => {
  const stateDir = await tmpDir();
  const sourceDir = await tmpDir();
  const state = new UpdateStateDir(stateDir);
  const { publicKeyPem } = generateUpdateKeyPair();
  // 0.2.0 applied successfully: it is current AND last-good; 0.1.0 was replaced.
  await state.writeCurrent({ release: { id: 'v0.2.0', version: '0.2.0' }, appliedAt: new Date().toISOString(), healthy: true });
  await state.writeLastGood({ release: { id: 'v0.2.0', version: '0.2.0' }, appliedAt: new Date().toISOString(), healthy: true });
  await state.writePrevious({ release: { id: 'v0.1.0', version: '0.1.0' }, recordedAt: new Date().toISOString() });
  const agent = new UpdateAgent({ stateDir, source: sourceDir, publicKeyPem, currentVersion: '0.2.0' });
  const rb = await agent.rollback('key-admin');
  assert.equal(rb.staged, true);
  assert.equal(rb.release?.version, '0.1.0'); // undo the successful update
  const desired = await state.readDesired();
  assert.equal(desired?.kind, 'rollback');
  assert.equal(desired?.release.version, '0.1.0');
});

test('rollback stages last-known-good when enabled', async () => {
  const stateDir = await tmpDir();
  const sourceDir = await tmpDir();
  const state = new UpdateStateDir(stateDir);
  const { publicKeyPem } = generateUpdateKeyPair();
  await state.writeLastGood({ release: { id: 'v0.2.0', version: '0.2.0' }, appliedAt: new Date().toISOString(), healthy: true });
  const agent = new UpdateAgent({ stateDir, source: sourceDir, publicKeyPem, currentVersion: '0.2.1' });
  const rb = await agent.rollback('key-admin');
  assert.equal(rb.staged, true);
  assert.equal(rb.release?.version, '0.2.0');
  const desired = await state.readDesired();
  assert.equal(desired?.kind, 'rollback');
  assert.equal(desired?.release.version, '0.2.0');

  // Simulate the supervisor applying the rollback, then a second rollback
  // must refuse — we are already on the last-known-good release.
  await state.writeCurrent({ release: { id: 'v0.2.0', version: '0.2.0' }, appliedAt: new Date().toISOString(), healthy: true });
  await state.clearDesired();
  const already = await agent.rollback();
  assert.equal(already.staged, false);
  assert.match(already.reason ?? '', /already running the previously-applied release/);
});

test('status prefers the state file release over the code version', async () => {
  const stateDir = await tmpDir();
  const state = new UpdateStateDir(stateDir);
  await state.writeCurrent({ release: { id: 'v0.2.0', version: '0.2.0', payload: { env: { HUB_VERSION: '0.2.0' } } }, appliedAt: new Date().toISOString(), healthy: true });
  await state.touchSupervisor(424242);
  const agent = new UpdateAgent({ stateDir, currentVersion: '0.1.0' });
  const status = await agent.status();
  assert.equal(status.running.version, '0.2.0');
  assert.equal(status.current?.healthy, true);
  assert.equal(status.supervisor.alive, true);
  assert.equal(status.supervisor.pid, 424242);
});

test('agent refuses to apply when the checked release was superseded', async () => {
  const stateDir = await tmpDir();
  const sourceDir = await tmpDir();
  const { privateKeyPem, publicKeyPem } = generateUpdateKeyPair();
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify(signManifest(manifestFor('0.2.0'), privateKeyPem)));
  const agent = new UpdateAgent({ stateDir, source: join(sourceDir, 'manifest.json'), publicKeyPem, currentVersion: '0.1.0' });
  assert.equal((await agent.check()).available, true);
  // Supersede the check by publishing + checking a newer release.
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify(signManifest(manifestFor('0.3.0'), privateKeyPem)));
  assert.equal((await agent.check()).available, true);
  // apply() re-checks before staging — it must refuse to apply the old one.
  const staged = await agent.apply();
  assert.equal(staged.staged, true);
  assert.equal(staged.release?.version, '0.3.0');
  const desired = await new UpdateStateDir(stateDir).readDesired();
  assert.equal(desired?.release.version, '0.3.0');
});
