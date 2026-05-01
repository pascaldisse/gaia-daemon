# GAIA Plan

## 1. Working Definition

GAIA is a local-first multi-agent workspace and council.

It starts as a simple CLI app where a user can talk to a default agent, mention other agents with `@agent`, and let multiple persistent agents respond in a shared room.

The core product is:

```text
workspace + agents + memory + routing + tools + interface
```

GAIA is not primarily a science app, companion app, coding agent, or OpenClaw clone. Those are possible directions or flavors. The foundation is a small, modular, local-first agent room.

The first useful version should help build GAIA itself.

Example target feeling:

```text
You: I want to improve the memory system.

Gaia: Here is the constructive shape...

You: @sidia critique this.

Sidia: Here are the weak assumptions...

You: @terry implement the smallest first slice.

Terry: Small patch. No drama.
```

## 2. Core Principles

1. Keep the core small.
2. Use a workspace model, not global persona memory.
3. Agents are plug-and-play folders.
4. Agent identity is separate from runtime implementation.
5. Monad is orchestration, not a public agent persona.
6. Mention routing comes before AI routing.
7. Use Pi as the default runtime now.
8. Keep the Pi yolo philosophy for now.
9. Let tools define capability.
10. Keep memory plain, local, inspectable markdown.
11. Add safety through isolation later, not complex policy now.
12. Prefer simple files and explicit structure over hidden state.

## 3. Current Implementation Snapshot

The current repo is a TypeScript/Node CLI wrapper around the Pi SDK.

Implemented now:

- `gaia` CLI entry point.
- `gaia init` setup flow.
- Three hardcoded personas: Gaia, Sidia, Monad.
- Slash mode switching: `/gaia`, `/sidia`, `/monad`.
- Separate Pi `AgentSession`s for each persona.
- Prompt files under `src/personas/prompts/`.
- Markdown memory under `~/.gaia/memories/`.
- Custom `memory` tool.
- Basic readline terminal UI.
- Simple Monad mode that calls Monad first, then Gaia/Sidia.
- Basic config loading from `~/.gaia/config.yaml`.
- Future placeholder seams for web search and artifacts.

This was a useful V1 spike, but the next version should change shape.

Current shape:

```text
mode -> hardcoded Pi session
```

Target shape:

```text
workspace -> room -> router -> agent(s) -> runtime -> response -> room
```

## 4. New Direction

Move from hardcoded persona modes to a workspace-based multi-agent room.

The app should start with a default agent from config. For the sample workspace, the default agent is `gaia`.

If the user does not mention anyone, the message goes to the default agent.

If the user mentions one or more agents with `@`, those agents respond in the order they are first mentioned.

Examples:

```text
Hello
=> default agent responds, initially Gaia

@sidia critique this plan
=> Sidia responds

@gaia @sidia think through this
=> Gaia responds, then Sidia responds

@terry implement the first step
=> Terry responds
```

Slash commands should be reserved for application control, not agent switching.

Remove these as primary interaction commands:

```text
/gaia
/sidia
/monad
```

Possible future control commands:

```text
/help
/agents
/memory
/room
/quit
```

## 5. Workspace Layout

GAIA should use a project workspace folder:

```text
.gaia/
  config.yaml
  SYSTEM.md
  agents/
    gaia/
      agent.yaml
      SOUL.md
      MEMORY.md
    sidia/
      agent.yaml
      SOUL.md
      MEMORY.md
    terry/
      agent.yaml
      SOUL.md
      MEMORY.md
  rooms/
    default/
      transcript.jsonl
```

### `.gaia/config.yaml`

Workspace-level config.

Initial shape:

```yaml
defaultAgent: gaia
room: default
runtime: pi
transcriptWindow: 20
```

Later this can grow, but keep it small now.

### `.gaia/SYSTEM.md`

Shared system-level project instructions for all agents in this workspace.

This file should define:

