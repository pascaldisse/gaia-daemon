#!/usr/bin/env bash
# =============================================================================
# dualbench — side-by-side WebKit (Tauri WKWebView) vs Chromium diffing
# =============================================================================
# Launches the GAIA UI in two native windows so you can spot engine-specific
# rendering divergence immediately:
#
#   LEFT:  macOS WKWebView via the Tauri shell (iOS preview)
#   RIGHT: Chromium via Brave/Chrome --app mode (Windows / Android preview)
#
# The GAIA daemon must already be running on :8787. This script never starts or
# stops the daemon — it only opens windows that attach to it.
# =============================================================================
set -euo pipefail

GAIA_URL="${GAIA_URL:-http://127.0.0.1:8787/}"
TAURI_BIN="/Users/pascaldisse/projects/gaia-daemon-tauri/src-tauri/target/debug/gaia-shell"

# ── pre-flight checks ───────────────────────────────────────────────────────

if ! command -v open &>/dev/null; then
  echo "ERROR: 'open' not found — this script requires macOS." >&2
  exit 1
fi

if [[ ! -x "$TAURI_BIN" ]]; then
  echo "ERROR: Tauri shell binary not found at $TAURI_BIN" >&2
  echo "Build it first: cd /Users/pascaldisse/projects/gaia-daemon-tauri && cargo build" >&2
  exit 1
fi

port="${GAIA_URL##*:}"
port="${port%%/*}"
if ! nc -z -w1 127.0.0.1 "${port:-8787}" 2>/dev/null; then
  echo "WARNING: port ${port:-8787} does not appear to be listening." >&2
  echo "The GAIA daemon may not be running. Start it first (e.g. 'gaia room')." >&2
  echo >&2
fi

# ── pick a Chromium engine ───────────────────────────────────────────────────

CHROMIUM_APP=""
if [[ -d "/Applications/Brave Browser.app" ]]; then
  CHROMIUM_APP="Brave Browser"
elif [[ -d "/Applications/Google Chrome.app" ]]; then
  CHROMIUM_APP="Google Chrome"
else
  echo "ERROR: neither Brave Browser nor Google Chrome found in /Applications." >&2
  exit 1
fi

# ── launch ───────────────────────────────────────────────────────────────────

echo "[dualbench] launching WKWebView (Tauri shell) …"
"$TAURI_BIN" &
TAURI_PID=$!
echo "[dualbench]   Tauri PID: $TAURI_PID"

# Give the native window a moment to appear before opening the second one.
sleep 1

echo "[dualbench] launching Chromium ($CHROMIUM_APP) in --app mode …"
open -na "$CHROMIUM_APP" --args --app="$GAIA_URL"

echo
echo "[dualbench] both engines are up."
echo "[dualbench]   WKWebView (left)  — iOS rendering target"
echo "[dualbench]   Chromium  (right) — Windows / Android rendering target"
echo "[dualbench]"
echo "[dualbench] Arrange the two windows side-by-side and compare."
echo "[dualbench] Kill the Tauri shell with: kill $TAURI_PID"
