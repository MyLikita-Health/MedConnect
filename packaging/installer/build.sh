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

# 5. Compile (skipped with --stage)
if [ "${1:-}" = "--stage" ]; then
  echo "[w2.5] staged only — run makensis to compile:"
  echo "  makensis /DVERSION=$VERSION /DSTAGE=build\\\\stage hub.nsi"
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
makensis /DVERSION="$VERSION" /DSTAGE="build\\stage" hub.nsi
echo "[w2.5] done → build/IntegrationHub-$VERSION-setup.exe"