- What GAIA is.
- How agents should behave in the room.
- Memory rules.
- Tool-use expectations.
- Current workspace conventions.

It should not contain agent personality. Personality belongs in each agent's `SOUL.md`.

### `.gaia/agents/<agent>/agent.yaml`

Agent metadata and runtime settings.

Example:

```yaml
id: gaia
displayName: Gaia
icon: "☀️"
public: true
runtime: pi
model:
  provider:
  name:
thinking: medium
tools:
  - read
  - write
  - edit
  - memory
skills: []
```

Terry example:

```yaml
id: terry
displayName: Terry
icon: "🐻"
public: true
runtime: pi
model:
  provider:
  name:
thinking: medium
tools:
  - read
  - write
  - edit
  - bash
  - memory
skills: []
```

Notes:

- Tool names should map to Pi tools where possible.
- Do not build a complex permission policy yet.
- For now, an agent can use whatever tools it is configured to have.
- Later, the same config can support stronger isolation or policy.

### `.gaia/agents/<agent>/SOUL.md`

Agent identity and behavior.

This replaces the current central prompt files.

Examples:

```text
.gaia/agents/gaia/SOUL.md
.gaia/agents/sidia/SOUL.md
.gaia/agents/terry/SOUL.md
```

`SOUL.md` should be short and sharp:

- who the agent is
- how it speaks
- what it is good at
- what it should avoid

### `.gaia/agents/<agent>/MEMORY.md`

Agent-local memory.

Each agent gets its own memory file inside its folder.

This replaces:

```text
~/.gaia/memories/GAIA.md
~/.gaia/memories/SIDIA.md
```

For now, keep memory simple:

- markdown file
- append stable facts
- skip secrets and one-off details
- automatic memory writes are allowed
- memory is injected into the agent prompt

Later memory can evolve toward:

- better retrieval
- summaries
- DREAM.md-style review
- Hermes-style durable fact management
- OpenClaw-style daily notes

But do not add that yet.

### Room transcript

Start with a simple JSONL transcript:

```text
.gaia/rooms/default/transcript.jsonl
```

Each line can be a message event:

```json
{"timestamp":"2026-05-01T12:00:00.000Z","author":"user","targets":["gaia"],"text":"hello"}
{"timestamp":"2026-05-01T12:00:05.000Z","author":"gaia","text":"Hi..."}
```

The transcript gives agents shared room context.

For now, inject only the last N messages, configured by `transcriptWindow`.

Default:

```yaml
transcriptWindow: 20
```

## 6. Agent Model

An agent is a local folder plus runtime config.

Conceptual type:

```ts
interface AgentDefinition {
  id: string;
  displayName: string;
  icon: string;
  public: boolean;
  runtime: string;
  soulPath: string;
  memoryPath: string;
  tools: string[];
  skills: string[];
  model?: {
    provider?: string;
    name?: string;
  };
  thinking?: string;
}
```

Important distinction:

```text
Agent = who it is
Runtime = how it thinks/acts
```

Gaia is not a Pi session.
Sidia is not a prompt file.
Terry is not a tool list.

They are agents that currently use the Pi runtime.

## 7. Initial Sample Agents

The repo should ship with three sample agents. They are examples, not permanent hardcoded system entities.

Users should be able to replace them or add new ones later by creating more folders under `.gaia/agents/`.

### Gaia

Role:

- constructive
- warm
- curious
- pattern-seeking
- possibility-building
- guiding

Default use:

- default agent for the first workspace
- helps shape ideas
- suggests next steps
- keeps momentum

Tools:

```yaml
tools:
  - read
  - write
  - edit
  - memory
```

### Sidia

Role:

- skeptical
- precise
- adversarial but not cruel
- crack-finding
- falsification
- risk analysis

Default use:

- critique plans
- find weak assumptions
- stress-test architecture
- identify edge cases

Tools:

```yaml
tools:
  - read
  - write
  - edit
  - memory
```

### Terry

