# Handoff: Codex Harness — Phase 1 Done, Phase 2 (custom tools) Parked

Date: 2026-06-15. Continues `HANDOFF-SUMMONS-CODEX.md`. Read that for the broader summons/dual-harness picture; this file is the current Codex-harness state.

## TL;DR
- **Phase 1 (Codex streaming-turn harness) is DONE and live-validated.** A `harness: "codex"` agent runs real streaming turns on the user's ChatGPT subscription via `codex app-server`.
- **Suite: 111/111 green, `npm run check` clean, worktree clean.** Work is **UNCOMMITTED** (untracked files below).
- **Phase 2 (custom tools for Codex agents) is PARKED** by user decision. The original `dynamicTools` plan is dead; the path forward is **MCP**. Details below.

## What was built (Phase 1)
- `src/runtime/codex-runtime.ts` — `CodexRuntime implements AgentRuntime` + an internal `CodexAppServerClient` (spawns `codex app-server`, JSON-RPC 2.0 over newline-delimited JSON on stdio). Lazy-spawn on first `send()`. Mirrors `PiRuntime`'s constructor `(workspace, agent, memoryStore, _unused?, summonCreate?, clientFactory?)`. Has an **injectable `clientFactory`** for tests. `abort()` → `turn/interrupt`; `dispose()` → kill child.
- `src/runtime/runtime-factory.ts` — `case "codex"` now `return new CodexRuntime(...)` (the old throw is gone).
- `test/codex-runtime.test.ts` — mocked-frame event-mapping tests incl. a regression test "CodexRuntime ignores item/completed for non-tool items (userMessage, agentMessage)".
- `test/runtime-factory.test.ts` — updated so codex returns a `CodexRuntime` instead of throwing.

Untracked (not committed): `src/runtime/codex-runtime.ts`, `src/runtime/runtime-factory.ts`, `test/codex-runtime.test.ts`, `test/runtime-factory.test.ts`. (Plus the pre-existing summon work from the prior handoff.)

## VALIDATED app-server protocol (v0.139.0, ChatGPT-subscription) — do not rediscover
Captured from live `codex app-server` frames + shipped TS types at `/tmp/codex-ts-protocol/` (note `/tmp` may be cleared; regenerate via `codex app-server` if gone).
- Handshake: `initialize` (capabilities `{experimentalApi:false, requestAttestation:false}`) → response `{userAgent,codexHome,...}`; then `initialized` notification.
- `thread/start` params `{cwd, model, modelProvider, baseInstructions, ephemeral:false, sandbox:"read-only"}` → **threadId at `result.thread.id`** (+ `result.model`, `result.modelProvider`).
- `turn/start` params `{threadId, input:[{type:"text",text,text_elements:[]}], model}` → **turnId at `result.turn.id`**.
- **MODEL GOTCHA: `model:"gpt-5-codex"` is REJECTED on a ChatGPT-subscription account (400).** Send `model: null` → app-server uses `~/.codex/config.toml` default (`gpt-5.5`). ✅ CodexRuntime already does `model: agent.model?.name ?? null`.
- Streaming notifications: `item/agentMessage/delta {delta}` → text-delta; `item/reasoning/textDelta {itemId,delta}` → thinking; `item/started`/`item/completed` carry `{item:{type,...}}`; `turn/completed {turn:{status:"completed"|"failed", error?}}`; `error {error:{message}}`.
- **Success turn order:** item/started+completed `userMessage` → item/started `agentMessage` → `item/agentMessage/delta` → item/completed `agentMessage` → `turn/completed status=completed`.
- **Lots of ignorable noise:** `mcpServer/startupStatus/updated`, `remoteControl/*`, `warning`, `thread/status/changed`, `thread/started`, `turn/started`, `account/rateLimits/updated`. CodexRuntime ignores unknown methods (no default case) — keep it that way.
- **BUG already fixed (regression-tested):** `item/completed` fires for non-tool items too (`userMessage`, `agentMessage`). Only emit `tool-end` for `commandExecution|mcpToolCall|dynamicToolCall`, else you get spurious tool calls.

## Phase 2 verdict: custom tools must use MCP, NOT dynamicTools
Authoritative, from the shipped protocol types:
- **You CANNOT declare client-side custom tools to app-server 0.139.0.** `DynamicToolSpec {namespace?,name,description,inputSchema,deferLoading?}` exists but is referenced by NOTHING — `TurnStartParams`/`ThreadStartParams` have no tools field; there's no `tool/register` method in `ClientRequest`. `experimentalApi` is just a bool, not a tool gate.
- The server CAN invoke tools it already knows about: server→client REQUEST `item/tool/call` (params `DynamicToolCallParams {threadId,turnId,callId,namespace,tool,arguments}`); client replies `DynamicToolCallResponse {contentItems:[{type:"inputText",text}], success:boolean}`; lifecycle item type `dynamicToolCall {status:"inProgress"|"completed"|"failed"}`. But those tools come from Codex's apps/plugins/skills/**MCP** — not client injection.
- **Therefore:** give a Codex agent memory/recall/summon by running them as an **MCP server** registered in a per-agent `CODEX_HOME` `[mcp_servers]` config (confirmed working — the user's godot/codex_apps/node_repl MCP servers start per-thread). **In-process-state bridge needed:** GAIA's tools are stateful (touch live `MemoryStore`/`SummonManager`/transcript DB), but an MCP server is a separate process — so the stdio MCP server must forward tool calls back into GAIA's running process (local socket/RPC). Also isolate Codex under a dedicated `CODEX_HOME` to avoid the single-use refresh-token clash with the user's interactive Codex CLI.

## Remaining work (priority order)
1. **Phase 2 MCP tool-bridge** (above) — when the user wants it. Design first; it has real in-process-state-forwarding design risk.
2. **Summon REST route tests** — DeepSeek stalled on this. Feasibility IS positive: test at the **handler/`SummonManager` seam**, not by booting the full server (`summon-manager.ts` imports `AgentRuntime` only as a *type*, so it does NOT pull in the `@mariozechner/pi-coding-agent` package that broke prior server smoke-tests). **WARNING:** a prior attempt left a file whose mock runtime used `while(!this.aborted) await sleep(10)` and never aborted → it HUNG `npm test` forever. Any mock runtime in tests MUST complete/abort cleanly.
3. Browser-test the summon drawer with a live summon.
4. Agent-tool summon semantics: `publish` is accepted-but-ignored; tool waits by polling up to 5 min; consider event-based completion.
5. Optional: `summon-snapshot` SSE on reconnect; persisted cancellation.

## Verify
`npm run check` (tsc) and `timeout 120 npm test` (tsx --test) → 111/111 pass.