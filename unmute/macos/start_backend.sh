#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export UV_CACHE_DIR="${UV_CACHE_DIR:-$PWD/.uv-cache}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$PWD/.uv-python}"
export KYUTAI_STT_URL="${KYUTAI_STT_URL:-ws://localhost:8090}"
export KYUTAI_TTS_URL="${KYUTAI_TTS_URL:-ws://localhost:8089}"
export KYUTAI_LLM_URL="${KYUTAI_LLM_URL:-http://localhost:8080}"
export KYUTAI_LLM_MODEL="${KYUTAI_LLM_MODEL:-gemma-3-1b-it}"
export KYUTAI_BACKEND_HOST="${KYUTAI_BACKEND_HOST:-127.0.0.1}"
export KYUTAI_BACKEND_PORT="${KYUTAI_BACKEND_PORT:-8000}"

exec uv run --python 3.12 uvicorn unmute.main_websocket:app \
  --host "$KYUTAI_BACKEND_HOST" \
  --port "$KYUTAI_BACKEND_PORT" \
  --ws-per-message-deflate=false