Role:

- practical engineer
- direct
- short
- no bullshit
- implementation-focused
- smallest working patch

Default use:

- coding work
- file edits
- shell commands
- implementation follow-through

Tools:

```yaml
tools:
  - read
  - write
  - edit
  - bash
  - memory
```

## 8. Monad

Monad is not a normal agent for now.

Monad is the orchestration layer.

Current Monad responsibility:

```text
parse user input -> find @mentions -> build route plan -> call agents in order
```

For V2, Monad should be deterministic and simple.

No LLM is needed for Monad yet.

Do not create:

```text
.gaia/agents/monad/
```

Do not expose:

```text
/monad
@monad
```

Future Monad may become smarter:

- route unmentioned messages with an LLM
- select agents based on task type
- manage turn order
- summarize group discussion
- manage context compression
- manage memory policy
- coordinate subagents

But for now:

```text
Monad = mention router
```

## 9. Routing Rules

Routing should be deterministic and easy to debug.

### No mention

Route to the room's default agent.

Example:

```text
User: What should we build next?
Config defaultAgent: gaia
=> Gaia responds
```

### One mention

Route to that agent.

```text
User: @sidia what can go wrong?
=> Sidia responds
```

### Multiple mentions

Route to agents in the order they are first mentioned.

```text
User: @sidia @gaia analyze this.
=> Sidia responds
=> Gaia responds
```

Repeated mentions should not duplicate turns.

```text
User: @gaia @sidia @gaia compare this.
=> Gaia responds once
=> Sidia responds once
```

### Unknown mention

If the user mentions an unknown agent, show a clear error and do not silently guess.

Example:

```text
Unknown agent: @bob
Available agents: @gaia, @sidia, @terry
```

### Agent response triggering

Agent messages should not automatically trigger more `@agent` routing yet.

Agents can mention each other in text, but the router only routes user input.

This avoids runaway loops.

## 10. Runtime Direction

Use Pi as the only runtime for now.

Still introduce a small runtime abstraction before the app grows too much.

Suggested files:

```text
src/runtime/types.ts
src/runtime/pi-runtime.ts
src/runtime/runtime-factory.ts
```

Conceptual interface:

```ts
interface AgentRuntime {
  send(input: AgentInput): AsyncIterable<AgentEvent>;
  dispose(): void;
}
```

For now:

```text
PiRuntime
```

Future possible runtimes:

```text
CodexRuntime
HermesRuntime
ClaudeCodeRuntime
LocalModelRuntime
```

Do not implement these future runtimes until there is a concrete need.

## 11. Tool Philosophy

For now, follow the Pi yolo philosophy.

Do not build a complex permission system yet.

An agent can use the tools configured in its `agent.yaml`.

Initial approach:

- Gaia: read/write/edit/memory
- Sidia: read/write/edit/memory
- Terry: read/write/edit/bash/memory

This is intentionally simple.

Later, make safety stronger through isolation rather than prompt policy.

Future safety direction:

- per-agent sandbox
- per-agent worktree
- optional container isolation
- restricted mounts
- tool audit log
- secret references instead of secret prompt injection
- NanoClaw-style secure-by-isolation model

But do not add containers or heavy policy now.

## 12. Memory Direction

Memory should live with the agent in the workspace.

Current global path should be phased out:

```text
~/.gaia/memories/
```

New path:

```text
.gaia/agents/<agent>/MEMORY.md
```

Automatic memory writes are allowed.

Memory tool behavior:

```text
target: current agent memory
action: add | replace | remove
```

For now, avoid shared global memory unless there is a clear need.

If shared memory is needed later, add:

```text
.gaia/MEMORY.md
```

But start with only per-agent memory.

Memory injection should include:

1. `.gaia/SYSTEM.md`
2. `.gaia/agents/<agent>/SOUL.md`
3. `.gaia/agents/<agent>/MEMORY.md`
4. recent room transcript

## 13. Proposed Source Structure

