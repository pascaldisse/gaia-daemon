# AGENTS.md — gaia-daemon project rules

## ⚠️ RULE #0 — THE HARNESS ABSTRACTION IS ABSOLUTE

**pi, claude, and codex are NOT different things. They are interchangeable agentic
harnesses behind ONE abstraction.** (harness registry in `src/harness/spec.ts` →
`RunnerHost` (`src/harness/host.ts`) → `gaia __run-agent` runner → the
`AgentRuntime`/`AgentEvent` interface.)

You implement a capability **ONCE, at the harness/runtime abstraction layer**, and it
applies **uniformly to every harness** — the ones implemented today, the ones not yet
implemented, and any that come in the future. You do **not** touch "the thing underneath"
(a harness's own provider/SDK/CLI internals). When you add a feature, you add it to the
abstraction layer, full stop.

**ABSOLUTELY FORBIDDEN:**
- `if (harness === "pi")` / `=== "claude"` / `=== "codex"` branches in **shared** code.
- Implementing a feature for one harness "first" and the others "later."
- Describing follow-up as "wire claude/codex separately" — there is no separate.
- Any per-harness exception or special treatment anywhere in the shared layer.

**THE ONLY allowed harness-specific code:** a harness's own registration
(`registerHarness({...})` in `src/harness/<x>.ts`) may declare its wiring as **DATA on the
spec** — capabilities, ui, and the credential-proxy descriptor — read uniformly by the
shared layer, which never learns which harness it is. `src/harness/spec.ts` says it
directly: *"differences live as DATA on the spec … read uniformly — never as
`=== "claude"` branches."*

**Why:** the entire unify refactor exists to give every harness ONE uniform runner + one
tool-IO bridge + swappable sandbox. A single special-case rots that into scattered
exceptions and silently denies the feature to the next harness. This rule has been stated
many times and is treated as a hard regression when broken.

**How to apply:** before writing any harness-touching code, ask — *does this branch on the
harness id in shared code?* If yes, STOP and move it to a uniform mechanism where each
harness declares its behavior as data on its spec. Worked example: the credential-proxy is
a uniform `HarnessSpec.credentialProxy` descriptor every harness declares; `RunnerHost`
applies it with ZERO harness-id branches.

---

## Other standing rules

- **gaia is a multi-human + multi-AI group-chat room daemon** — not single-user. Channel
  bridges (Telegram/Discord/…) are plugins, never core.
- **Summons run autonomously** behind the sandbox + trust tier. NEVER propose
  human-in-the-loop approval/command-gating for summons — the sandbox IS the boundary.
- **Compiled bun app (Pascal, 2026-07-11).** Dev mode is DELETED — never reintroduce
  `--dev`, dev watchers, or auto-refresh; nothing reloads the app except Pascal
  (Cmd-R or /rebuild). Production daemon = a standalone `bun build --compile` binary
  built by `scripts/build-daemon.mjs` (binary + `web/` + `setups/` snapshots +
  `gaia-source.json` next to it). `/rebuild` rebuilds from source, then re-execs the
  fresh binary. `web/src` is JSDoc-typed plain `.js`, snapshotted into the build and
  **typechecked** (`tsc -p web/tsconfig.json`, strict checkJs). Daemon types reach the
  client only as JSDoc comment imports — never runtime imports of `src/`.
  `bun run check` gates both worlds. npm is retired: use `bun run <script>` for everything.
- **Bun only. Never invoke `node` or `npx`, ever (Pascal, 2026-07-11).** No script,
  shebang, launchd agent, or test command may shell out to the `node` binary or
  `npx`/`npm exec` — not "for now," not "just this once." Every executable script
  in `scripts/` is `#!/usr/bin/env bun`; every `package.json` script that runs a
  file runs it via `bun <file>` or `bun run <script>`; tests run via `bun test`
  (bun's runner is `node:test`-compatible — the existing `node:test` imports in
  `test/*.test.ts` do not need to change). `bunx` (bun's own tool-runner) is fine;
  `npx`/`npm` are not. If you find a `node` invocation anywhere in this repo or in
  a machine-local launchd plist that serves it (e.g. `~/Library/LaunchAgents/`),
  that is a bug — replace it with `bun`, don't leave it "since it still works."
- **Layering points down.** `server → daemon → services → harness → domain → core`.
  No module imports upward. Wire contracts (runner protocol, proxy mount) live in
  `src/harness/protocol.ts`.
- **Durability is protocol, not care** (see DESIGN.md): queued messages persist in
  `state.json.queue`; every turn reserves its transcript event id before streaming
  (`pendingTurn.eventId`); commit = append then one atomic state write; resume is
  idempotent. Never hold user work in memory only.
- **Zero duplication.** Shared plumbing lives once. Don't re-implement it per harness.
- **Trust is data, not a hardcoded id.** `trust: false` → forced real sandbox, never
  config-weakenable. Never hardcode a provider/model string as a security gate.

## ⚠️ UI claims require app-tools eyes — no blind 'it works'

Pascal (2026-07-11): smoke tests that never look at the real UI are banned.
The native app has a CDP debug server (port 9333) and a ready skill:
~/.gaia/skills/app-tools/ — app-eval.js, app-screenshot.js, app-console.js,
app-nav.js, app-info.js (bun, zero deps; server exists while the app runs).

- ANY claim that a web-UI or app feature 'works' MUST be backed by driving
  the running app through app-tools (eval/click/console/screenshot) — not
  curl-only, not unit-tests-only, not 'the code looks right'.
- After a UI-touching change: reproduce the user action via app-eval.js,
  read app-console.js for exceptions, and screenshot if visual.
- Never restart/quit the app to do this (see rule above); the debug server
  is on the RUNNING app.
- Spec authors: any worker spec for UI work must include this verification
  step explicitly.

## ⚠ Always test with the real kit — before every 'it works' and every answer

Pascal (2026-07-11): no claim ships untested. 'Tested' means the REAL path ran:
- agent/account/summon changes → a real `gaia summon` of a cheap agent (luna or ghoul-sonnet) through the real daemon, output pasted;
- UI changes → app-tools (rule above);
- daemon code → `bun run check` AND `bun test test/<touched>.test.ts` (bun only —
  never `npx`/`tsx`/`node`; run the touched file directly, not the whole `test/`
  glob — bun's `node:test` compat leaks state across files in one process, a
  known bun limitation, not a code regression; `--isolate` helps but the full
  suite still isn't clean under it as of 2026-07-11, so don't trust a full-suite
  bun-test run as a gate yet);
- GAIA-World changes → rain perception, not screenshots.
Self-invented smoke scripts that bypass the daemon prove nothing and are banned.
If the live path cannot run yet (e.g. the fix needs a daemon restart), say so and mark the claim UNVERIFIED — never imply it was tested.

## ⚠ ROOT CHECKOUT IS MERGE-ONLY — never work there (Pascal, 2026-07-12)

Work was destroyed TWICE (2026-07-11/12) because an agent edited/committed in
the main checkout (`/Users/pascaldisse/projects/gaia-daemon`) while other
agents' merges and `git reset --hard` traffic ran through it. The reflog is a
merge highway. Standing law for EVERY agent and every summoned worker:

- The root checkout is a shared **merge target only**. ALL editing, committing,
  and git surgery happens in YOUR room worktree
  (`.gaia/worktrees/<room-id>`) on your room branch — no exceptions.
- Never trust your shell's cwd: it can start in (or reset to) a different
  directory between calls. Always address git explicitly with
  `git -C <absolute-path>` and edit files by absolute worktree path.
- **`git reset --hard`, `git checkout -f`, and `git clean` in the root checkout
  are FORBIDDEN**, full stop — they vaporize whatever anyone else left there.
- Landing on main, the only sanctioned way:
  1. merge `main` INTO your worktree branch, resolve conflicts THERE,
  2. run the gate THERE (`bun run check` + touched `bun test` files),
  3. verify root has no tracked changes: `git -C <root> status --porcelain`,
  4. `git -C <root> merge --ff-only <your-branch>` — fast-forward only.
  If it can't fast-forward, your branch isn't ready; go back to step 1.
