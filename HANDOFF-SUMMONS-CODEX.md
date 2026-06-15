# Handoff: GAIA Daemon Summons + Codex Harness

Date: 2026-06-15

## Goal

Expand GAIA Daemon into the workflow Pascal wants:

- A main shared room with multiple visible room agents, e.g. `@gaia`, `@sidia`, `@terry`.
- Room agents share one room transcript and can talk to each other.
- A main orchestrator agent can summon private worker subagents for heavier work.
- The user can also manually launch a worker with `/summon <agent-name> <task>`.
- Running summoned subagents must be visible and clickable.
- Clicking a running summon opens that summon's private session live, including streaming text, thinking, tool calls, status, and final result.
- Private summon context must not be injected into the shared room transcript by default. The parent/orchestrator decides what summary becomes room-visible.
- GAIA should support both Pi and Codex as agent harnesses.

Use the word **summon** in product/UI/commands, not "subagent" as the user-facing verb.

## New Pi Skill To Use

We created a local Codex skill for cheap delegated Pi work:

- [Pi skill instructions](/Users/pascaldisse/.codex/skills/pi/SKILL.md)
- [pi-agent wrapper](/Users/pascaldisse/.codex/skills/pi/scripts/pi-agent)
- [pi-agent implementation](/Users/pascaldisse/.codex/skills/pi/scripts/pi-agent.mjs)
- [Pi orchestrator prompt](/Users/pascaldisse/.codex/skills/pi/codex-orchestrator.md)

Skill repo:

```text
/Users/pascaldisse/.codex/skills/pi
commit 6bd259b Add RPC-backed Pi agent manager
```

The public interface is `pi-agent`:

```bash
~/.codex/skills/pi/scripts/pi-agent launch "task"
~/.codex/skills/pi/scripts/pi-agent status <id>
~/.codex/skills/pi/scripts/pi-agent steer <id> "correction"
~/.codex/skills/pi/scripts/pi-agent prompt <id> "next task in same session"
~/.codex/skills/pi/scripts/pi-agent followup <id> "queued follow-up"
~/.codex/skills/pi/scripts/pi-agent result --wait <id>
~/.codex/skills/pi/scripts/pi-agent logs <id> 40
~/.codex/skills/pi/scripts/pi-agent stop <id>
~/.codex/skills/pi/scripts/pi-agent list
```

It hides Pi RPC JSON and gives compact status/result/log access. Use it aggressively for repo mapping, implementation plans, and test loops.

## Current GAIA Architecture

Important source paths:

- [Agent runtime interface](/Users/pascaldisse/projects/gaia-daemon/src/runtime/types.ts)
- [Pi runtime](/Users/pascaldisse/projects/gaia-daemon/src/runtime/pi-runtime.ts)
- [GAIA controller](/Users/pascaldisse/projects/gaia-daemon/src/app/gaia-controller.ts)
- [Turn runner](/Users/pascaldisse/projects/gaia-daemon/src/app/turn-runner.ts)
- [Prompt assembly](/Users/pascaldisse/projects/gaia-daemon/src/runtime/prompt-assembly.ts)
- [Agent definition type](/Users/pascaldisse/projects/gaia-daemon/src/agents/types.ts)
- [Agent registry](/Users/pascaldisse/projects/gaia-daemon/src/agents/registry.ts)
- [Workspace config type](/Users/pascaldisse/projects/gaia-daemon/src/workspace/types.ts)
- [Room state](/Users/pascaldisse/projects/gaia-daemon/src/room/state.ts)
- [Transcript storage](/Users/pascaldisse/projects/gaia-daemon/src/room/transcript.ts)
- [Web server/SSE](/Users/pascaldisse/projects/gaia-daemon/src/web/server.ts)
- [Frontend SSE handling](/Users/pascaldisse/projects/gaia-daemon/web/src/events.ts)
- [Room panel rendering](/Users/pascaldisse/projects/gaia-daemon/web/src/render.ts)
- [Slash command parsing](/Users/pascaldisse/projects/gaia-daemon/src/app/commands.ts)

Current facts:

- `AgentRuntime` is already the key harness abstraction.
- `GaiaController` accepts a test-only `runtimeFactory`, but production currently falls back directly to `new PiRuntime(...)`.
- `PiRuntime` uses Pi SDK sessions, one persistent session per room-agent pair under `.gaia/rooms/<room>/pi-sessions/<agentId>/`.
- The shared room is a JSONL transcript plus per-agent cursors. This is already a good model for visible room agents.
- Streaming model/thinking/tool events already travel through `AgentEvent` -> `GaiaUiEvent` -> SSE -> frontend transcript.
- The room panel already shows agents and tasks. This is the natural place to show running summons.
- `dist/runtime/runtime-factory.js` exists and references `agent.runtime || workspace.config.runtime`, but there is no current source file. Treat `src/` as source of truth and recreate a real factory there.

