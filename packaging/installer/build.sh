#!/usr/bin/env bash
# Integration Hub — Windows installer build (W2.5).
#
#   ./build.sh            stage + compile (requires makensis for the compile)
#   ./build.sh --stage    stage only (no makensis needed; useful on CI)
#
# Stages build/stage/ from a checkout, then runs `makensis /DVERSION=… hub.nsi`
# producing build/IntegrationHub-<version>-setup.exe. Downloads (node.exe,
# WinSW) land in build/dl/ and are cached — see packaging/README.md.
#
# The payload mirrors the Dockerfile's runtime shape: the hub runs from source
# via tsx, so the payload is node.exe + the workspace sources + a production
# npm ci WITH tsx retained (it is the runtime loader, not a dev-only tool).
# No compilation of better-sqlite3 is needed for Windows: the npm tarball
# ships prebuilds/win32-x64.node (all platforms in one package).
set -euo pipefail

cd "$(dirname "$0")"
STAGE="build/stage"
DL="build/dl"
APP="$STAGE/payload/app"
NODE_VERSION="22.22.0"          # matches .nvmrc / Dockerfile node:22-alpine
NODE_DIST_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip"
WINSW_VERSION="2.12.0"
WINSW_URL="https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW-x64.exe"
# W3 Orthanc bundle (§8.3): official Windows build + the prebuilt Worklists
# plugin (MWL) from the same download server. AGPL boundary (§3.2/§7.5.5):
# Orthanc is an ADJACENT, SEPARATE process (its own service, config, data dir)
# the hub drives over REST — never embedded or linked into hub code.
ORTHANC_VERSION="1.12.6"
ORTHANC_DL="https://orthanc.uclouvain.be/downloads/windows-64/orthanc/${ORTHANC_VERSION}/Orthanc.exe"
ORTHANC_MWL_DLL="https://orthanc.uclouvain.be/downloads/windows-64/orthanc/${ORTHANC_VERSION}/ModalityWorklists.dll"

VERSION="$(node -p "require('../../package.json').version")"
mkdir -p "$DL"

echo "[w2.5] staging payload → $STAGE (version $VERSION)"

# 1. node.exe (win-x64 zip → payload/node.exe)
if [ ! -f "$STAGE/payload/node.exe" ]; then
  if [ ! -f "$DL/node-win.zip" ]; then
    echo "[w2.5] downloading node v$NODE_VERSION (win-x64)"
    curl -fL --retry 3 -o "$DL/node-win.zip" "$NODE_DIST_URL"
  fi
  mkdir -p "$STAGE/payload"
  unzip -oq "$DL/node-win.zip" -d "$STAGE/nodedist"
  cp "$STAGE"/nodedist/node-v*-win-x64/node.exe "$STAGE/payload/node.exe"
  rm -rf "$STAGE/nodedist"
else
  echo "[w2.5] node.exe already staged"
fi

# 2. WinSW shim (→ payload/WinSW-x64.exe; the NSIS script renames it to
#    IntegrationHub.exe at install time)
if [ ! -f "$STAGE/payload/WinSW-x64.exe" ]; then
  if [ ! -f "$DL/WinSW-x64.exe" ]; then
    echo "[w2.5] downloading WinSW v$WINSW_VERSION"
    curl -fL --retry 3 -o "$DL/WinSW-x64.exe" "$WINSW_URL"
  fi
  mkdir -p "$STAGE/payload"
  cp "$DL/WinSW-x64.exe" "$STAGE/payload/WinSW-x64.exe"
fi

