#!/usr/bin/env bash
# Starts the unmute voice stack (STT, TTS, backend) with GAIA as the LLM.
# GAIA's web server exposes an OpenAI-compatible /v1/chat/completions shim,
# so unmute's "brain" is whatever GAIA agent you call from the web UI.
#
#   UNMUTE_DIR=...   path to the unmute checkout (macOS port)
#   GAIA_URL=...     where the GAIA web server runs
#   VOICE_LOG_DIR=.. where service logs go
set -euo pipefail

UNMUTE_DIR="${UNMUTE_DIR:-/Users/pascaldisse/projects/Codex/AIWaifu/unmute}"
GAIA_URL="${GAIA_URL:-http://127.0.0.1:8787}"
VOICE_LOG_DIR="${VOICE_LOG_DIR:-/tmp/gaia-voice}"

if [ ! -d "$UNMUTE_DIR/macos" ]; then
  echo "unmute checkout not found at $UNMUTE_DIR (set UNMUTE_DIR)" >&2
  exit 1
fi

mkdir -p "$VOICE_LOG_DIR"
pids=()

start_service() {
  local name="$1"
  shift
  echo "starting $name (log: $VOICE_LOG_DIR/$name.log)"
  "$@" >"$VOICE_LOG_DIR/$name.log" 2>&1 &
  pids+=("$!")
}

cleanup() {
  echo
  echo "stopping voice stack..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

start_service stt "$UNMUTE_DIR/macos/start_stt_metal.sh"
start_service tts "$UNMUTE_DIR/macos/start_tts_mlx.sh"

# The backend is what GAIA's browser client connects to (ws://.../v1/realtime).
# KYUTAI_LLM_URL points it at GAIA; KYUTAI_LLM_MODEL matches GAIA's /v1/models.
start_service backend env KYUTAI_LLM_URL="$GAIA_URL" KYUTAI_LLM_MODEL="gaia" "$UNMUTE_DIR/macos/start_backend.sh"

echo
echo "voice stack running:"
echo "  STT     ws://localhost:8090"
echo "  TTS     ws://localhost:8089"
echo "  backend ws://localhost:8000  (LLM -> $GAIA_URL)"
echo
echo "Make sure GAIA is running at $GAIA_URL, then click the call button next"
echo "to an agent in the GAIA web UI. Ctrl-C stops all three services."
wait
