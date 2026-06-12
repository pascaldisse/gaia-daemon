#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export UV_CACHE_DIR="${UV_CACHE_DIR:-$PWD/.uv-cache}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$PWD/.uv-python}"
export TTS_STUB_HOST="${TTS_STUB_HOST:-127.0.0.1}"
export TTS_STUB_PORT="${TTS_STUB_PORT:-8089}"

exec uv run --python 3.12 uvicorn unmute.tts_stub_server:app \
  --host "$TTS_STUB_HOST" \
  --port "$TTS_STUB_PORT"