# 3. Workspace sources (what Docker COPY . . carries, minus junk the image
#    also does not need; keep .env out — the service definition carries the
#    env contract, and a dev .env must never ship inside an installer).
rm -rf "$APP"
mkdir -p "$APP"
cp -R ../../package.json ../../package-lock.json ../../tsconfig.base.json ../../tsconfig.json ../../.nvmrc "$APP/"
cp -R ../../packages "$APP/packages"
cp -R ../../goldens "$APP/goldens"
cp -R ../../scripts "$APP/scripts"
find "$APP" \( -name '*.test.ts' -o -name node_modules -o -name .DS_Store -o -name '*.tsbuildinfo' \) -type f -prune -exec rm -rf {} +
find "$APP" \( -name node_modules -o -name .DS_Store -o -name '*.tsbuildinfo' \) -type d -prune -exec rm -rf {} +
mkdir -p "$APP/docs"
cp ../../docs/user-manual.md ../../docs/analyzer-certification-runbook.md "$APP/docs/" 2>/dev/null || true

# 4. Production node_modules (dev deps dropped EXCEPT tsx — the runtime
#    loader; --omit=dev would strip it and break the service entry). No
#    native compile step is needed: better-sqlite3 v13 ships
#    prebuilds/win32-x64.node inside the npm tarball and its loader resolves
#    it directly, so --ignore-scripts is safe.
echo "[w2.5] installing production node_modules (keeping tsx)…"
( cd "$APP" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund )
( cd "$APP" && npm install --no-save --ignore-scripts --no-audit --no-fund tsx@^4.19.0 )
echo "[w2.5] staged: node.exe, WinSW, app/ ($(du -sh "$APP" | cut -f1))"

# 4b. W3 Orthanc bundle (--orthanc): official Orthanc.exe + the prebuilt
#     ModalityWorklists.dll staged BESIDE the hub payload (payload/orthanc/).
#     The NSIS script registers it as its own Windows service — separate
#     process, separate data dir, REST-only contact with the hub (AGPL §3.2).
#     Flag order is free: --orthanc can come before or after --stage.
if [ "$*" = "${*/--orthanc/}" ]; then :; else
  echo "[w3]  staging Orthanc ${ORTHANC_VERSION} (Windows build, adjacent service)…"
  if [ ! -f "$STAGE/payload/orthanc/Orthanc.exe" ]; then
    if [ ! -f "$DL/Orthanc-$ORTHANC_VERSION.exe" ]; then
      curl -fL --retry 3 -o "$DL/Orthanc-$ORTHANC_VERSION.exe" "$ORTHANC_DL"
    fi
    if [ ! -f "$DL/ModalityWorklists-$ORTHANC_VERSION.dll" ]; then
      curl -fL --retry 3 -o "$DL/ModalityWorklists-$ORTHANC_VERSION.dll" "$ORTHANC_MWL_DLL"
    fi
    mkdir -p "$STAGE/payload/orthanc"
    cp "$DL/Orthanc-$ORTHANC_VERSION.exe" "$STAGE/payload/orthanc/Orthanc.exe"
    cp "$DL/ModalityWorklists-$ORTHANC_VERSION.dll" "$STAGE/payload/orthanc/ModalityWorklists.dll"
  fi
  echo "[w3]  staged: orthanc/Orthanc.exe + ModalityWorklists.dll"
fi

# 5. Compile (skipped with --stage)
if [ "$*" != "${*/--stage/}" ]; then
  echo "[w2.5] staged only — run makensis to compile:"
  echo "  makensis -DVERSION=$VERSION -DSTAGE='build\\stage' hub.nsi"
  echo "  (add --orthanc to bundle the W3 Orthanc imaging service)"
  exit 0
fi

command -v makensis >/dev/null 2>&1 || {
  echo "[w2.5] ERROR: makensis not found." >&2
  echo "  macOS:   brew install makensis" >&2
  echo "  Windows: install NSIS (nsis.sourceforge.io)" >&2
  echo "  Linux:   apt install nsis / the NSIS site build" >&2
  exit 1
}
echo "[w2.5] compiling installer…"
# POSIX-style -D flags: accepted by Windows makensis too, and REQUIRED by
# POSIX builds (they reject /D — it parses as a script filename).
makensis -V2 -DVERSION="$VERSION" -DSTAGE='build\stage' hub.nsi
echo "[w2.5] done → build/IntegrationHub-$VERSION-setup.exe"
