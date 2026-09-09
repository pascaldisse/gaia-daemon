#!/bin/bash
set -euo pipefail
root="$HOME/projects/gaia-daemon"
ws="$root/proof/serve-warm/ws"
proof="$root/proof/serve-warm"
room="serve-warm-room"
direct_pid=""
prompt_pid=""
cleanup() {
  [ -n "$direct_pid" ] && kill "$direct_pid" 2>/dev/null || true
  [ -n "$prompt_pid" ] && kill "$prompt_pid" 2>/dev/null || true
  [ -n "$direct_pid" ] && wait "$direct_pid" 2>/dev/null || true
  [ -n "$prompt_pid" ] && wait "$prompt_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
: > "$proof/direct.log"
: > "$proof/direct-server.log"
: > "$proof/prompt-server.log"
post() {
  local port="$1" name="$2" log="$3" body wall
  body="$proof/$name.json"
  wall=$(curl -sS -o "$body" -w '%{time_total}' -X POST "http://127.0.0.1:$port/v1/chat/completions" -H 'content-type: application/json' --data '{"messages":[{"role":"user","content":"hi"}]}')
  printf '%s wall=%s\n' "$name" "$wall" | tee -a "$log"
  cat "$body" >> "$log"; printf '\n' >> "$log"
}
ready() {
  local port="$1"
  for i in $(seq 1 50); do curl -fsS "http://127.0.0.1:$port/v1/models" >/dev/null 2>&1 && return; sleep .2; done
  return 1
}
cd "$ws"
printf '%s\n' '--- direct (GAIA_SERVE_DIRECT=1, warm on) ---' | tee -a "$proof/direct.log"
GAIA_SERVE_DIRECT=1 GAIA_SERVE_TRACE=1 bun ../../../src/cli.ts serve "$room" --port 47913 >"$proof/direct-server.log" 2>&1 &
direct_pid=$!
ready 47913
post 47913 direct-1 "$proof/direct.log"
post 47913 direct-2 "$proof/direct.log"
post 47913 direct-3 "$proof/direct.log"
kill "$direct_pid"; wait "$direct_pid" || true; direct_pid=""
printf '%s\n' '--- prompt-driven (warm on) ---' | tee -a "$proof/direct.log"
GAIA_SERVE_TRACE=1 bun ../../../src/cli.ts serve "$room" --port 47914 >"$proof/prompt-server.log" 2>&1 &
prompt_pid=$!
ready 47914
post 47914 prompt-1 "$proof/direct.log"
post 47914 prompt-2 "$proof/direct.log"
post 47914 prompt-3 "$proof/direct.log"
kill "$prompt_pid"; wait "$prompt_pid" || true; prompt_pid=""
printf '%s\n' '--- direct request 2 trace ---' >> "$proof/direct.log"
awk '/engine.run start/ { n++ } n == 3 { exit } n == 2 { print }' "$proof/direct-server.log" >> "$proof/direct.log"
