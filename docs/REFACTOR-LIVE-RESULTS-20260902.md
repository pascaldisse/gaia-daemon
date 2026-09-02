# Live refactor results — 2026-09-02

Build → compiled `gaia-daemon` @ `4bd87be`; own `GAIA_HOME`; port `18787`; `GAIA_HOME/agents/luna` + whole `accounts.json` + `config.json` seeded. Workspace → `.gaia/livews`.

## ADV-011 reclassification
- prior `Unknown agent: luna` → test setup, not daemon regression.
- evidence → seeded `agents/luna/{agent.json,persona,memory}`; workspace payload listed `luna` before turn; every token turn selected `luna` + committed reply.

## A6 mixed agent mention + edit — PASS
- commands → `POST .../messages` TOKEN-1; `POST .../messages` `@luna say @luna TOKEN-2 back`; `POST .../edit` first event → TOKEN-1-EDIT.
- expected → forked parent chain; old tail rewound; fresh session branch excludes old tail.
- actual → active transcript 2 events; rewound 4 events; edited session user `f4b4e0e2.parentId=07da2578`; old-tail `TOKEN-2` off-branch only.
- hashes → `live-hashes.txt`.

## A1 ToolProviders — PASS
- command → `POST .../messages` `@luna use the gaia tool: web fetch https://example.com and reply with the page title only`.
- expected → `toolCall` + `toolResult`; `Example Domain` reply.
- actual → transcript tool block + `Example Domain`; Pi session `85b187b6` toolCall → `a1e483b7` toolResult.
- hashes → `live-hashes.txt`.

## A7/A6 SIGKILL recovery — PASS
- command → send TOKEN-3; observed `state.json.pendingTurn`; `kill -9 71260`; restart same compiled binary/env.
- expected → exactly-once recovery; queue drain; valid JSONL.
- actual → restart log `turn recovery: waking ... (pending=true, queued=0)`; TOKEN-3 one user + one assistant event; duplicate ids `[]`; pendingTurn absent after commit.
- hashes → `live-hashes.txt`.

## A7 settings reload — PASS
- route → `PUT /api/files/workspace_00e4e58e1bc3812c5b?workspaceId=4085b8d4edd86478` with unchanged workspace config; handler invokes `applySettingsChange`.
- expected → room remains; next turn works.
- actual → snapshot rooms `[default]`, eventTotal=6 before probe; TOKEN-4 committed after reload.
- hashes → `live-hashes.txt`.

## A5c route smoke — FAIL · ADV-011 (new)
- authenticated-route setup attempted: unauth `GET /api/auth/users` → `401 {"error":"Not logged in."}`; room routes snapshot/events/humans/favorite/title/default-agent → 200; voice/clips → 200.
- expected → no 5xx.
- actual → `GET /api/app` → `500 {"error":"Missing workspace config: .../ghoul-terra-mtklq5ixkikbww/.gaia/config.json"}`. Boot log also: `summon recovery skipped ... Missing workspace config`.
- ticket → ADV-011: app payload/boot recovery includes cwd auto-workspace lacking `.gaia/config.json`; route smoke cannot complete. No fix attempted.

## Queue verdict
- A1 → PASS.
- A5 → FAIL; ADV-011.
- A6 → PASS.
- A7 crash/WAL + settings reload → PASS.
