# Handoff — Claude Code harness (Phase 1 done) + harness refactor + Phase 2 memory/recall/summon

Context for a fresh session. Covers: what shipped (Phase 1), the guiding
principle that emerged, the refactor to do next (Phase 1.5), the Phase 2
design for memory/recall/summon across all harnesses, and a small cleanup.

Related persistent memory: `claude-harness-decision`, `codex-harness-decision`,
`summons-codex-work`. Related docs: `memory-plan.md` (the memory core + its
four-point provider seam), `HANDOFF-CODEX-HARNESS.md`.

---

## 0. Status

> **Update (this session): §4 cleanup, §2 Phase 1.5, and §3 Phase 2 (Claude
> path) are DONE on `feat/claude-harness`.** Suite 191/191 green;
> `npm run check`/`build` clean; CLI reads + daemon routing live-smoked.
>
> - **§4**: `runtime` accepted as a `harness` alias (`rawHarness`), `permissionMode`
>   plumbed through `RawAgentConfig`→`AgentDefinition` (`normalizePermissionMode`).
> - **§2**: `claude-runtime.ts` now derives `--tools`/`--allowedTools` from
>   `agent.tools` via the pure `buildClaudeToolGrant` (read→Read,Grep,Glob;
>   write→Write; edit→Edit; bash→general `Bash`; memory/recall/summon→narrow
>   `Bash(gaia mem:*|recall:*|summon:*)` decoupled from `bash`). `--permission-mode`
>   is data (`agent.permissionMode`, incl. `plan`). `--safe-mode` kept as default.
>   `tools` unhidden for claude; `permissionMode` hint shown only for claude.
> - **§3 (Claude)**: `gaia mem|recall|summon` CLI (`src/cli-harness.ts`). Reads
>   (`mem list|read`, `recall`) hit disk via env (`GAIA_MEMORY_DIR`,
>   `GAIA_ROOM_DIR`); writes/summon POST to the daemon (`/api/harness/memory`,
>   `/api/harness/summon`) authed by an HMAC token (`src/app/harness-bridge.ts`,
>   `HarnessBridge`/`HarnessHost`) minted per turn and carrying
>   `{workspaceId,agentId,roomId,allowSummon}`. `ClaudeRuntime` injects env +
>   token and appends a one-line gaia-CLI pointer to the system prompt.
>   `GaiaController.mutateAgentMemory`/`summonAndWait` are the daemon-side single
>   writer. Summoned agents get a `allowSummon:false` token (no recursive summon).
> - **Codex (partial, this session)**: `codex-runtime.ts` now derives its
>   sandbox from `agent.tools` (`codexSandboxFor`: write/edit/bash →
>   `workspace-write`, else `read-only`) instead of a fixed read-only stance, and
>   injects room-independent **memory** env + a no-room token (`gaia mem` works;
>   `gaia mem` pointer added to baseInstructions). `recall`/`summon` are NOT wired
>   for Codex: its app-server is one persistent process shared across rooms, so
>   per-turn/per-room env (`GAIA_ROOM_DIR`, room-scoped token) can't be injected.
>   Codex `tools` stays hidden in settings (coarse/partial mapping — recall/summon
>   toggles wouldn't take effect). NOTE: whether Codex's OS sandbox permits the
>   localhost daemon write call is unverified (needs a live codex turn).
> - **Still open**: Codex recall/summon (needs a room-context delivery design for
>   the persistent app-server — e.g. daemon resolves the agent's active room);
>   live codex memory-write validation; optional recall prefetch; optional Pi→CLI
>   convergence; full live claude turn E2E (write+summon loops were smoked with a
>   fake `claude` binary this session — see below).
>
> Live E2E this session (fake `claude`, isolated `GAIA_HOME`, daemon on a temp
> port): a daemon-spawned turn ran `gaia mem add` → token → `/api/harness/memory`
> → `MemoryStore` (wrote a real `§`-delimited entry); and `gaia summon gaia …`
> ran a summoned agent whose own `gaia summon` was correctly 403'd (recursion
> guard) while its `gaia mem add` succeeded.

## 0a. Original status (Phase 1)

- **Phase 1 (Claude harness) is BUILT, tested, live-validated, and committed**
  on branch **`feat/claude-harness`** (commit `1f1168e`), **not merged to main**.
  Suite 161/161 green, `npm run check`/`build` clean. The user may want it
  fast-forwarded to `main` (we branched off `main` for hygiene).
- New files: `src/runtime/claude-runtime.ts`, `test/claude-runtime.test.ts`.
- Wired touchpoints: `runtime-factory.ts` (`claude` case), `agents/types.ts`,
  `workspace/types.ts`, `workspace/workspace-loader.ts` (`parseHarness`),
  `agents/scaffold.ts` (`normalizeHarness`), `src/app/settings-hints.ts`
  (`HARNESS_CONFIGS.claude`); `test/runtime-factory.test.ts` +
  `test/settings-hints.test.ts` updated.

`AgentHarness = "pi" | "codex" | "claude"`. The three runtimes implement
`AgentRuntime` (`src/runtime/types.ts`): `send() → AsyncIterable<AgentEvent>`,
`abort()`, `dispose()`, `agent`, `modelLabel`.

### How Phase 1 works (ClaudeRuntime)

- **Process model B**: one `claude -p` invocation per turn, spawned via an
  injectable `ClaudeProcessFactory` (callback shape `onMessage`/`onExit`/`onError`,
  mirrors CodexRuntime's testability). Default factory spawns the real `claude`.
- **Subscription auth**: inherits the user's env; never sets `ANTHROPIC_API_KEY`;
  never uses `--bare` (which would force API-key-only auth). Confirmed live:
  init message reports `apiKeySource:"none"` → `subscription:true`.
- **Per-room session continuity**: a generated UUID per room, passed as
  `--session-id` on the first turn and `--resume` on later turns (stored in a
  `rooms` Map). A failed *first* turn drops the room so the retry starts fresh
  rather than `--resume`-ing a session that may not exist.
- **Prompt** is delivered on **stdin** (avoids arg-length limits on big
  transcripts). System prompt via `--system-prompt` (full `buildSystemPrompt`
  output). Memory injected in the turn prompt only-when-changed (the same
  `lastMemoryContent` discipline as Pi — good for prompt caching).
- **Output parsing** (`--output-format stream-json --include-partial-messages
  --verbose`): `system/init`→`model-info` (provider `"anthropic"`); `stream_event`
  `content_block_delta` `text_delta`→`text-delta`, `thinking_delta`→`thinking-*`
  (lazy start on first delta, `thinking-end` on the thinking block's
  `content_block_stop`); `assistant` message `tool_use` blocks→`tool-start`
  (dedup by id); `user` message `tool_result` blocks→`tool-end`; `result`
  (`is_error` or non-`success` subtype)→throw, else turn end.
- **abort()** = SIGTERM the active child.

### Prompt caching (a question the user asked; answer settled)

Server-side, ~5-min TTL. Process model B vs a persistent process is a wash for
caching (the local process holds no cache). Stability comes from a stable
`--system-prompt` + memory-when-changed; `--resume` replays with Claude Code's
own cache_control breakpoints. Only real cost: idle gaps >~5min re-read the
prefix uncached (cost/latency, not correctness).

---

## 1. The guiding principle (decided this session — overrides earlier framing)

**A harness is a faithful TRANSLATOR of a per-agent config, not a place that
bakes in modes.** "Plan mode", "read-only", "implementation agent" are NOT code
paths — they are just *names for combinations of toggles* a user sets. Every
tool/ability is independently switchable; any combination is valid. The agent
config (`tools` array + ability/posture knobs) is the single source of truth;
each harness maps it onto its primitives as faithfully as it can. Nothing about
a "mode" is hardcoded.

This came from inspecting the real agent configs (examples only, not fixed
policy):

| agent  | tools                                   | note            |
|--------|-----------------------------------------|-----------------|
| gaia   | read, edit, write, memory, recall       | no `bash`       |
| sidia  | read, write, edit, memory, recall       | no `bash`       |
| terry  | read, write, edit, **bash**, memory, recall | has `bash`  |
| jareth | read, write, edit, memory, recall (`harness: codex`) | no `bash` |

Takeaways:
- They are **not** filesystem-read-only — all have write/edit (they need to
  write markdown). The user's "read-only"/"plan mode" really means **"no
  shell"** — the differentiator is the `bash` tool (terry has it; others don't).
- **`memory`/`recall` are toggled ON for agents that have NO `bash`** (gaia,
  sidia). So memory/recall must be deliverable WITHOUT the generic shell. This
  is the central constraint for Phase 2.

---

## 2. Phase 1.5 — refactor ClaudeRuntime into a config-driven translator (DO FIRST)

Phase 1 hardcoded a read-only posture. That violates the principle and is
*more* restrictive than gaia/sidia (who have write/edit). Fix before Phase 2:

In `src/runtime/claude-runtime.ts`:
- **Remove** `const READ_ONLY_TOOLS = "Read,Grep,Glob"` and the unconditional
  read-only stance.
- **`buildArgs` becomes a pure function of the agent config.** Derive Claude
  tools/permissions from `agent.tools`:
  - `read` → `Read,Grep,Glob`
  - `write` → `Write`
  - `edit` → `Edit`
  - `bash` → `Bash` (general `Bash(*)` permission)
  - `memory`/`recall` → narrow gaia-CLI grant (Phase 2; see §3) — **decoupled
    from the `bash` toggle**
- **Posture knobs become overridable defaults, not branches.** `--safe-mode`
  (isolation: keeps the user's own CLAUDE.md/skills/hooks/MCP out) stays a
  sensible default but should be expressible in config. Claude's
  `--permission-mode` (incl. the literal `plan` value) is a real toggle to
  expose as *data* — that's how "plan mode" exists without a special case.
  Caveat to verify: `--safe-mode` must not disable the built-in `Bash`/file
  tools we rely on; if it does, drop it and isolate another way (e.g.
  `--setting-sources`).
- Keep: stdin prompt, `--system-prompt`, `--session-id`/`--resume`, model +
  effort mapping (already config-driven), stream-json parsing.

In `src/app/settings-hints.ts`:
- **Unhide `tools` for claude** — remove `hiddenFields: ["tools"]` from
  `HARNESS_CONFIGS.claude`. For Claude the `tools` array is the real control
  surface (unlike codex, which currently hides it and runs a fixed sandbox).
- Consider extending `HarnessConfig` to **declare each harness's capability
  mapping** (which logical tools/postures it can represent), so the settings UI
  shows only what's real per harness and the translator can degrade gracefully.
  Honesty matters: harnesses differ in granularity — Claude maps finely
  (per-tool + permission-mode), Codex is coarse (sandbox `read-only` /
  `workspace-write` + approval policy) and **also currently ignores the
  per-agent `tools` array**. Don't pretend a toggle maps when it can't; surface
  the gap.

Tests: extend `test/claude-runtime.test.ts` to assert `buildArgs` reflects the
agent's `tools` (e.g. an agent with `write`/`edit` gets Write/Edit; one without
`bash` gets no general Bash; one with `bash` does).

---

## 3. Phase 2 — memory / recall / summon across ALL harnesses

Goal: the same behavior, policy, and data for memory/recall/summon under pi,
codex, and claude — driven by the per-agent `tools` toggles.

### Current state of these capabilities

- **Pi**: `memory`, `recall`, `summon` are real in-process custom tools
  (`defineTool`) in `pi-runtime.ts` `createManagedSession` (~line 271), gated by
  the agent's `tools` list. `memory` also has the always-injected prompt block.
- **Codex & Claude**: only the *prompt-injected* memory block (Phase 1). No
  interactive memory/recall/summon yet. Codex Phase 2 was paused (see
  `codex-harness-decision`). **Phase 2 should solve both at once.**

### Why NOT MCP (decision, with the honest caveat)

The "MCP = token bloat" critique is real for *large third-party servers*
(Playwright 21 tools/13.7k tokens; GitHub 93 tools/55k; stacks burn 60–80% of
the context budget on definitions) and pi **"does not and will not support
MCP"** — its alternative is *CLI tools + README + bash + progressive
disclosure* (4 core tools: read/write/edit/bash). Anthropic's own "Code
execution with MCP" post concedes the direction (tools-as-code, invoked on
demand; 150k→2k tokens in their example). `pi-mcp-adapter` (npm, 3rd-party, by
Nico Bailon) even bolts MCP onto pi via a single ~200-token lazy proxy tool —
confirming "progressive disclosure beats schema-dumping."

**Honest caveat:** at our scale (3 self-authored tools), MCP's context cost is
roughly the same as Pi's existing in-process tools — so "bloat" is NOT the real
reason to avoid MCP here. The real reasons are **operational** (an MCP server +
transport + stateful bridge + per-harness config wiring vs. reusing the `gaia`
binary we already ship), **uniformity** (one CLI serves both codex and claude),
and **philosophy/consistency** (one mental model; pi rejects MCP).

### Chosen approach: `gaia` CLI subcommands + a read/write transport split

GAIA already ships a `gaia` CLI (`bin.gaia → dist/cli.js`; `src/cli.ts`,
currently `init` / `agent create`). Add memory/recall/summon as subcommands.
Key enabler: **memory and recall are file-backed** (`MemoryStore` reads/writes
files; `searchTranscript` reads `transcript.jsonl` + per-room `recall.db`), so a
short-lived subprocess can reuse the same core code with full parity (caps, 80%
nudge, secret-filter, FTS5) and **no in-process bridge**.

**Transport split (this is what makes read-only/plan/sandbox work cleanly):**
- **Reads** → direct disk, in the subprocess:
  - `gaia recall <query>` → `searchTranscript()`
  - `gaia mem read|list` → `MemoryStore`
  - Safe under any read-only sandbox.
- **Writes / stateful** → **localhost HTTP to the running daemon** (the web
  server in `src/web/server.ts`), so the subprocess never writes the filesystem
  and the **daemon is the single writer**:
  - `gaia mem add|replace|remove` → daemon → `MemoryStore.mutate()`
  - `gaia summon <agent> <task>` → daemon → `SummonManager`
  - This sidesteps Codex's read-only OS sandbox (which would block a subprocess
    from writing memory files), kills SQLite multi-writer concerns, and
    centralizes policy enforcement.

