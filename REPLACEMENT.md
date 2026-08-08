# REPLACEMENT.md — can GAIA fully replace Claude Code, Codex, pi, and Hermes?

> **STATUS 2026-07-02: the priority list below is fully SHIPPED.** Memory v3,
> the scheduler, Codex dynamicTools + thread/resume (+ uniform session
> persistence for claude), MCP exposure, /steer + /rewind, room-layer hooks,
> and the pi scope migration are all on branch v2 (commits c9226d1..231561d).
> The matrix rows and gap list are kept as written for the historical
> analysis; per-row updates are marked ✅ SHIPPED inline.

Research date 2026-07-01, verified against the locally installed binaries
(claude 2.1.198, codex 0.142.2, pi 0.79.10, hermes-agent v0.18.0 docs). The
question is not "reimplement them" — GAIA spawns them as harnesses, so every
capability inherent to the *process* comes free. The real work splits three
ways:

- **(a) free by spawning** — the harness does it inside its own turn; nothing
  for GAIA to build.
- **(b) settings exposure** — the capability exists behind a flag/config key;
  GAIA must surface it uniformly (as DATA on the HarnessSpec, never an
  `if (harness === …)` branch).
- **(c) GAIA must own it** — cross-harness or cross-session semantics no
  single harness can provide.

## The matrix

| Capability | Claude Code | Codex CLI | pi | Hermes | GAIA today | Verdict |
|---|---|---|---|---|---|---|
| Agentic coding turn (read/edit/bash/grep) | a | a | a | a | ✅ free | done |
| Model + thinking control | a+b | a+b | a+b | a | ✅ settings (`model`, `thinking`, hints) | done |
| Session resume / continuity | a | a | a | a | ✅ SessionMap + WAL turn protocol (stronger: survives daemon crash) | done |
| Sandboxing | a (seatbelt) | a (seatbelt/bwrap) | ✗ by design | partial | ✅ GAIA-owned Seatbelt + trust tiers, uniform (c) | done, deliberately ours |
| Permission modes | a+b (6 modes) | a+b (approvalPolicy) | ✗ by design | partial | ✅ `permissionMode` as capability-gated data | done for Claude; Codex `approvalPolicy`/`permissions` per-thread = gap (b) |
| Memory | a (CLAUDE.md + auto-memory) | a (new `[memories]`) | b (context files only) | a (MEMORY.md/USER.md + FTS) | ✅ GAIA-owned, uniform (c) — correct call; harness memory is stripped (`--safe-mode`) so rooms stay the source of truth | **memory v3 (in progress) makes ours strictly stronger than all four** (hybrid semantic recall, bi-temporal facts, outcome-grounded episodes, consolidation) |
| Full-history recall | partial (conversation_search) | ✗ | ✗ | a (FTS5, keyword-only) | ✅ FTS5 → **hybrid in v3** | v3 exceeds Hermes |
| Subagents / parallel work | a+b (teams) | experimental | ✗ ("spawn pi via tmux") | a (MoA) | ✅ summons + whale swarms + monad routing (c) | done — ours is cross-harness, theirs isn't |
| Multi-agent persistent rooms | ✗ | ✗ | ✗ | channels ≠ rooms | ✅ the core product | GAIA-only |
| MCP servers | a+b (`--mcp-config`) | a+b (`[mcp_servers]`) | ✗ core (adapter pkg) | a | ✅ SHIPPED: `mcpServers` in config.json/agent.json, translated per harness (claude --mcp-config, codex mcp_servers overrides, pi hidden via supportsMcp) | done |
| Hooks | a+b (30 events) | a+b (now stable) | b (extension events) | ✗ | ✅ SHIPPED: observer hooks at the ROOM layer (preTurn/postTurn/toolUse/error) — uniform by construction, no per-harness translation | done |
| Checkpoints / rewind | a-TUI only (not headless) | a (`thread/rollback` IS headless) | ✗ | ✗ | ✅ SHIPPED: `/rewind [n]` — transcript truncate + cursor/session reset on the WAL protocol, identical for every harness | done |
| Mid-turn steering | ✗ headless | a (`turn/steer`) | a (SDK `steer`) | ✗ | ✅ SHIPPED: `/steer` via capabilities.supportsSteer (pi session.steer, codex turn/steer; claude declines) | done |
| Scheduling / proactive runs | cloud-tied | ✗ | ✗ | **a — first-class local cron** | ✅ SHIPPED: schedules.json + 60s daemon tick, isolated/in-room runs under sandbox/trust, output chaining, crash recovery, `/schedule` | done |
| Web search / browser | a | a | ✗ (bash/skills) | a | free where the harness has it | expose as capability data later |
| Skills / slash commands | a+b | a+b | a+b | a | ✅ skills dir + registry commands | done |
| Structured output / budgets (headless) | a (`--json-schema`, `--max-budget-usd`) | a (`--output-schema`) | a (rpc) | — | ❌ | nice-to-have (b) |