Verification done before handoff:

```bash
npm run check
```

Result: passed.

Repo status before writing this file was clean.

## Proposed Product Model

There are two layers:

1. **Room agents**
   - Named peers in the shared room.
   - They read/write the room transcript.
   - They can talk to each other through `@agent` mentions.

2. **Summons**
   - Private worker sessions launched by a user command or an agent tool.
   - They have their own session context and event log.
   - They show live progress to the user.
   - They do not automatically write their full transcript into the room.
   - Their final summary/result can be returned to the parent agent or explicitly published.

User command:

```text
/summon <agent-name> <task>
```

Examples:

```text
/summon scout map the Codex harness integration points
/summon reviewer inspect the runtime factory plan for weak assumptions
```

Agent tool:

```ts
summon({
  agent: "scout",
  task: "Map the CodexRuntime integration points with file:line evidence",
  visibility: "private",
  publish: "summary"
})
```

## Proposed Data Model

Add summon persistence under the room:

```text
.gaia/rooms/<room>/summons/<summon-id>/
  session.json
  events.jsonl
  result.md
```

Suggested TypeScript shape:

```ts
export interface SummonSession {
  id: string;
  roomId: string;
  parentTaskId?: string;
  parentAgentId?: string;
  agentId: string;
  harness: "pi" | "codex";
  prompt: string;
  status: "running" | "complete" | "error" | "cancelled";
  startedAt: string;
  endedAt?: string;
  summary?: string;
  logPath: string;
}

export type SummonEvent =
  | { type: "model-info"; provider: string; modelId: string; subscription?: boolean }
  | { type: "text-delta"; delta: string }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; delta: string }
  | { type: "thinking-end"; content?: string }
  | { type: "tool-start"; toolName: string; toolCallId?: string; args?: unknown }
  | { type: "tool-update"; toolName: string; toolCallId?: string; partialResult?: unknown }
  | { type: "tool-end"; toolName: string; toolCallId?: string; result?: unknown; isError: boolean }
  | { type: "end"; status: "complete" | "error" | "cancelled"; error?: string };
```

This mirrors the existing `AgentEvent` stream so the frontend can reuse much of the transcript/tool rendering logic.

## API And SSE

Add REST endpoints:

```text
GET  /api/workspaces/:wid/rooms/:rid/summons
GET  /api/workspaces/:wid/rooms/:rid/summons/:sid
POST /api/workspaces/:wid/rooms/:rid/summons
POST /api/workspaces/:wid/rooms/:rid/summons/:sid/cancel
```

Extend SSE with:

```text
summon-start
summon-event
summon-end
summon-snapshot
```

Payloads should include `workspaceId`, `roomId`, `summonId`, `agentId`, `parentTaskId?`, `parentAgentId?`.

The main room transcript should only get a compact marker if desired, e.g. a system-style room event:

```text
@gaia summoned @scout: Map Codex harness integration points
```

Do not append the summon transcript to `transcript.jsonl`.

## UI

Use the word "summons".

Add to the room panel near tasks:

```text
summons
  running  @scout  Map Codex harness integration points
  complete @reviewer Review factory design
```

Click a summon row to open a drawer/modal:

- Header: agent, status, parent agent/task, harness, elapsed time.
- Live transcript: assistant text, thinking, tools.
- Controls: steer/follow-up may be later; first pass can support cancel and close.
- Result: final summary/result at bottom.
- Link/log path for debugging.

Frontend extension points:

- [web/src/state.ts](/Users/pascaldisse/projects/gaia-daemon/web/src/state.ts): add `summons`, `selectedSummonId`, `selectedSummon`.
- [web/src/events.ts](/Users/pascaldisse/projects/gaia-daemon/web/src/events.ts): handle `summon-start`, `summon-event`, `summon-end`.
- [web/src/render.ts](/Users/pascaldisse/projects/gaia-daemon/web/src/render.ts): render summon list and drawer.
- [web/src/api.ts](/Users/pascaldisse/projects/gaia-daemon/web/src/api.ts): add summon endpoints.

## Harness Support

Add a real runtime factory in source:

```text
src/runtime/runtime-factory.ts
```

Suggested shape:

```ts
export type AgentHarness = "pi" | "codex";

export function createAgentRuntime(options: {
  workspace: Workspace;
  agent: AgentDefinition;
  memoryStore: MemoryStore;
}): AgentRuntime {
  const harness = options.agent.harness ?? options.workspace.config.harness ?? "pi";
  switch (harness) {
    case "pi":
      return new PiRuntime(options.workspace, options.agent, options.memoryStore);
    case "codex":
      return new CodexRuntime(options.workspace, options.agent, options.memoryStore);
    default:
      throw new Error(`Unsupported harness: ${harness}`);
  }
}
```