**Why summon must go through the daemon regardless:** `SummonManager`
(`src/app/summon-manager.ts`) holds live in-process state (running `runtimes`
Map, `maxRunningPerRoom`, `endWaiters`) and runs subagents in-process. A CLI
subprocess can't run/await a summon itself — it asks the daemon. (Pi keeps its
direct in-process `summonCreate` call; the CLI path is for codex/claude.)

### memory/recall must be DECOUPLED from the `bash` toggle

Because gaia/sidia have `memory`/`recall` but no `bash`, the harness must grant
the *narrow* capability when those toggles are on — NOT require the general
shell:
- logical `memory`/`recall` ON → Claude harness grants a **locked
  `Bash(gaia mem*)` / `Bash(gaia recall*)` permission** (implementation detail,
  invisible to the user), distinct from the logical `bash` tool.
- logical `bash` ON (terry) → general `Bash(*)`.
- A no-shell agent thus gets memory/recall and still can't run arbitrary
  commands. Verify Claude's permission matcher blocks chaining/injection
  (`gaia x && rm …`); the `gaia` binary itself only ever touches
  memory/recall/summon stores.

Context the daemon must pass when spawning a harness subprocess (env vars, so
the agent runs `gaia mem add …` with no path knowledge): `GAIA_MEMORY_DIR`,
`GAIA_ROOM_DIR`, `GAIA_ROOM_ID`, `GAIA_AGENT_ID`, plus a per-turn token/URL for
the daemon write-endpoint that maps to `(agentId, roomId)`.

