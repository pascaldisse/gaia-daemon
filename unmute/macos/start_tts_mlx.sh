#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export UV_CACHE_DIR="${UV_CACHE_DIR:-$PWD/.uv-cache}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$PWD/.uv-python}"
export TTS_MLX_HOST="${TTS_MLX_HOST:-127.0.0.1}"
export TTS_MLX_PORT="${TTS_MLX_PORT:-8089}"
export KYUTAI_TTS_MLX_QUANTIZE="${KYUTAI_TTS_MLX_QUANTIZE:-8}"
export KYUTAI_TTS_MLX_COALESCE_SEC="${KYUTAI_TTS_MLX_COALESCE_SEC:-0.12}"
export KYUTAI_TTS_MLX_MIN_WORDS="${KYUTAI_TTS_MLX_MIN_WORDS:-4}"

# python -m keeps the --with overlay interpreter; the bare `uvicorn` console
# script resolves to the project venv's python, which cannot see moshi-mlx.
exec uv run --python 3.12 \
  --with moshi-mlx==0.2.12 \
  --with huggingface_hub \
  python -m uvicorn unmute.tts_mlx_adapter:app \
  --host "$TTS_MLX_HOST" \
  --port "$TTS_MLX_PORT"
