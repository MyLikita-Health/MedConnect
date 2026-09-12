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
const serverIndex = readFileSync(join(repoRoot, 'packages', 'server', 'src', 'index.ts'), 'utf8');
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
  assert.match(nsi, /--import tsx "%BASE%\\\\app\\\\packages\\\\server\\\\src\\\\service-cli\.ts/, 'the service runs the W2 service entry via tsx (quoted: Program Files has a space)');
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
  assert.match(buildSh, /makensis -DVERSION/, 'compiles with the POSIX-style version define (Windows makensis accepts it too; POSIX rejects /D)');
});

test('service-cli Windows template matches the WinSW mechanism (no bare sc.exe)', () => {
  assert.match(serviceCli, /IntegrationHub\.yaml/, 'WinSW YAML definition');
  assert.match(serviceCli, /winsw/i, 'WinSW shim wiring');
  assert.doesNotMatch(serviceCli, /sc\.exe create/, 'the broken bare sc.exe create is gone');
  assert.match(serviceDoc, /WinSW/, 'docs describe the WinSW mechanism');
  assert.match(serviceDoc, /1053/, 'docs explain why sc.exe alone fails');
});

test('WinSW <arguments> paths are quoted: %BASE% lives under Program Files (spaces)', () => {
  // The drill caught this live (v0.1.0-rc.2): WinSW tokenizes <arguments> as
  // a Windows command line, so an unquoted path under C:\Program Files\...
  // splits at the space and Node tried to import 'C:\\Program'.
  const argumentsLines = nsi.split('\n').filter((l) => /<arguments>/.test(l));
  assert.ok(argumentsLines.length >= 2, 'both services define their arguments');
  for (const line of argumentsLines) {
    const m = line.match(/<arguments>([\s\S]*?)<\/arguments>/);
    assert.ok(m, 'arguments element parses');
    const content = m[1];
    if (/%BASE%/.test(content)) {
      assert.match(content, /"%BASE%[^\"]*"/, `path with %BASE% must be quoted: ${content}`);
    }
  }
  // The dev-parity template renders the same arguments the installer writes.
  const tplArgs = serviceTpl.match(/<arguments>([\s\S]*?)<\/arguments>/);
  assert.ok(tplArgs, 'template defines its arguments');
  assert.match(tplArgs[1], /"%BASE%[^\"]*"/, 'template quotes the %BASE% path too');
});

test('W3 orthanc bundle: staged beside the payload, own service, AGPL boundary intact', () => {
  // Stage script fetches the official Windows build + the prebuilt MWL plugin.
  assert.match(buildSh, /--orthanc/, 'an explicit opt-in stage');
  assert.match(buildSh, /orthanc\.uclouvain\.be/, 'the official download server');
  assert.match(buildSh, /Orthanc\.exe/);
  assert.match(buildSh, /ModalityWorklists\.dll/, 'the MWL plugin (worklists for MWL sync)');
  // NSIS: the bundle is compiled in via !ifdef and keeps its own identity.
  assert.match(nsi, /!ifdef ORTHANC/, 'compile-time opt-in');
  assert.match(nsi, /integration-hub-orthanc/, 'its OWN service id (adjacent process)');
  assert.match(nsi, /RemoteAccessAllowed.*false|"RemoteAccessAllowed": false/, 'REST stays localhost-only');
  assert.match(nsi, /ORTHANC_URL/, 'the hub service env points at the bundle');
  assert.match(nsi, /Integration Hub DICOM listener/, 'DICOM 4242 firewall rule when bundled');
  assert.match(nsi, /profile=private/, 'private profile only (never public)');
  // The uninstaller tears the orthanc service down BEFORE the payload goes.
  const unSection = nsi.slice(nsi.indexOf('Section "Uninstall"'));
  const orthancStop = unSection.indexOf('OrthancHub.exe" stop');
  const hubStop = unSection.indexOf('IntegrationHub.exe" stop');
  assert.ok(orthancStop >= 0 && orthancStop < hubStop, 'orthanc service stopped first (dependency order)');
  assert.match(unSection, /RMDir \/r "\$INSTDIR\\orthanc"/, 'bundle removed with the payload');
});

test('W4 signed-update delivery: installer injects the agent env, agent consumes it', () => {
  // Compile-time opt-in with both defines (an update channel is USELESS
  // without the pinned signing key — verify-not-trust).
  assert.match(nsi, /!ifdef UPDATES/, 'compile-time opt-in');
  assert.match(nsi, /UPDATE_SOURCE/, 'the manifest source is injected into the service env');
  assert.match(nsi, /UPDATE_PUBLIC_KEY/, 'the pinned Ed25519 key rides the service env');
  // The hub-side consumer (the agent runs inside the supervised service;
  // startHub reads the same env names the installer writes).
  assert.match(serverIndex, /UPDATE_SOURCE/, 'startHub reads the injected env');
  assert.match(serverIndex, /UPDATE_PUBLIC_KEY/, 'startHub reads the pinned key');
  assert.match(serverIndex, /new UpdateAgent/, 'the agent is constructed at boot');
  // The service template documents the optional env block (kept in sync with
  // the NSIS writer, like the W2.5/W3 pairs).
  assert.match(serviceTpl, /W4 update delivery/, 'the template documents the UPDATES block');
});

test('FileWrite output is pure ASCII: NSIS writes ANSI and WinSW XML parsing is strict', () => {
  // The drill caught this live (v0.1.0-rc.1): an em-dash in the service
  // <description> landed as a non-UTF-8 byte through NSIS's ANSI FileWrite,
  // and WinSW died with "Invalid character in the given encoding" before it
  // could register the service. Comments/UI strings are fine (Unicode
  // makensis); only FileWrite-consumed content must stay ASCII.
  const fileWriteLines = nsi.split('\n').filter((l) => /FileWrite \$tmp/.test(l));
  assert.ok(fileWriteLines.length >= 30, 'the installer writes its service/config files inline');
  for (const line of fileWriteLines) {
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[^\x00-\x7F]/.test(line), `non-ASCII in NSIS-written output: ${line.trim()}`);
  }
  // The dev-parity template renders the same XML the installer writes.
  assert.ok(!/[^\x00-\x7F]/.test(serviceTpl), 'service.xml.tpl carries the same ASCII constraint');
});

test('package.json wires installer:build / installer:stage', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['installer:build'], 'bash packaging/installer/build.sh');
  assert.equal(pkg.scripts['installer:stage'], 'bash packaging/installer/build.sh --stage');
});