### Progressive disclosure

System prompt carries a one-line pointer ("you have a `gaia` CLI for
memory/recall/summon; run `gaia mem --help`"). `gaia <cmd> --help` is the
README. Near-zero context until used.

### Optional later convergence

For literal surface-uniformity, Pi could *also* call the `gaia` CLI via its bash
tool and retire its in-process `defineTool` memory/recall — purest "same across
all harnesses" and exactly pi's philosophy. **Not now** (no regression; the
shared core already gives behavior uniformity). Treat as a future step.

### Recall prefetch (independent, cheap, optional)

Separately from agent-driven recall, the daemon can inject top-N recall hits for
the newest message into the turn prompt (the "inject" seam in `memory-plan.md`).
Helps every harness; not required for Phase 2 but low-risk value.

---

## 4. Cleanup — `runtime` vs `harness` field footgun

gaia/sidia/terry configs use `"runtime": "pi"`, but **nothing reads
`agent.runtime`** — the code only reads `agent.harness` (`registry.ts:163`
`normalizeHarness(raw.harness)`). They run Pi only because Pi is the default.
Once `claude` exists, `"runtime": "claude"` would silently fall back to Pi.
Fix: standardize on `harness` (migrate the seed configs) and/or accept `runtime`
as an alias in `normalizeHarness`/registry. Small, isolated, do early.

