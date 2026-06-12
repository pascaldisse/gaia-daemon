#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export UV_CACHE_DIR="${UV_CACHE_DIR:-$PWD/.uv-cache}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$PWD/.uv-python}"
export CXXFLAGS="${CXXFLAGS:--include cstdint}"
export STT_PORT="${STT_PORT:-8090}"
export STT_CONFIG="${STT_CONFIG:-services/moshi-server/configs/stt.toml}"

CLT_FRAMEWORKS="/Library/Developer/CommandLineTools/Library/Frameworks"
if [ -d "$CLT_FRAMEWORKS/Python3.framework" ]; then
  export DYLD_FRAMEWORK_PATH="${DYLD_FRAMEWORK_PATH:-$CLT_FRAMEWORKS}"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to build moshi-server with Metal support." >&2
  exit 1
fi

if ! command -v moshi-server >/dev/null 2>&1; then
  cargo install --features metal moshi-server@0.6.4
fi

exec moshi-server worker --config "$STT_CONFIG" --port "$STT_PORT"