Then update `GaiaController` so production uses the factory instead of directly constructing `PiRuntime`.

Add config:

- `AgentDefinition.harness?: "pi" | "codex"`
- `WorkspaceConfig.harness?: "pi" | "codex"`

Keep default as Pi to preserve behavior.

Codex harness should implement `AgentRuntime`:

```text
src/runtime/codex-runtime.ts
```

It should reuse `buildSystemPrompt` and `buildTurnPrompt`, and map Codex subprocess/JSON events into the existing `AgentEvent` stream.

## Summon Runtime Shape

Implement a `SummonManager` owned by `GaiaController` or `GaiaWebServer`.

Recommended first pass:

```text
src/app/summon-manager.ts
src/room/summons.ts
```

Responsibilities:

- Create summon ids and directories.
- Build summon prompt/context.
- Instantiate a runtime for the summoned agent using the same runtime factory.
- Stream runtime events into `events.jsonl`.
- Broadcast `summon-*` SSE events.
- Store final result in `result.md`.
- Track status in `session.json`.
- Support cancel.

Important privacy boundary:

- Parent room agent can receive the final summon result as a tool result.
- UI can inspect the private summon session.
- Other room agents should not see the summon transcript unless the parent publishes a summary into the room.

## Slash Command Plan

Update [src/app/commands.ts](/Users/pascaldisse/projects/gaia-daemon/src/app/commands.ts):

- Add `summon` to `SlashCommandType`.
- Parse `/summon <agent> <task>`.
- Include in `SLASH_COMMANDS`.
- Help text should say "summon a private worker agent".

Update `GaiaController.runCommandTask` path to call `SummonManager.create(...)`.

Open question for implementation:

- Should `/summon scout task` run as user-owned with no parent agent?
- Or should it default parent to current/default orchestrator agent?

Suggestion: user-launched summons should be `parentAgentId: undefined` but still visible in the room's summons list. Agent-launched summons get `parentAgentId`.

## Agent Tool Plan

For Pi agents, add a GAIA custom tool named `summon` alongside `memory` and `recall`.

Current custom tool creation is in [src/runtime/pi-runtime.ts](/Users/pascaldisse/projects/gaia-daemon/src/runtime/pi-runtime.ts), where `memory` and `recall` are appended based on `agent.tools`.

Create:

```text
src/tools/summon-tool.ts
```

Tool behavior:

- Parameters: `agent`, `task`, optional `publish`.
- Calls `SummonManager.create`.
- Either waits for completion and returns summary, or returns id immediately and lets parent check later.

Recommendation:

- Start with wait-for-completion for agent tool calls. It gives the parent a normal tool result.
- UI still sees the summon in real time while it runs.
- Add async/background summon semantics later if needed.

## Implementation Order

1. Add `harness` fields and real runtime factory.
2. Add skeleton `CodexRuntime` behind the factory, even if initially basic.
3. Add summon persistence model under `.gaia/rooms/<room>/summons/`.
4. Add `SummonManager` that can run a summon with an existing `AgentRuntime`.
5. Add `/summon <agent> <task>`.
6. Add SSE events for summon lifecycle.
7. Add frontend summon list and clickable live drawer.
8. Add Pi `summon` tool for orchestrator agents.
9. Add Codex support for summon tool if/when Codex tool integration is ready.

## Notes From Analysis

Pi analysis jobs used:

```text
backend architecture: pi-1781515903110-27205
UI workflow:         pi-1781515903110-27213
harness plan:        pi-1781515903110-27212
focused summon UI:   pi-1781516065183-27504 (stopped after taking too long)
```

The finished Pi outputs are stored under:

```text
/Users/pascaldisse/.codex/pi-agent/
```

The focused summon UI job was stopped after accepting a steer but not returning promptly; do not rely on it as a source of truth.

## Current Repo State

Before this handoff file:

- `gaia-daemon` worktree was clean.
- No implementation edits were made during analysis.
- `npm run check` passed.

After this handoff file:

- One documentation file was added: `HANDOFF-SUMMONS-CODEX.md`.

---

## Codex Continuation Update: 2026-06-15

This section reflects the implementation work done after the original handoff.

### Implemented

- Added harness config fields:
  - `AgentDefinition.harness?: "pi" | "codex"` in `src/agents/types.ts`
  - `WorkspaceConfig.harness?: "pi" | "codex"` in `src/workspace/types.ts`
