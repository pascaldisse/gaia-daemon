#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

SDKROOT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)}"
SDK_FLAGS=()
if [[ -n "${SDKROOT}" ]]; then
  SDK_FLAGS=(-isysroot "$SDKROOT")
fi

COMMON=(clang -fobjc-arc -Wall -Wextra -Wpedantic -Wno-objc-method-access -Wno-deprecated-declarations "${SDK_FLAGS[@]}")
FRAMEWORKS=(-framework AppKit -framework QuartzCore -framework Foundation)

"${COMMON[@]}" renderer.m -o renderer "${FRAMEWORKS[@]}"
"${COMMON[@]}" host.m -o host "${FRAMEWORKS[@]}"

echo "Built ./renderer and ./host"
echo "Run: ./renderer [/tmp/calayer-poc-context-id.txt]"
echo "Then: ./host [/tmp/calayer-poc-context-id.txt]"