The TypeScript source should move toward this shape:

```text
src/
  cli.ts
  app/
    gaia-app.ts
  workspace/
    workspace-loader.ts
    types.ts
  agents/
    registry.ts
    types.ts
  room/
    transcript.ts
    room.ts
  router/
    mention-router.ts
    types.ts
  runtime/
    types.ts
    pi-runtime.ts
    runtime-factory.ts
  memory/
    memory-store.ts
    render.ts
  tools/
    memory-tool.ts
  tui/
    app-view.ts
    message-renderer.ts
    status-line.ts
    commands.ts
```

Some current files can be adapted:

```text
src/personas/types.ts       -> src/agents/types.ts / registry.ts
src/pi/session-factory.ts   -> src/runtime/pi-runtime.ts
src/app/mode-router.ts      -> src/router/mention-router.ts
src/app/monad-orchestrator.ts -> remove or replace with deterministic router
src/personas/prompts/*.md   -> .gaia/agents/<agent>/SOUL.md templates
```

## 14. V2 Milestone: Workspace Agent Room

The next milestone is:

```text
V2: Workspace Agent Room
```

Goal:

```text
Start GAIA, talk to default agent, mention other agents, persist memory/transcript in .gaia workspace.
```

### V2 Features

1. Add `.gaia/` workspace structure.
2. Add `.gaia/config.yaml` with `defaultAgent: gaia`.
3. Add `.gaia/SYSTEM.md`.
4. Add `.gaia/agents/gaia/{agent.yaml,SOUL.md,MEMORY.md}`.
5. Add `.gaia/agents/sidia/{agent.yaml,SOUL.md,MEMORY.md}`.
6. Add `.gaia/agents/terry/{agent.yaml,SOUL.md,MEMORY.md}`.
7. Load agents from folders instead of hardcoded persona metadata.
8. Start app with default agent from config.
9. Remove slash persona switching as the main interface.
10. Implement deterministic `@agent` mention routing.
11. Support multiple mentions in order.
12. Add simple room transcript JSONL.
13. Inject recent transcript into agent context.
14. Move memory writes to each agent's local `MEMORY.md`.
15. Wrap current Pi session creation behind `PiRuntime`.
16. Keep Pi as the only runtime.
17. Keep tool selection simple through `agent.yaml`.
18. Add Terry with bash enabled.
19. Update README to describe workspace and routing.
20. Add tests for routing, workspace loading, memory, and config.

## 15. Recommended Implementation Order

1. Create workspace file templates.
2. Change `gaia init` to create `.gaia/` in the current project.
3. Add workspace loader.
4. Add agent registry that reads `.gaia/agents/*/agent.yaml`.
5. Move Gaia/Sidia prompts into generated `SOUL.md` files.
6. Add Terry template.
7. Replace `PersonaId` hardcoding with string agent IDs.
8. Add mention parser.
9. Add route planner.
10. Route no-mention messages to `defaultAgent`.
11. Route mentioned messages to agents in mention order.
12. Add room transcript append/read.
13. Inject recent transcript into each agent prompt.
14. Change memory store to write to current agent's `MEMORY.md`.
15. Remove `/gaia`, `/sidia`, `/monad` switching from help and command handling.
16. Keep `/help` and `/quit`.
17. Add `/agents` if quick.
18. Wrap Pi sessions in `PiRuntime`.
19. Run typecheck and build.
20. Add tests.
21. Update README.

## 16. Testing Strategy

Add unit tests before the system grows further.

Test workspace loading:

- missing `.gaia/`
- valid `.gaia/config.yaml`
- invalid default agent
- agent folders discovered correctly
- missing `SOUL.md`
- missing `MEMORY.md` gets created if allowed

Test routing:

- no mention routes to default agent
- one mention routes to that agent
- multiple mentions preserve first-mentioned order
- duplicate mentions are deduplicated
- unknown mention reports an error
- agent-authored messages do not trigger routing