- Added `src/runtime/runtime-factory.ts`.
  - Defaults to Pi.
  - `harness: "codex"` fails fast with a clear error.
  - No fake `CodexRuntime` placeholder is present.
- Added summon persistence:
  - `src/room/summons.ts`
  - `.gaia/rooms/<room>/summons/<summon-id>/session.json`
  - `.gaia/rooms/<room>/summons/<summon-id>/events.jsonl`
  - `.gaia/rooms/<room>/summons/<summon-id>/result.md`
- Added summon orchestration:
  - `src/app/summon-manager.ts`
  - Private runtime sessions are launched asynchronously.
  - Runtime events are persisted and emitted as `summon-start`, `summon-event`, and `summon-end`.
  - Summon transcript is not appended to the room transcript.
- Added `/summon <agent> <task>`:
  - Parser updates in `src/app/commands.ts`
  - Controller route in `src/app/gaia-controller.ts`
  - User-visible room transcript gets only a compact system marker.
- Added REST API routes in `src/web/server.ts`:
  - `GET /api/workspaces/:wid/rooms/:rid/summons`
  - `GET /api/workspaces/:wid/rooms/:rid/summons/:sid`
  - `POST /api/workspaces/:wid/rooms/:rid/summons`
  - `POST /api/workspaces/:wid/rooms/:rid/summons/:sid/cancel`
- Added frontend summon UI:
  - State in `web/src/state.ts`
  - API helpers in `web/src/api.ts`
  - SSE handlers in `web/src/events.ts`
  - Room-panel summon list and drawer in `web/src/render.ts`
  - Drawer/list styling in `web/src/styles.css`
- Added Pi agent `summon` tool:
  - `src/tools/summon-tool.ts`
  - `src/runtime/pi-runtime.ts` adds the tool when an agent has `"summon"` in `agent.tools`.
  - `src/app/gaia-controller.ts` bridges the tool via `runSummonAndWait`, polling up to 5 minutes and returning the summon summary.
  - Tool accepts `{ agent, task, publish? }`; `publish` is accepted but unused in this first pass.

### Verification

Final verification commands run:

```bash
npm run check
npm test
npm run build
node --check web/src/api.ts
node --check web/src/events.ts
node --check web/src/render.ts
node --check web/src/state.ts
```

Results:

- `npm run check`: PASS
- `npm test`: PASS, 100 tests
- `npm run build`: PASS
- Frontend changed-file syntax checks: PASS

One attempted read-only server smoke via `npx tsx -e` did not reach the new summon route because importing the server through that path hit an existing `@mariozechner/pi-coding-agent` package export/runtime issue. Normal `npm run check`, `npm test`, and `npm run build` passed, so this was not pursued in this slice.

### Current Dirty Worktree

Expected changed/untracked files after this continuation:

```text
M  src/agents/types.ts
M  src/app/commands.ts
M  src/app/gaia-controller.ts
M  src/runtime/pi-runtime.ts
M  src/web/server.ts
M  src/workspace/types.ts
M  test/commands.test.ts
M  test/gaia-controller.test.ts
M  test/pi-runtime.test.ts
M  web/src/api.ts
M  web/src/events.ts
M  web/src/render.ts
M  web/src/state.ts
M  web/src/styles.css
?? HANDOFF-SUMMONS-CODEX.md
?? src/app/summon-manager.ts
?? src/room/summons.ts
?? src/runtime/runtime-factory.ts
?? src/tools/summon-tool.ts
?? test/runtime-factory.test.ts
?? test/summon-manager.test.ts
```

### Codex Harness Decision

Do not implement a fake `CodexRuntime`.

The correct Codex direction is a real adapter over the local Codex interface:

- Prefer `@openai/codex-sdk` if it exposes enough streaming/control surface for GAIA.
- Otherwise use direct `codex app-server` JSON-RPC, which matches the pattern used by `openai/codex-plugin-cc`.
- Keep reusing local Codex auth/config.
- Map Codex streamed events into GAIA `AgentEvent` / summon event shapes.

Until that real adapter exists, `harness: "codex"` intentionally throws a clear error from `src/runtime/runtime-factory.ts`.

### Remaining Work

- Implement real Codex harness adapter over Codex SDK or `codex app-server`.
- Add route-level tests for the new summon REST endpoints.
- Browser-test the summon drawer with an actual running summon.
- Improve agent-tool summon semantics:
  - `publish` behavior is currently accepted but ignored.
  - Tool waits by polling for up to 5 minutes; consider event-based completion.
  - Decide whether long-running tool summons should return immediately instead of blocking the parent turn.
- Add optional `summon-snapshot` SSE on reconnect if needed; current drawer fetches persisted details on click.
- Consider persisted cancellation for completed/restarted sessions; current cancel only affects in-memory running summons.