---

## 5. Suggested sequencing

1. **Cleanup (§4)** — quick, isolated; prevents silent fallbacks once claude is
   user-selectable.
2. **Phase 1.5 refactor (§2)** — config-driven translator + unhide `tools` +
   capability-mapping in `HARNESS_CONFIGS`. Tests for `buildArgs`.
3. **Phase 2 reads (§3)** — `gaia recall`, `gaia mem read|list` (pure disk, no
   daemon) + the narrow-grant wiring + env contract. Validate live.
4. **Phase 2 writes (§3)** — daemon write-endpoints + `gaia mem
   add|replace|remove`. Validate caps/secret-filter parity vs Pi.
5. **`gaia summon`** → daemon endpoint → `SummonManager`.
6. (Optional) recall prefetch; (optional) Pi → CLI convergence.

Consider applying the same config-driven translation to **Codex** so it honors
the per-agent `tools` array too (pre-existing gap) — at least for
memory/recall/summon, which it also lacks.

---

## 6. Key files

- `src/runtime/claude-runtime.ts` — the harness (refactor target).
- `src/runtime/codex-runtime.ts`, `src/runtime/pi-runtime.ts` — siblings;
  pi-runtime shows the in-process tool wiring (`createManagedSession`).
- `src/runtime/runtime-factory.ts` — harness switch.
- `src/runtime/prompt-assembly.ts` — `buildSystemPrompt` / `buildTurnPrompt`
  (memory injection lives here, harness-agnostic).
