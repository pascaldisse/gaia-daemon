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
## W4 A16 · edit/resend regression test code — queued for 陰
- code → `test/edit-resend-live.test.ts` (naru-sonnet, based on main `51a71cf`).
  Unit tests (seed helpers, env helper, evidence-reader parsing) run under
  plain `bun test` — no daemon, no network, no subprocess; gate-safe. The
  live HTTP flow is `test.skip`-gated by default; nothing here starts a
  daemon in a coding lane (CPU law).
- to run live → set `GAIA_LIVE_EDIT_RESEND=1`, `LIVE_WORKSPACE_DIR=<abs
  path>`, `GAIA_PORT` (defaults 18787 if the daemon was started via the
  file's `liveDaemonEnv()`), optional `LIVE_AUTH_TOKEN` if the ephemeral
  GAIA_HOME has registered users. Recipe:
  1. In this worktree: `bun run build --out .gaia/live-test-runs/dist`
     (compiled binary — dev mode is deleted, AGENTS.md).
  2. Call `seedEphemeralDaemonHome(...)` (or replicate by hand): isolated
     GAIA_HOME with `agents/luna` scaffolded + `accounts.json`, PLUS a real
     luna-capable OAuth account added on top (the seed only stubs the
     shell — no real credentials ship in the repo); a workspace dir already
     through `initWorkspace()` (ADV-013: `.gaia/config.json` must exist
     BEFORE the daemon's first boot against that `cwd`).
  3. Start the compiled binary with `cwd` = that workspace dir and env from
     `liveDaemonEnv(seed, port)` (strips inherited `GAIA_PARENT_PID` — see
     EDIT-RESEND-LIVETEST.md § Incidents for why a live daemon restart
     otherwise kills the ephemeral one).
  4. `GAIA_LIVE_EDIT_RESEND=1 LIVE_WORKSPACE_DIR=<that workspace dir>
     GAIA_PORT=<port> bun test test/edit-resend-live.test.ts`.
- verify → token round-trip through `/messages` + `/edit`, transcript.jsonl
  (edited text present, pre-edit old tail absent), rewound.jsonl (pre-edit
  old tail preserved off-branch), pi-sessions/luna/*.jsonl parent chain
  (edited entry's `parentId` = the pre-edit reply, never the rewound old
  tail) — codifies EDIT-RESEND-LIVETEST.md Q2/Q3 +
  REFACTOR-LIVE-RESULTS-20260902.md A6 as reusable, re-runnable code instead
  of ad-hoc manual commands.
- status: UNVERIFIED live — gate-only run confirmed (unit tests pass, `bun
  run check` clean); nobody has run the opt-in path against a real daemon
  yet.

## A13 typed contribution ports

- owner: 陰 live slot
- repro: after manifest registry composition, install one daemon-placement package declaring command/tool/channel/provider; invoke each with `{roomId,agentId}`; repeat untrusted + missing-cap contexts; send a `plugin-contribution` frame to a runner before A14.
- verify: declared+granted invocation only; undeclared/malformed output rejected; untrusted/missing-cap code never entered; runner returns explicit unavailable result, never legacy `~/.gaia/plugins/runner` fallback.
- status: UNVERIFIED — A13 ports/registry/protocol only; no daemon composition or manifest runner registry before A14.

## A14 manifest command + Telegram bridge
- owner→陰 live slot
- repro→compiled daemon; `~/.gaia/plugins/<pkg>/plugin.json` daemon command + invalid sibling + loose legacy `~/.gaia/plugins/<name>.mjs`; Telegram bridge valid bot/account env
- verify→invalid sibling→zero manifest entrypoint imports; repaired sibling→typed command registered; loose module warns synthetic compatibility manifest; Telegram incoming/outgoing→registered `gaia.telegram/telegram`; untrusted/missing-cap denied before contribution code
- status→UNVERIFIED; coding lane never starts daemon/port
## ROOT #9 W3 live repros · owner 陰
- plugin command registry turn → compiled daemon; workspace `.gaia/config.json` grants active agent required caps; issue declared bundled command in room; verify transcript command reply and registry generation/command provenance, no loose-module path.
- staged manifest boundary → begin a deliberately held room turn; stage changed manifest package; verify old generation completes held turn; release lease; next turn invokes new generation only; inspect disposer ordering/event log.
- untrusted capability denial → agent `trust:false`, workspace grants + agent capabilities include `network`; invoke a plugin requiring `network`; verify transcript surfaces denial and plugin contribution side-effect marker is absent.
## W3 REAL DELIVERY · ADV-020..023 — owner 陰
1. bundled command → compiled daemon; issue `/dog on` in default room; expect transcript `kind:"plugin-reply"`, dog reply; registry source `plugins/defaults` real index registration; no loose loader path.
2. durable denial → seeded `trust:false` agent with workspace/agent grants; invoke `network`-required probe; expect transcript `kind:"capability-denied"`, `details.pluginDenial={pluginId,capability,agentId,reason}`; daemon `[capabilities] denied plugin=...`; side-effect marker unchanged.
3. staged boundary → hold v1 probe command; mutate v2 manifest/entrypoint; `POST /api/plugins/reload`; expect stage log only while held, v1 completion, boundary swap log, next command v2, exactly one v1 dispose log.
- acceptance evidence → transcript.jsonl + daemon.log + marker counter + execution/disposer log; compiled-live only; no coding-lane daemon.
