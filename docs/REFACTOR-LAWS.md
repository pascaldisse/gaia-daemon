# REFACTOR LAWS v1 (verbatim into every lane spec)

- RULE0 harness abstraction: pi/claude/codex behind ONE abstraction (spec.ts registry → RunnerHost host.ts → __run-agent → AgentRuntime). NO `harness === "x"` in shared code; harness variance = DATA on registerHarness spec only.
- Layering points down: server → daemon → services → harness → domain → core. No upward imports. Wire contracts → src/harness/protocol.ts.
- ROOT /Users/pascaldisse/projects/gaia-daemon = MERGE-ONLY. All edits/commits in YOUR lane worktree (.gaia/worktrees/<your-room>) on your branch; always `git -C <abs>`; edit by abs worktree path. `reset --hard`/`checkout -f`/`clean` in root = FORBIDDEN. Landing: merge main INTO branch → gate there → root porcelain-clean → `git -C root merge --ff-only <branch>`.
- BUN ONLY (never node/npx/npm). Gate = `bun run check` + `bun test test/<touched>.test.ts` (touched files only, never whole glob). Untested-large file split ⇒ test lands in same atom.
- Refactor atom = move+split+delete, ZERO behaviour change; ≤~450 lines touched; exemplar named in spec (services/summons/* for splits). Zero duplication.
- never hardcode (param + default) · never /tmp (use <worktree>/.gaia/ or ~/.gaia/) · commit every stage · Durability = protocol (state.json.queue, pendingTurn.eventId) untouched by refactor atoms · trust:false ⇒ forced sandbox, never weakenable.
- TESTING LAW: nothing 'works' without the real gate pasted. Live-path atoms (A6 fork · W3 · W4) need ephemeral daemon + real `gaia summon`/luna message, output pasted; else mark UNVERIFIED.
- CPU LAW: coding lanes parallel freely; LIVE tests = max ONE running daemon instance machine-wide, OWNED by the 陰 root. Your lane does code + unit gate; live-path need ⇒ write exact repro into commit message + docs/REFACTOR-LIVE-QUEUE.md. Lane end ⇒ orphan sweep (no leftover daemons/esbuild/nohup); delete temp builds.
- New worktree ⇒ `git submodule update --init design unmute` + `bun install` before `bun run check` (design/ is a submodule; otherwise phantom TS errors).