- `src/memory/memory-store.ts` (`MemoryStore.mutate`, `.promptBlock`),
  `src/memory/recall.ts` (`searchTranscript`) — the shared core the CLI reuses.
- `src/tools/{memory-tool,recall-tool,summon-tool}.ts` — Pi's `defineTool`
  versions (reference for the CLI surface + policy).
- `src/app/summon-manager.ts`, `src/room/summons.ts` — summon state (daemon).
- `src/app/settings-hints.ts` — `HARNESS_CONFIGS` registry (per-harness UI +
  capability declaration).
- `src/cli.ts` — where `gaia mem`/`gaia recall`/`gaia summon` subcommands go.
- `src/web/server.ts` — where the daemon write-endpoints go.
- `src/agents/{types,registry,scaffold}.ts`, `src/workspace/{types,workspace-loader}.ts`
  — harness field plumbing.
- Tests mirror `test/codex-runtime.test.ts` (injectable factory; no real CLI in
  CI). `npm run check`, `npm test`, `npm run build`.

## 7. Verification

Live smoke pattern (used for Phase 1): build a temp workspace + agent, construct
the runtime with the *real* factory, run two turns, assert model-info + memory
recall + `--resume` continuity. For Phase 2, additionally assert that a write
via `gaia mem add` is visible to a subsequent `MemoryStore.promptBlock` read and
that caps/secret-filtering match Pi. Treat `src/` as source of truth (a stale
`dist/` has existed before). User-facing verb for summon is "summon", never
"subagent". Default harness stays `pi`.
