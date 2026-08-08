# GAIA v2 — Design

The rewrite. Same soul, same file formats, same CLI, same HTTP+SSE surface —
half the code, none of the god objects, durable by construction.

## Non-negotiables (carried over)

1. **Harness abstraction is absolute.** pi/claude/codex are data-described
   specs behind one registry. No harness-id branches in shared code, ever.
2. **No build step.** Daemon runs under tsx/node. Web client is plain `.js`
   ES modules served as-is — but **typechecked** (checkJs + JSDoc types
   imported from `src/` as *comments*, so nothing needs erasing).
3. **No progress ever lost — actually.** Queue, turn, and commit are all
   journaled. Every gap found in v1 (in-memory queue, non-atomic commit,
   leaked voice overrides) is closed by protocol, not by care.
4. **Trust is data.** `trust: false` → forced real sandbox, fail-closed.
5. **Summons run autonomously.** Sandbox is the boundary; no approval gates.
6. **On-disk compatibility.** `~/.gaia`, `.gaia/`, agent.json, persona/,
   transcript.jsonl, state.json, setups — v1 workspaces open in v2 unchanged
   (v2 adds fields; it never requires them).

## Architecture: four layers, dependencies point down

```
server/   HTTP + SSE + static.  Thin: parse request → daemon call → respond.
daemon.ts Composition root. Builds everything, owns workspace/room lifecycle.
services/ One concern per module: scheduler, turns, commands, summons,
          monad(+policies), setups, voice, proxy, bridge, hints, tools.
harness/  The runtime seam: spec registry, uniform runner subprocess,
          sessions, sandbox, breaker, reaper, prompt assembly.
domain/   Agents, roles, skills, memory, recall, rooms (the journal).
core/     types, paths, store (atomic fs), config, bus. Zero opinions.
```

Rules: `core` imports nothing of ours. `domain` imports `core`. `harness`
imports `core`+`domain`. `services` import downward. `server` imports only
`daemon.ts`'s public API. `web/` imports nothing from `src/` at runtime
(JSDoc type imports only — comments).

## The durability protocol (fixes v1 §2)

All room state lives in one `RoomHandle` (domain/rooms.ts) — the **single
writer** for a room's `transcript.jsonl` + `state.json`.

- **Queue**: queued messages are in `state.json.queue[]`. Enqueue = atomic
  state write. Daemon boot re-drains the queue. Nothing lives only in RAM.
- **Turn WAL**: `markPendingTurn()` reserves the event id *before* streaming
  and persists `{id, eventId, agentId, prompt, targets, partialReply,
  channel, startedAt}`. Partial replies flush at most 1/s.
- **Atomic commit**: (1) append the agent event (carrying the reserved
  `eventId` *and its runtime details*) to transcript.jsonl; (2) one atomic
  state write that clears pendingTurn + advances the author's cursor.
  Resume rule: if `pendingTurn.eventId` already exists in the transcript,
  the crash was between (1) and (2) → just finish (2). Otherwise re-run the
  turn from `partialReply`. Idempotent by construction.
- **Runtime details live in the transcript event** (`details: {model,
  thinking?, tools?}`), not in a side LRU. History keeps its metadata
  forever. `RUNTIME_DETAILS_LIMIT` is deleted, not tuned.
- **Voice overrides**: call-scoped changes are recorded in
  `~/.gaia/voice-state.json` before applying; boot sweeps and restores any
  orphaned override.

## The harness seam (keeps v1's one good idea, unifies the rest)

- `HarnessSpec = { id, title, capabilities, ui, credentialProxy?,
  createRuntime(ctx) }` in a registry; `harness/index.ts` is the barrel.
- **One `SessionMap<M>`** replaces v1's three hand-rolled session trackers
  (RoomState / ManagedPiSession / ThreadState): per-room slot with uniform
  `memoryChanged()` diffing; the harness supplies only its metadata `M` and
  hooks. Protocol adapters (NDJSON for claude, JSON-RPC for codex, SDK
  subscribe for pi) stay per-harness — they are irreducible.
- Every harness runs turns in the uniform `gaia __run-agent` subprocess
  (RunnerHost ↔ runner over NDJSON stdio; ready/turn/event/turn-end/abort/
  reset/dispose). Sandbox wraps that one spawn. Circuit breaker per
  `harness:provider/model` target. Orphan reaper sweeps marked processes on
  boot.
- Credential proxy: uniform `credentialProxy` descriptor on the spec;
  RunnerHost applies it with zero branches.

## Services replace the god objects

v1's GaiaController (1,044 lines) and server.ts (1,228 lines) become:

- `scheduler.ts` — per-room durable task queue, drain loop, cancel.
- `turns.ts` — TurnEngine: run one agent turn through a RunnerHost with the
  WAL protocol; emit UiEvents on the bus.
- `router.ts` (in commands.ts) — pure parsing of @mentions + /commands;
  unknown agents fail at parse time, not dispatch time.
- `commands.ts` — `Record<string, CommandHandler>`; each handler is small,
  testable, and registered — adding a command is one entry.
- `summons.ts` — background subagents: child rooms, caps, trust/nesting gates,
  and the durable result callback (launch never blocks; the worker's result is
  delivered back into the calling room and re-invokes the caller; a restart
  re-arms undelivered summons from the child room's state).
- `monad.ts` + `policies/` — the engine loop + 3 policies (prompt-driven,
  trinity-head, conductor-dag), ported.
- `voice.ts` — ONE voice module: stack lifecycle + call session + unmute
  bridge + override persistence (v1 scattered this over 4 files + routes).
- `proxy.ts`, `bridge.ts`, `hints.ts`, `setups.ts`, `tools.ts` — as named.
- `daemon.ts` — composition root; the only stateful "manager", and it only
  wires. Server routes call daemon methods; no business logic in routes.

## Web client: honest, typed, keyed

- `web/src/*.js` — real JavaScript, JSDoc-typed, `web/tsconfig.json` with
  `checkJs: true` typechecks it against the daemon's exported types via
  `@typedef {import("../../src/core/types.js").RoomEvent}` comments. The
  no-build rule survives because comments need no erasing. `npm run check`
  gates both worlds.
- Rendering: same `h()` hyperscript, but **regional renderers with a dirty
  set** (tabs, sidebar, transcript, composer, status bar) instead of
  full-app re-render; transcript patches per-event nodes keyed by event id
  — the author+text merge heuristic is deleted (details arrive on the event
  itself now).
- Keep: tmux layout, 11 themes, keybindings, settings-hints editors,
  composer previews, voice client (opus worklets from vendor/).
- CSS trimmed and variable-driven; target well under 1,000 lines.

## Repo hygiene

- `unmute/` stays (voice is a feature and the macOS port isn't upstreamed)
  but is quarantined: documented as vendored, its caches live outside git.
- `tmp/`, `ui-test/` deleted. Planning docs move to `docs/history/`.
- Root: README, AGENTS, DESIGN, CRITIQUE, LICENSE. That's it.

## Size targets

| area | v1 | v2 target |
|------|----:|----------:|
| src/ | ~10.5k | ~6k |
| web/src + css | ~7k | ~4k |
| test/ | ~6.8k | ~4k focused |

## Testing

`node:test`, zero deps, same as v1 — but per-module units now exist because
modules do. Every v1 test *scenario* is preserved (the suite is the
behavioral spec); the WAL protocol, queue durability, and resume rules get
dedicated crash-simulation tests. Target: green in <10s.
