#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

LLAMA_SERVER="${LLAMA_SERVER:-/opt/homebrew/bin/llama-server}"
LLAMA_HOST="${LLAMA_HOST:-127.0.0.1}"
LLAMA_PORT="${LLAMA_PORT:-8080}"
KYUTAI_LLM_MODEL="${KYUTAI_LLM_MODEL:-gemma-3-1b-it}"
CONTEXT_SIZE="${CONTEXT_SIZE:-2048}"
GPU_LAYERS="${GPU_LAYERS:-all}"
MODEL_PATH="${MODEL_PATH:-}"
HF_MODEL="${HF_MODEL:-gguf-org/gemma-3-1b-it-gguf:Q4_K_M}"
export LLAMA_CACHE="${LLAMA_CACHE:-$PWD/models/llama.cpp}"

if [ ! -x "$LLAMA_SERVER" ]; then
  echo "llama-server not found or not executable: $LLAMA_SERVER" >&2
  exit 1
fi

if [ -n "$MODEL_PATH" ] && [ ! -f "$MODEL_PATH" ]; then
  echo "Model file not found: $MODEL_PATH" >&2
  exit 1
fi

if command -v curl >/dev/null 2>&1 && curl -fsS "http://${LLAMA_HOST}:${LLAMA_PORT}/v1/models" >/dev/null 2>&1; then
  echo "llama-server is already responding at http://${LLAMA_HOST}:${LLAMA_PORT}"
  exit 0
fi

args=(
  --alias "$KYUTAI_LLM_MODEL"
  --ctx-size "$CONTEXT_SIZE"
  --host "$LLAMA_HOST"
  --port "$LLAMA_PORT"
  --no-ui
  --gpu-layers "$GPU_LAYERS"
)

if [ -n "$MODEL_PATH" ]; then
  args+=(--model "$MODEL_PATH")
else
  args+=(-hf "$HF_MODEL")
fi

exec "$LLAMA_SERVER" "${args[@]}"
