/**
 * W2.5 — installer build invariants (docs/windows-desktop-installer.md
 * §W2.5 exit proof): the NSIS script, the WinSW service definition, the
 * build script and the firewall rule stay mutually consistent with the
 * service-cli contract. These are static checks on the packaging sources —
 * no Windows or makensis required (the full compile is `npm run
 * installer:build` on a host with makensis; see packaging/README.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagingDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const nsi = readFileSync(join(packagingDir, 'installer', 'hub.nsi'), 'utf8');
const buildSh = readFileSync(join(packagingDir, 'installer', 'build.sh'), 'utf8');
const serviceTpl = readFileSync(join(packagingDir, 'installer', 'service.xml.tpl'), 'utf8');
const serviceCli = readFileSync(join(repoRoot, 'scripts', 'service-cli.ts'), 'utf8');
const serviceDoc = readFileSync(join(repoRoot, 'docs', 'windows-service.md'), 'utf8');

test('hub.nsi installs the staged payload: node.exe, WinSW shim, app/ workspace', () => {
  assert.match(nsi, /File "\/oname=node\.exe" "\$\{STAGE\}\\payload\\node\.exe"/, 'node.exe from the staged payload');
  assert.match(nsi, /File "\/oname=IntegrationHub\.exe" "\$\{STAGE\}\\payload\\WinSW-x64\.exe"/, 'WinSW shim becomes IntegrationHub.exe');
  assert.match(nsi, /File \/r "\$\{STAGE\}\\payload\\app\\\*\.\*"/, 'the app/ workspace payload');
  // The service definition is written by the installer (ports picked at
  // install time) — it must contain the same env contract as the template.
  for (const env of ['NODE_ENV', 'HUB_DATA_DIR', 'PORT', 'DEVICE_PORT', 'HUB_LOCAL_SETUP']) {
    assert.match(nsi, new RegExp(`<env name="${env}"`), `service XML env: ${env}`);
  }
  assert.match(nsi, /--import tsx %BASE%\\\\app\\\\packages\\\\server\\\\src\\\\service-cli\.ts/, 'the service runs the W2 service entry via tsx');
});

test('service definition: automatic start + restart-on-failure (supervisor stays single)', () => {
  assert.match(nsi, /<startmode>Automatic<\/startmode>/);
  assert.match(nsi, /<onfailure action="restart"/, 'restart on failure');
  // The W2 responsibility split: WinSW serves the SCM protocol, supervision
  // semantics stay in HubSupervisor — the shim's child IS the supervisor.
  assert.match(nsi, /service-cli\.ts/);
  assert.match(serviceTpl, /startmode:|<startmode>/);
});

test('firewall rule: device listener port, private profile, never public', () => {
  assert.match(nsi, /netsh advfirewall firewall add rule name="Integration Hub device listener"/);
  assert.match(nsi, /localport=\$DevicePort/, 'the rule targets the picked device port');
  assert.match(nsi, /profile=private/, 'conservative LAN default');
  assert.doesNotMatch(nsi, /profile=public/, 'never the public profile');
  assert.match(nsi, /netsh advfirewall firewall delete rule name="Integration Hub device listener"/, 'uninstall removes the rule');
});

test('uninstall order: service stopped FIRST, then payload, data dir prompt last', () => {
  const unSection = nsi.slice(nsi.indexOf('Section "Uninstall"'));
  const stopIdx = unSection.indexOf('"$INSTDIR\\IntegrationHub.exe" stop');
  const uninstallIdx = unSection.indexOf('"$INSTDIR\\IntegrationHub.exe" uninstall');
  const rmdirIdx = unSection.search(/RMDir \/r "\$INSTDIR\\app"/);
  const dataIdx = unSection.indexOf('$COMMONPROGRAMDATA\\IntegrationHub');
  assert.ok(stopIdx >= 0, 'stop runs');
  assert.ok(uninstallIdx > stopIdx, 'unregister after stop');
  assert.ok(rmdirIdx > uninstallIdx, 'payload removal after service teardown');
  assert.ok(dataIdx > rmdirIdx, 'the data-dir decision comes last');
  assert.match(unSection, /MB_YESNO/, 'the data-dir deletion is a PROMPT, not automatic');
  assert.match(unSection, /RMDir \/r "\$COMMONPROGRAMDATA\\IntegrationHub"/, 'delete only on confirm');
});

test('build.sh stages the same payload the NSIS script embeds', () => {
  assert.match(buildSh, /node\.exe/);
  assert.match(buildSh, /WinSW-x64\.exe/);
  assert.match(buildSh, /packages\/server\/src\/service-cli\.ts|packages/);
  assert.match(buildSh, /npm ci --omit=dev/, 'prod node_modules');
  assert.match(buildSh, /npm install --no-save[^\n]*tsx/, 'tsx retained (the runtime loader)');
  assert.match(buildSh, /prebuilds\/win32-x64\.node|prebuilds/, 'the sqlite win32 prebuild ships in the tarball');
  assert.match(buildSh, /makensis \/DVERSION/, 'compiles with the version define');
});

test('service-cli Windows template matches the WinSW mechanism (no bare sc.exe)', () => {
  assert.match(serviceCli, /IntegrationHub\.yaml/, 'WinSW YAML definition');
  assert.match(serviceCli, /winsw/i, 'WinSW shim wiring');
  assert.doesNotMatch(serviceCli, /sc\.exe create/, 'the broken bare sc.exe create is gone');
  assert.match(serviceDoc, /WinSW/, 'docs describe the WinSW mechanism');
  assert.match(serviceDoc, /1053/, 'docs explain why sc.exe alone fails');
});

test('package.json wires installer:build / installer:stage', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['installer:build'], 'bash packaging/installer/build.sh');
  assert.equal(pkg.scripts['installer:stage'], 'bash packaging/installer/build.sh --stage');
});
