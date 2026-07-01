# REPLACEMENT.md — can GAIA fully replace Claude Code, Codex, pi, and Hermes?

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
| MCP servers | a+b (`--mcp-config`) | a+b (`[mcp_servers]`) | ✗ core (adapter pkg) | a | ❌ not exposed | **gap (b)** — one settings surface, mapped per harness as spec data |
| Hooks | a+b (30 events) | a+b (now stable) | b (extension events) | ✗ | ❌ not exposed | gap (b/c) — a uniform gaia hook schema translated per harness |
| Checkpoints / rewind | a-TUI only (not headless) | a (`thread/rollback` IS headless) | ✗ | ✗ | partial: transcript is append-only, `/clear`+fork exist | gap (c) — room-level rewind fits the WAL protocol naturally |
| Mid-turn steering | ✗ headless | a (`turn/steer`) | a (SDK `steer`) | ✗ | ❌ | gap (b) — worth one uniform "steer" capability flag |
| Scheduling / proactive runs | cloud-tied | ✗ | ✗ | **a — first-class local cron** | ❌ | **gap (c), the only row where no harness helps.** Hermes's design (60s tick, fresh isolated session per job, output chaining, deliver-to-room) maps 1:1 onto rooms + summons + sandbox/trust. |
| Web search / browser | a | a | ✗ (bash/skills) | a | free where the harness has it | expose as capability data later |
| Skills / slash commands | a+b | a+b | a+b | a | ✅ skills dir + registry commands | done |
| Structured output / budgets (headless) | a (`--json-schema`, `--max-budget-usd`) | a (`--output-schema`) | a (rpc) | — | ❌ | nice-to-have (b) |

## What this says

**GAIA is already the only tool on the board that does persistent multi-agent
rooms, cross-harness summon swarms, routing, and crash-proof turn durability.**
Nothing in the matrix requires copying a competitor; the moat is real. To
*fully replace* daily use of all four, the honest gap list is short:

1. **Memory v3** (in progress, this branch) — after it lands, GAIA memory
   strictly dominates all four harnesses' built-ins: budgeted core (all have),
   hybrid lexical+semantic recall (none have), bi-temporal facts (none),
   outcome-grounded episodes + consolidation (Hermes has a weaker,
   complexity-triggered version).
2. **Scheduler** — Hermes is the only one with real local cron, and it's the
   feature that makes an agent *proactive*. Design: a `schedules.json` per
   workspace, 60s tick in the daemon, each job = a normal room message (or
   summon) under the existing sandbox/trust — no new security surface,
   consistent with the no-approval-gating rule. This is the next big build
   after memory v3.
3. **MCP exposure** — one `mcpServers` section in workspace/agent settings;
   each harness declares *how* it consumes MCP config as data on its spec
   (Claude: `--mcp-config` JSON; Codex: `-c mcp_servers.*` overrides; pi:
   adapter extension). Uniform surface, zero shared-code branches.
4. **Codex parity wiring** — the app-server already offers what we haven't
   consumed: `dynamicTools` + `item/tool/call` (gives Codex real
   recall/summon, closing the last capabilities asymmetry), `thread/resume`
   (room-coupled sessions), `turn/steer`, `thread/rollback`, per-thread
   `permissions`.
5. **Uniform hooks** (later) — a small gaia hook schema (pre-tool, post-turn,
   session-start) translated per harness: Claude/Codex native hooks, pi
   extension events.
6. **Housekeeping** — migrate the pi SDK to its new npm scope
   (`@earendil-works/pi-coding-agent`; old scope frozen at 0.73.1, API names
   unchanged).

Everything else in the matrix is either already done, free by spawning, or
deliberately rejected (per-harness approval popups — the sandbox is the
boundary).

## Priority order

memory v3 → scheduler → Codex dynamicTools/resume → MCP exposure → steer +
rollback → hooks → pi scope migration (safe anytime).