Test memory:

- add memory
- replace memory
- remove memory
- reject unsafe memory
- write to the correct agent folder

Test transcript:

- append user message
- append agent message
- read last 20 messages
- tolerate empty transcript

Test CLI commands:

- `/help`
- `/quit`
- `/agents` if implemented
- old persona switching commands are absent or deprecated

Test Pi runtime seam:

- runtime receives correct system prompt
- runtime receives correct tools from agent config
- runtime can be disposed

## 17. Future Suggestions

These are intentionally not part of V2.

### Smarter Monad

Later Monad can become an LLM router.

Possible behavior:

1. User sends message without mention.
2. Monad reads room context and agent descriptions.
3. Monad returns a structured route plan.
4. App executes the plan.

Example future route plan:

```json
{
  "turns": [
    { "agent": "gaia", "reason": "constructive planning" },
    { "agent": "sidia", "reason": "risk review" },
    { "agent": "terry", "reason": "implementation step" }
  ]
}
```

### Better Memory

Possible additions:

- `.gaia/MEMORY.md` shared workspace memory
- `.gaia/DREAM.md` memory review notes
- daily notes under `.gaia/memory/YYYY-MM-DD.md`
- memory summarization
- memory search
- memory review UI

### Skills

Agents already have `skills: []` in config.

Future layout:

```text
.gaia/skills/<skill>/SKILL.md
.gaia/agents/<agent>/skills/<skill>/SKILL.md
```

Keep skills inspectable and local.

### Runtime Plugins

Future runtimes:

- Codex
- Hermes
- Claude Code
- local model runner

Do not add until PiRuntime is clean and the room model works.

### Isolation

Future safety should come from real isolation.

Possible options:

- per-agent worktrees
- per-agent workspace folders
- containers
- restricted mounts
- filesystem snapshots
- command audit logs

This follows the NanoClaw idea:

```text
secure by isolation, not by trusting prompts
```

### Interfaces

Future interfaces:

- richer TUI
- local web UI
- voice
- messenger gateway

Do not add before the CLI room feels good.

### Science Playground

The original Gaia/Sidia science-playground idea can become a domain pack later.

Possible future pack:

```text
.gaia/skills/science-search/
.gaia/skills/python-simulation/
.gaia/skills/visualization/
```

But the core should remain the agent workspace.

## 18. Non-Goals For Now

Do not build yet:

- voice
- web UI
- containers
- LangGraph
- OpenClaw-style gateway
- multi-channel messaging
- autonomous recursive agent loops
- complex permission policy
- vector memory database
- science simulation tools
- generated artifact UI
- dozens of built-in agents
- non-Pi runtimes

## 19. Success Criteria For V2

V2 is successful when this works:

```text
$ gaia init
# creates .gaia workspace

$ gaia
# starts in default agent, Gaia

You: What should we improve first?
Gaia: ...

You: @sidia critique that.
Sidia: ...

You: @gaia @sidia compare options.
Gaia: ...
Sidia: ...

You: @terry implement the smallest step.
Terry: ... uses Pi tools, including bash if needed ...
```

And the workspace contains inspectable state:

```text
.gaia/SYSTEM.md
.gaia/config.yaml
.gaia/agents/gaia/SOUL.md
.gaia/agents/gaia/MEMORY.md
.gaia/agents/sidia/SOUL.md
.gaia/agents/sidia/MEMORY.md
.gaia/agents/terry/SOUL.md
.gaia/agents/terry/MEMORY.md
.gaia/rooms/default/transcript.jsonl
```

## 20. Final Direction

GAIA should move from:

```text
hardcoded Pi persona modes with global memories
```

to:

```text
local workspace agent room with plug-and-play agents, per-agent SOUL/MEMORY files, mention routing, a default agent, and Pi runtime underneath
```

Keep it simple.
Keep it local.
Keep it modular.
Make the room feel real before adding more machinery.
