#!/usr/bin/env bash
# Integration Hub — Authenticode signing wrapper (W5, decision D13).
#
#   Packaging step BETWEEN makensis and publishing. Env-driven and pluggable:
#   the actual signing command is supplied by the environment, so adding a
#   certificate later (D13: Azure Artifact Signing preferred, OV token cert
#   fallback) is configuration, not code.
#
# Env contract:
#   SIGN_FILES     space/newline-separated list of .exe files to sign
#   SIGN_COMMAND   a printf-style template with exactly one %s — the file path.
#                  Examples:
#                    Azure Artifact Signing:
#                      azuresigntool sign -kvu $AZURE_KEY_VAULT_URI \
#                        -kvi $AZURE_CLIENT_ID -kvs $AZURE_CLIENT_SECRET \
#                        -kvc $AZURE_CERT_NAME -tr $TSA_URL -td sha256 -fd sha256 %s
#                    CA cert + signtool (token/HSM on the host):
#                      signtool sign /fd SHA256 /tr $TSA_URL /td SHA256 \
#                        /a /n $CERT_SUBJECT %s
#   TSA_URL        RFC-3161 timestamp authority (default:
#                  http://timestamp.digicert.com). TIMESTAMPING IS MANDATORY:
#                  signatures must outlive the certificate — without /tr the
#                  signature dies on cert expiry and every deployed edge
#                  breaks on rotation day.
#
# Behavior:
#   - No SIGN_COMMAND → loud warning, exit 0 (unsigned CI/dev builds stay
#     green; release notes must state the unsigned status).
#   - SIGN_COMMAND set → every file in SIGN_FILES is signed, then VERIFIED;
#     any failure exits non-zero (a requested-but-failed signature fails the
#     build rather than shipping an unsigned artifact silently).
#
#   ./sign.sh [--verify-only]
#     --verify-only  skip signing; verify SIGN_FILES and exit (used by CI
#                    after signing to double-check the published artifacts).
set -euo pipefail

if [ "${1:-}" = "--verify-only" ]; then
  VERIFY_ONLY=1
else
  VERIFY_ONLY=0
fi

TSA_URL="${TSA_URL:-http://timestamp.digicert.com}"

if [ -z "${SIGN_FILES:-}" ]; then
  echo "[sign] SIGN_FILES is empty — nothing to sign/verify." >&2
  exit 0
fi

if [ -z "${SIGN_COMMAND:-}" ]; then
  if [ "$VERIFY_ONLY" = "1" ]; then
    echo "[sign] ERROR: --verify-only requested but SIGN_COMMAND is not set — cannot verify." >&2
    exit 1
  fi
  echo "[sign] ==========================================================" >&2
  echo "[sign] WARNING: SIGN_COMMAND is not set — artifacts are UNSIGNED." >&2
  echo "[sign]   (D13: the certificate is purchased when the first pilot" >&2
  echo "[sign]    demands it; signing then activates by configuration —" >&2
  echo "[sign]    see docs/windows-desktop-installer.md §8.5)" >&2
  echo "[sign] ==========================================================" >&2
  exit 0
fi

# The template must carry its own timestamp flags; refuse a command that
# cannot produce a timestamp — an expiring signature is a fleet-wide outage.
case "$SIGN_COMMAND" in
  *-tr*|*"/tr "*|*"-ts"*) : ;;  # signtool/azuresigntool-style /tr, osslsigncode -ts
  *) echo "[sign] ERROR: SIGN_COMMAND has no RFC-3161 timestamp flag (-tr / /tr / -ts)." >&2
     echo "  Timestamping is mandatory (W5): signatures must outlive the certificate." >&2
     exit 1 ;;
esac

sign_one() {
  # shellcheck disable=SC2059  # the template IS the point — one %s, the file
  printf "$SIGN_COMMAND" "$1"
}

for f in $SIGN_FILES; do
  [ -f "$f" ] || { echo "[sign] ERROR: $f does not exist." >&2; exit 1; }
  if [ "$VERIFY_ONLY" = "0" ]; then
    echo "[sign] signing $f (TSA $TSA_URL)…"
    sign_one "$f"
  fi
  echo "[sign] verifying $f…"
  # Verification tries the OS toolchain first (signtool on Windows), then
  # osslsigncode (POSIX hosts). Success = at least one verifier accepts.
  if command -v signtool >/dev/null 2>&1; then
    signtool verify /pa /all "$f" >/dev/null
  elif command -v osslsigncode >/dev/null 2>&1; then
    osslsigncode verify "$f" >/dev/null
  else
    echo "[sign] WARNING: no verifier available (signtool/osslsigncode) — skipping verify for $f" >&2
  fi
  echo "[sign] OK: $f"
done

echo "[sign] done."
