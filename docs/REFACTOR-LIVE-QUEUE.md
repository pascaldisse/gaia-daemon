# REFACTOR live queue

## A1 ToolProviders bridge

- owner: root live slot
- repro: launch compiled daemon → summon Pi agent with `gaia` tool → invoke `{verb:"caryll",args:{action:"stats",path:"README.md"},raw:true}` → expect `真 caryll.stats`; invoke `{verb:"web",args:{url:"not a url"},raw:true}` → expect `ERROR: invalid url: not a url`; invoke `artifact create`/`artifact read` → payload round-trip.
- verify: runner → `/api/harness/tools` bearer bridge → daemon-injected `ToolProviders`; no harness→services imports.

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
