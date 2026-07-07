#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

SDKROOT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)}"
SDK_FLAGS=()
if [[ -n "${SDKROOT}" ]]; then
  SDK_FLAGS=(-isysroot "$SDKROOT")
fi

COMMON=(clang -fobjc-arc -Wall -Wextra -Wpedantic -Wno-objc-method-access -Wno-deprecated-declarations "${SDK_FLAGS[@]}")
FRAMEWORKS=(-framework AppKit -framework QuartzCore -framework Foundation -framework CoreGraphics)

"${COMMON[@]}" installed_embed.m -o installed_embed "${FRAMEWORKS[@]}"
echo "Built ./installed_embed"
echo "Run: ./installed_embed [--auto-exit-seconds 20]"
