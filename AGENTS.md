# AGENTS.md — gaia-daemon rules

## ⚠️ RULE #0 — HARNESS ABSTRACTION IS ABSOLUTE
pi/claude/codex = interchangeable harnesses behind ONE abstraction (spec.ts
registry → RunnerHost host.ts → `gaia __run-agent` → AgentRuntime/AgentEvent).
Every capability implemented ONCE at the abstraction layer, uniform for every
harness — present + future. Never touch a harness's own internals for a
shared feature.
FORBIDDEN: `harness === "x"` branches in shared code · one-harness-first /
"wire others later" · any per-harness exception in the shared layer.
ONLY allowed harness-specific code: its own `registerHarness({...})` in
src/harness/<x>.ts declaring wiring as DATA on the spec (capabilities, ui,
credentialProxy) — read uniformly; shared layer never learns which harness.
Self-check before harness-touching code: branches on harness id in shared
code? → STOP, move to uniform mechanism. Exemplar: credentialProxy descriptor,
applied by RunnerHost w/ ZERO branches. Breaking this = hard regression.

## Standing rules
- gaia = multi-human + multi-AI group-chat room daemon, never single-user.
  Channel bridges (Telegram/Discord/…) = plugins, never core.
- Summons run autonomously behind sandbox + trust tier. NEVER propose
  human-in-the-loop approval/gating — sandbox IS the boundary.
- Compiled bun app (Pascal 07-11): dev mode DELETED — never reintroduce
  --dev/watchers/auto-refresh; only Pascal reloads (Cmd-R / /rebuild).
  Daemon = `bun build --compile` binary via scripts/build-daemon.mjs (binary
  + web/ + setups/ snapshots + gaia-source.json). /rebuild = rebuild from
  source + re-exec. web/src = JSDoc-typed plain .js, snapshotted, strict
  checkJs typechecked (tsc -p web/tsconfig.json); daemon types → client only
  as JSDoc comment imports, never runtime src/ imports. `bun run check`
  gates both worlds. npm retired.
- BUN ONLY — never node/npx/npm, ever (Pascal 07-11). scripts/ =
  #!/usr/bin/env bun; package.json scripts run via bun; tests = `bun test`
  (node:test-compatible, existing imports fine). bunx ok. Any node
  invocation found (repo OR machine launchd plists) = bug → replace with bun.
- Layering points down: server → daemon → services → harness → domain → core.
  No upward imports. Wire contracts → src/harness/protocol.ts.
- Durability = protocol, not care (DESIGN.md): queue persists in
  state.json.queue; turn reserves transcript event id pre-stream
  (pendingTurn.eventId); commit = append + one atomic state write; resume
  idempotent. Never hold user work in memory only.
- Zero duplication — shared plumbing lives once, never per-harness.
- Trust is data: `trust: false` → forced real sandbox, never
  config-weakenable. Never hardcode provider/model string as security gate.

## ⚠ Testing — no untested "it works", EVER (Pascal 07-11)
- UI/app claims → drive the RUNNING app via ~/.gaia/skills/app-tools (CDP
  :9333): app-eval/app-console/app-screenshot/app-nav/app-info. Reproduce
  the user action, read console for exceptions, screenshot if visual. Never
  restart/quit the app for this. curl-only / unit-only / "code looks right"
  ≠ proof. UI worker specs MUST include this step.
- agent/account/summon changes → real `gaia summon` of a cheap agent
  (luna/ghoul-sonnet) through the real daemon, output pasted.
- daemon code → `bun run check` AND `bun test test/<touched>.test.ts` —
  touched files directly, never the whole test/ glob (bun's node:test compat
  leaks state across files; full suite untrusted as gate, 07-11).
- GAIA-World → rain perception, not screenshots.
- Self-invented smoke scripts bypassing the daemon = banned.
- Live path can't run yet → say so, mark claim UNVERIFIED.

## ⚠ ROOT CHECKOUT = MERGE-ONLY (Pascal 07-12; work destroyed twice)
- Root = shared merge target ONLY. ALL editing/commits/git surgery in YOUR
  room worktree (.gaia/worktrees/<room-id>) on your room branch.
- Never trust cwd: always `git -C <abs-path>`; edit by abs worktree path.
- `reset --hard` / `checkout -f` / `clean` in root = FORBIDDEN, full stop.
- Landing on main: 1) merge main INTO your branch, resolve THERE · 2) gate
  THERE (bun run check + touched bun tests) · 3) root porcelain-clean ·
  4) `git -C <root> merge --ff-only <branch>`. No ff → not ready → step 1.

## ⚠ STYLE LAW — telegraphic notation (Pascal 07-13)
Everything written into agent context (skills, roles, AGENTS.md, memory,
docs, specs, summon tasks) = memory-file notation: fragments + arrows +
§ pointers, no filler sentences, state once + point after, NEVER re-explain
in different wording. Exemplar: agent MEMORY.md. Bloated prose in context
files = bug.

## Repo map
- Rooms/transcripts PER-WORKSPACE: <ws>/.gaia/rooms/<roomId>/transcript.jsonl.
  Room-store workspaces: ~/, projects/, GAIA-World-Engine/, mxo-hd/,
  darkness/, gaia-os/, ttrpg/, vision-flow/, gaia-daemon/, Downloads/test/.
- ~/.gaia = global config ONLY: accounts.json, agents/ (personas+souls),
  ambient-watchdog/, app.json, config.json, browser-profiles/,
  codex-accounts/, backups/. No rooms.
- Prompt/soul/tool-docs assembly: src/harness/prompt.ts (assembler),
  tools.ts (GAIA-tools block), spec.ts, model-label.ts; per-agent
  soul+memory ~/.gaia/agents/<id>/.
- Design docs: DESIGN.md, MEMORY-DESIGN.md, REPLACEMENT.md,
  IMPLEMENTATION-PLAN.md, CRITIQUE.md, TODO.md, docs/{CARYLL,IMPORT,
  REMOTE-STACK}.md, HANDOFF-*.md.
