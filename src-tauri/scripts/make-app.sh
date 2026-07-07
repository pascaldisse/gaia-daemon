#!/usr/bin/env bash
# Hand-assemble GAIA.app from a compiled gaia-shell binary.
#
# A macOS .app is just a directory with a known layout, so we do not need the
# Tauri CLI to produce a double-clickable app. Usage:
#   scripts/make-app.sh [release|debug]   (default: release)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"   # -> src-tauri/
PROFILE="${1:-release}"
BIN="$HERE/target/$PROFILE/gaia-shell"
APP="${GAIA_APP_OUT:-$HERE/target/GAIA.app}"
ENTITLEMENTS="$HERE/Entitlements.plist"

if [ ! -x "$BIN" ]; then
  echo "missing binary: $BIN"
  echo "build it first:  cargo build --$PROFILE"
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/gaia-shell"
cp "$HERE/bundle/macos/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/icons/icon.icns" "$APP/Contents/Resources/icon.icns"

# Ad-hoc sign with microphone entitlement so hardened-runtime/WebKit media capture can open audio input.
if [ -f "$ENTITLEMENTS" ]; then
  codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" "$APP" >/dev/null 2>&1 && echo "(ad-hoc signed with entitlements)" || echo "(codesign skipped)"
else
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 && echo "(ad-hoc signed)" || echo "(codesign skipped)"
fi

echo "built: $APP  (from $PROFILE binary)"