## What this says

**GAIA is already the only tool on the board that does persistent multi-agent
rooms, cross-harness summon swarms, routing, and crash-proof turn durability.**
Nothing in the matrix requires copying a competitor; the moat is real. To
*fully replace* daily use of all four, the honest gap list is short:

1. **Memory v3** (✅ shipped, c9226d1) — GAIA memory
   strictly dominates all four harnesses' built-ins: budgeted core (all have),
   hybrid lexical+semantic recall (none have), bi-temporal facts (none),
   outcome-grounded episodes + consolidation (Hermes has a weaker,
   complexity-triggered version).
2. **Scheduler** (✅ shipped, fd6e11d) — Hermes is the only one with real local
   cron, and it's the feature that makes an agent *proactive*. As designed: a
   `schedules.json` per workspace, 60s tick in the daemon, each job = a normal
   room message (or summon) under the existing sandbox/trust — no new security
   surface, consistent with the no-approval-gating rule.
3. **MCP exposure** (✅ shipped, f56ed67) — one `mcpServers` section in
   workspace/agent settings; each harness declares *how* it consumes MCP
   config as data on its spec (Claude: `--mcp-config` JSON; Codex:
   `mcp_servers` overrides; pi: hidden via `supportsMcp: false`). Uniform
   surface, zero shared-code branches.
4. **Codex parity wiring** (✅ shipped, 0234ced + da63191) — consumed
   `dynamicTools` + `item/tool/call` (Codex gets real recall/summon, closing
   the last capabilities asymmetry), `thread/resume` (room-coupled sessions),
   and `turn/steer`. Deliberately NOT consumed: `thread/rollback` (GAIA's
   `/rewind` is the uniform room-level mechanism) and per-thread
   `permissions`/`approvalPolicy` (the GAIA sandbox is the boundary; still
   open as data-exposure if ever wanted).
5. **Uniform hooks** (✅ shipped, a6587aa) — implemented at the ROOM layer
   (preTurn/postTurn/toolUse/error observer hooks) instead of per-harness
   translation: uniform by construction.
6. **Housekeeping** (✅ shipped, 231561d) — pi SDK migrated to
   `@earendil-works/*` 0.80.3 (old scope frozen at 0.73.1; only drift:
   `completeSimple` moved to `pi-ai/compat`).

Everything else in the matrix is either already done, free by spawning, or
deliberately rejected (per-harness approval popups — the sandbox is the
boundary). Still deliberately open: headless structured output / budget flags
(matrix row ❌, nice-to-have) and exposing web-search/browser availability as
capability data.

## Priority order

memory v3 → scheduler → Codex dynamicTools/resume → MCP exposure → steer +
rollback → hooks → pi scope migration (safe anytime).

**All seven shipped (2026-07-02, branch v2):**
1. memory v3 — c9226d1
2. scheduler — fd6e11d
3. Codex dynamicTools + thread/resume (+ claude session persistence) — 0234ced
4. MCP exposure — f56ed67
5. /steer + /rewind — da63191
6. room-layer hooks — a6587aa
7. pi scope migration (@earendil-works 0.80.3) — 231561d

**Post-ship exposure sweep (same day):** every parsed setting now has a
settings-UI hint (hooks, mcpServers, sandbox.*, trust, allowNestedSummon,
maxSummonsPerRoom, consolidate model, voice unmute, schedule/prompt fields),
and two commands closed the last command gaps: `/cancel` (alias `/stop`,
panic-stops the running turn + queue from any client) and `/recall [@agent]
<query>` (user-facing search over the memory index).
