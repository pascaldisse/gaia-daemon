# Plan: Codex + Pi Summons Without MCP

Date: 2026-06-15

## Decision

Do not implement MCP yet.

Use this simpler split:

- Codex is a visible GAIA agent harness.
- Codex uses its own Codex session/tool/memory behavior, plus GAIA prompt context.
- Pi remains the primary private worker backend for summons.
- GAIA owns the room UI, transcript, summon lifecycle, persistence, and streaming events.
- GAIA custom tools for Codex agents are deferred. If Codex later needs first-class `gaia_memory`, `gaia_recall`, or `gaia_summon` tools, revisit MCP with an IPC bridge design.

## Current Facts

- `src/runtime/codex-runtime.ts` already implements a real Codex streaming harness over `codex app-server`.
- `src/runtime/runtime-factory.ts` already dispatches `harness: "pi" | "codex"`.
- `src/app/gaia-controller.ts` is the app-side room orchestrator and owns the runtime map plus `SummonManager`.
- `src/app/summon-manager.ts` already runs private summons asynchronously, persists events/results, and emits summon UI events.
- `src/tools/summon-tool.ts` exposes summons to Pi agents as a custom Pi tool.
- CodexRuntime already maps Codex command/MCP tool lifecycle events into GAIA runtime details for UI display.
- CodexRuntime injects GAIA memory prompt content into Codex turns, but Codex cannot write GAIA memory or call GAIA recall/summon as first-class tools without MCP or a hacky alternate bridge.

## Product Model

Room agents:

- Can be Pi-backed or Codex-backed.
- Are visible in the shared GAIA room.
- Write normal room-visible replies.

Summons:

- Are private worker sessions.
- Are visible in the summon list/drawer.
- Stream their private model/thinking/tool events to the drawer.
- Do not inject private summon transcripts into the shared room by default.
- Should use Pi by default unless an agent is explicitly configured with `harness: "codex"`.

## Near-Term Architecture

```text
Frontend
  -> GaiaWebServer / SSE / REST
    -> GaiaController
      -> Room transcript and room state
      -> PiRuntime agents
      -> CodexRuntime agents
      -> SummonManager
        -> Pi-backed private workers by default
```

No MCP is required for:

- Showing Codex agents in the room.
- Running Codex agents as `/summon` targets.
- Showing Codex streamed text, thinking, command events, or MCP events that Codex itself invokes.
- Running Pi-backed private summons from `/summon` or from Pi agents.

MCP is only required later if:

- Codex agents must call GAIA-owned tools directly, such as `gaia_summon`, `gaia_recall`, or writable `gaia_memory`.

## Implementation Milestones

### Milestone 1: Stabilize Current Worktree

Goal: preserve the already-working summon and Codex harness work before more architecture changes.

Tasks:

- Review dirty/untracked files and make sure they all belong to the summon/Codex harness work.
- Run `npm run check`, `npm test`, and `npm run build`.
- Commit or otherwise checkpoint the current working tree before deeper changes.

Acceptance:

- Test suite passes.
- No unrelated files are mixed into the checkpoint.
- Handoff docs stay accurate.

### Milestone 2: Codex Harness Hardening, No MCP

Goal: make Codex reliable as a visible GAIA room/summon agent without custom GAIA tools.

Tasks:

- Add a clear preflight/error path when `codex app-server` is unavailable or fails to initialize.
- Decide whether Codex sandbox should remain `read-only` or become configurable per workspace/agent.
- Key Codex app-server thread state by `roomId` so one Codex runtime does not accidentally reuse a thread across rooms later.
- Add a small docs/example snippet for configuring an agent with `harness: "codex"`.

Acceptance:

- Existing Codex runtime tests still pass.
- A Codex agent can answer a room mention.
- A Codex agent can run as a manually launched summon.
- Failure when Codex is unavailable is user-readable.

### Milestone 3: Pi-Backed Summon Hardening

Goal: make Pi summons the dependable worker path.

Tasks:

- Add a recursion/concurrency guard so agents cannot create unbounded summon chains.
- Replace or wrap the current `runSummonAndWait` polling with event-driven completion, keeping a timeout as a safety net.
- Decide and document summon context scope: empty private task only vs. selected room context summary.
- Add a route-level or controller-level test for summon REST/list/details behavior.
- Browser smoke-test the summon drawer with a live summon.

Acceptance:

- `/summon <agent> <task>` creates a visible summon and returns quickly.
- Summon drawer streams live progress and shows the final result.
- Pi agent `summon` tool still returns a result to the parent agent.
- Long-running summons do not create unbounded nested workers.

### Milestone 4: Product Semantics

Goal: make summon behavior obvious and consistent.

Tasks:

- Decide what `publish: "summary" | "full"` should do, or remove it until implemented.
- Decide whether agent-triggered summons should block the parent turn or return a summon id immediately.
- Decide if user-launched summons should be parentless or attached to the default orchestrator.
- Add user-facing help text that says summons are private and not inserted into the room transcript by default.

Acceptance:

- Slash command help matches actual behavior.
- Tool descriptions match actual behavior.
- No unused option implies behavior that does not exist.

## Deferred MCP Track

Do not build this in the current slice.

If later needed, the likely design is:

```text
Codex app-server
  -> MCP stdio bridge
    -> local GAIA daemon IPC
      -> live MemoryStore / Recall / SummonManager
```

That track should start with one low-risk tool, probably read-only memory or recall, not summon.

## Pi Planning Agents Launched

- `pi-1781535899428-65587`: Codex as visible agent without MCP.
- `pi-1781535899428-65588`: Pi-backed summons as primary worker path.
- `pi-1781535899428-65589`: architecture review and milestone risks.

Their useful conclusions are folded into this plan. One reported a Codex memory prompt gap, but current source shows `CodexRuntime` does call `memoryStore.promptBlock()` during turn prompt assembly; the remaining Codex gap is writable/callable GAIA tools, not read-only prompt memory.

## Implementation Update: 2026-06-15

Completed the first no-MCP hardening slice:

- `CodexRuntime` now keeps persistent Codex app-server threads scoped by `roomId` instead of one global thread per runtime.
- `CodexRuntime` now reports a clearer startup error when `codex app-server` is unavailable or the `codex` CLI is missing.
- `SummonManager` now has a per-room running-summon cap, defaulting to 3, to prevent runaway worker fan-out.
- `SummonManager` now exposes event-driven `waitForEnd(...)`.
- `GaiaController.runSummonAndWait(...)` now waits on summon completion events instead of polling every 500ms.
- Focused tests were added for room-scoped Codex threads, Codex startup failure messaging, summon completion waiting, and summon concurrency limiting.

Verification after this slice:

```bash
npx tsx --test test/codex-runtime.test.ts
npx tsx --test test/summon-manager.test.ts test/gaia-controller.test.ts test/pi-runtime.test.ts
npm run check
npm test
npm run build
```

Results:

- `npm run check`: PASS
- `npm test`: PASS, 114/114 tests
- `npm run build`: PASS
