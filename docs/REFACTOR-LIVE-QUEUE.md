# REFACTOR live queue

## A1 ToolProviders bridge

- owner: root live slot
- repro: launch compiled daemon → summon Pi agent with `gaia` tool → invoke `{verb:"caryll",args:{action:"stats",path:"README.md"},raw:true}` → expect `真 caryll.stats`; invoke `{verb:"web",args:{url:"not a url"},raw:true}` → expect `ERROR: invalid url: not a url`; invoke `artifact create`/`artifact read` → payload round-trip.
- verify: runner → `/api/harness/tools` bearer bridge → daemon-injected `ToolProviders`; no harness→services imports.

## A5 HTTP route refactor — UNVERIFIED live app
1. Start the owned live daemon.
2. Verify authenticated room, agent, memory, artifact, usage, and edit/retry requests retain status and JSON shapes.
3. Verify an unauthenticated `GET /api/auth/users` returns `401 {"error":"Not logged in."}`.
## A7 daemon.ts split (daemon/wiring.ts + daemon/reload.ts)

- owner: root live slot
- repro (boot-time recovery sweeps): kill -9 a running daemon mid-turn (or
  with a queued-but-undrained message / an in-flight background summon) →
  restart → confirm `boot()`'s `recoverPendingTurns()`/`recoverSummons()`
  (now in daemon/wiring.ts, host-parameterized) still resume the stranded
  turn/summon exactly once, in the same order, before the orphan-sweep gate
  (`serviceFor` awaiting `orphanSweepDone`) releases.
- repro (settings hot-reload): save a workspace/global settings file (model
  or thinking change) while a room has an active turn → confirm
  `applySettingsChange`/`reloadService` (now daemon/reload.ts) still defers
  via `pendingReloads` until the turn settles, then rebuilds exactly once
  (no double-rebuild, no lost defer) — covered by `bun test` with a fake
  clock/mocked RoomService (test/room-service.test.ts, test/daemon-delete.
  test.ts); never exercised against a real runner subprocess restart.
- verify: unit coverage (148 pass) exercises the extracted functions'
  logic paths but not a real process boot/restart cycle.
## A6 RoomService split

- owner: root live slot
- repro: compiled daemon → room with a completed multi-event transcript → retry and edit a prior user event, then `/rewind 1`; restart while a queued turn is waiting and while a streamed turn has a `pendingTurn` WAL marker.
- verify: one regenerated reply after retry/edit; truncated events absent from fresh harness context; rewind resets affected sessions; queued turn drains once after restart; partial reply commits once and resume does not duplicate the runner.
- status: UNVERIFIED — live daemon slot owned elsewhere; unit coverage run in A6 worktree.

## PASS-2 blocked live slot · `20eb9b6`
- 18787 compiled daemon/listen → PASS.
- required `@luna` turn → HTTP 500 unknown agent; available `dario|gaia|sidia|terry` → ADV-011.
- items A1/A5/A7 → UNVERIFIED; no substitute agent used because protocol required Luna.
- cleanup → daemon killed · isolated dist/home removed · 18787 listener empty.

## 2026-09-02 corrected-seed closure · compiled `4bd87be`
- evidence → `docs/REFACTOR-LIVE-RESULTS-20260902.md`.
- ADV-011 original unknown-luna result → TEST-SETUP superseded; corrected seed lists/uses luna.
- A1 ToolProviders → PASS.
- A5 HTTP route smoke → FAIL · ADV-013; `GET /api/app` 500 missing cwd workspace config.
- A6 mixed mention/edit + session fork → PASS.
- A7 SIGKILL/WAL recovery + settings-file reload → PASS.

## A6c durable queue + turn-results extraction
- owner: 陰 live slot
- repro: ephemeral compiled daemon; seed GAIA_HOME `agents/luna` + `accounts.json` + `config.json`; workspace under worktree containing `.gaia/config.json`; `env -u GAIA_PARENT_PID`; port `${GAIA_PORT:-18787}`.
- verify: busy message persists `state.json.queue`; restart between reserved `pendingTurn.eventId` and completion; queue drains once; partial/reply event id has no duplicate transcript entry.

## W4 A16 edit/resend regression
- owner: 陰 live slot
- repro: same isolated daemon/home; send two `@luna` token turns, edit first user event; inspect transcript + rewound + Pi session parent chain from disk.
- verify: old tail absent from active transcript and fresh prompt branch; rewound retains old tail; edited reply occurs once; `GAIA_PARENT_PID` absent; daemon cwd owns `.gaia/config.json` (ADV-013).

## A10 manifest-first plugin foundation

- owner: root live slot
- repro: after the manifest loader is wired by a later atom, launch compiled daemon with one valid daemon-placement package and one invalid sibling package → assert no package entrypoint runs; repair sibling → assert only selected placement runs after complete inventory validation.
- status: UNVERIFIED — A10 exports the validated loader only; legacy command/runner paths remain unchanged pending A14, so no daemon call-site exists to exercise.
