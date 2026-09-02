# REFACTOR live queue

## A1 ToolProviders bridge

- owner: root live slot
- repro: launch compiled daemon → summon Pi agent with `gaia` tool → invoke `{verb:"caryll",args:{action:"stats",path:"README.md"},raw:true}` → expect `真 caryll.stats`; invoke `{verb:"web",args:{url:"not a url"},raw:true}` → expect `ERROR: invalid url: not a url`; invoke `artifact create`/`artifact read` → payload round-trip.
- verify: runner → `/api/harness/tools` bearer bridge → daemon-injected `ToolProviders`; no harness→services imports.

## A6 RoomService split

- owner: root live slot
- repro: compiled daemon → room with a completed multi-event transcript → retry and edit a prior user event, then `/rewind 1`; restart while a queued turn is waiting and while a streamed turn has a `pendingTurn` WAL marker.
- verify: one regenerated reply after retry/edit; truncated events absent from fresh harness context; rewind resets affected sessions; queued turn drains once after restart; partial reply commits once and resume does not duplicate the runner.
- status: UNVERIFIED — live daemon slot owned elsewhere; unit coverage run in A6 worktree.
