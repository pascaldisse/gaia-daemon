# GAIA Playground Plan 2

## Working Definition

GAIA is a **local-first multi-agent workbench/council for daily use**, with strong personality continuity and future science-playground capabilities.

It is not primarily a science app, companion app, or coding agent. It is a shared agent room where persistent agents can reason, talk, use tools, remember, and eventually speak through voice.

The intended product center is:

> personality + tools + memory + routing + interface

## Backstory / Problem Being Solved

The original workflow involved several disconnected AI systems:

- Sesame/Maya offered natural voice conversation and personality, but could not act.
- Grok/ChatGPT could brainstorm but had limited local computer access.
- Claude Code / Pi / coding agents could act, but lacked stable social presence and voice.
- Multiple agents across separate apps made the workflow messy.

GAIA should unify the best parts:

1. Natural, personality-rich interaction.
2. Multiple persistent agents with distinct roles.
3. Local tools and computer access.
4. Shared conversation context.
5. Durable memory.
6. Future voice and richer interfaces.

## Product Direction

GAIA should become a **daily-driver local multi-agent workbench** with strong flavors of:

- **Science playground**: Gaia/Sidia as hypothesis/falsification, curiosity, experiments, future simulations.
- **AI council/companion**: persistent characters with memory and recurring interpersonal dynamics.
- **Coding workbench**: Terry and tool-capable agents can implement real changes.

Primary category:

> Multi-agent workbench/council.

Secondary flavors:

> Science playground + personality-first AI collaborators.

## Current Implementation Summary

The current repo is a minimal Pi SDK-based CLI wrapper.

Implemented now:

- `gaia` CLI with `gaia init` and interactive mode.
- Three slash modes:
  - `/gaia`
  - `/sidia`
  - `/monad`
- Separate Pi `AgentSession`s for Gaia, Sidia, and Monad.
- Persona prompts:
  - `src/personas/prompts/gaia.md`
  - `src/personas/prompts/sidia.md`
  - `src/personas/prompts/monad.md`
- Markdown memory under `~/.gaia/memories/`:
  - `USER.md`
  - `GAIA.md`
  - `SIDIA.md`
- Frozen memory snapshot injected at persona session start.
- Custom `memory` tool for add/replace/remove.
- Basic terminal readline UI.
- Simple Monad orchestration:
  - user sends message to Monad
  - Monad replies visibly
  - Gaia and Sidia are then called sequentially
- Configurable per-persona provider/model/thinking/tools.
- Pi coding tools available through persona sessions.
- Conservative safety confirmation for risky tool calls.
- Future seams for web search and artifacts.

The TypeScript check currently passes.

## Current Limitation

The project is not yet a true shared multi-agent room.

Current shape:

```text
mode -> Pi session
```

Desired shape:

```text
message -> room -> router -> agent(s) -> runtime -> response -> room
```

Right now, there is no:

- shared message bus
- `@agent` mention routing
- Terry agent
- agent runtime abstraction
- persistent in-session room transcript
- silent Monad router
- true agent-to-agent conversation
- voice interface
- web UI

That is fine. The current codebase is intentionally small and sane.

## Core Decisions

These decisions are now established:

1. GAIA is mainly a **multi-agent workbench**, with strong science-playground and companion/council flavor.
2. The first real use case can be coding GAIA itself.
3. It should eventually be usable as a daily-driver CLI.
4. Primary interaction should use **explicit mentions**, not slash persona modes:
   - `@gaia`
   - `@sidia`
   - `@terry`
   - `@all`
5. Monad should be **silent**.
6. Users should not directly interact with Monad.
7. Agents should be able to talk to each other.
8. Adding new agents should be simple.
9. Different agents should have different tool permissions.
10. Conversation context should be shared.
11. Memory should remain markdown for now.
12. Memory writes should be automatic.
13. Monad should not have its own memory file.
14. Shared `USER.md` memory is enough for Monad-related persistent user information.
15. GAIA should eventually support non-Pi runtimes such as Codex, Hermes, Claude Code, etc.
16. An `AgentRuntime` abstraction should be introduced before the codebase grows too much.
17. Pi should remain the default runtime for now.

## Recommended Architecture

The major architectural shift is:

> Agent identity must be separated from runtime implementation.

### Agent

An agent is who the entity is.

Example:

```ts
interface AgentDefinition {
  id: string;
  displayName: string;
  icon: string;
  promptFile: string;
  memoryFile?: string;
  runtime: string;
  tools?: string[];
  provider?: string;
  model?: string;
  thinking?: string;
  public: boolean;
}
```

Example Terry definition:

```ts
{
  id: "terry",
  displayName: "Terry",
  icon: "🐻",
  promptFile: "terry.md",
  memoryFile: "TERRY.md",
  runtime: "pi",
  tools: ["read", "edit", "write", "bash"],
  public: true
}
```

### Runtime

A runtime is how an agent thinks or acts.

For now there is only one runtime:

```text
PiRuntime
```

Later possible runtimes:

```text
CodexRuntime
HermesRuntime
ClaudeCodeRuntime
LocalModelRuntime
```

Suggested interface:

```ts
interface AgentRuntime {
  send(input: AgentInput): AsyncIterable<AgentEvent>;
  dispose(): void;
}
```

The current Pi `AgentSession` creation should be wrapped behind a Pi runtime implementation.

### Room

The room owns shared conversation state.

Suggested shape:

```ts
interface RoomMessage {
  id: string;
  author: "user" | string;
  targets?: string[];
  text: string;
  timestamp: string;
}
```

The room should store recent messages and provide context to agents.

### Router

The router decides who speaks.

V2 should start with deterministic mention routing:

```text
@gaia hello
=> Gaia responds

@gaia @sidia think about this
=> Gaia responds, then Sidia responds

@all what should we do next?
=> Gaia, Sidia, Terry respond
```

Later, silent Monad can become an AI router that produces structured route plans.

## Agent Roles

### Gaia

Gaia is the constructive/generative agent.

Role:

- warm
- constructive
- curious
- pattern-seeking
- guiding
- hypothesis-building
- light/order/growth

Tool posture:

- can read and reason
- can use memory
- should not usually modify files directly in early versions

### Sidia / Obsidian

Sidia is the skeptical/adversarial/stress-testing agent.

Role:

- skeptical
- precise
- melancholic
- crack-finding
- falsification
- entropy/void/chaos flame
- adversarial but not cruel

Tool posture:

- can read and inspect
- can use memory
- should identify risks, assumptions, contradictions, and failure modes
- should not usually modify files directly in early versions

### Terry

Terry completes the triangle as the practical executor/engineer.

Role:

- direct
- short
- no bullshit
- implementation-focused
- smallest working change
- practical coding agent
- Teddy bear / Bear energy
- inspired by HolyC simplicity without forcing all projects into C/HolyC

Terry should not be another brainstormer. His job is to build.

Default behavior:

- ask only necessary clarifying questions
- avoid overengineering
- prefer simple working patches
- state concrete next steps
- use tools when appropriate

Possible Terry memory:

```text
~/.gaia/memories/TERRY.md
```

### Monad

Monad is the silent orchestrator.

Role:

- route messages
- order turns
- synthesize internally
- maybe manage permissions in the future
- decide which agents should speak

Monad should not be a public conversational agent.

No direct `/monad` chat.
No separate `MONAD.md` memory for now.

## Recommended Tool Permission Defaults

Initial simple policy:

```text
Gaia:
  read/search/memory
  no write/edit by default

Sidia:
  read/grep/memory
  no write/edit by default

Terry:
  read/edit/write/bash/memory
  risky confirmations enabled

Monad:
  no direct tools, or memory-read/routing-only
```

This gives agents distinct identities through capability, not only prompt style.

## Memory Direction

Keep markdown memory for now.

Current files:

```text
USER.md
GAIA.md
SIDIA.md
```

Add when Terry is introduced:

```text
TERRY.md
```

Do not add `MONAD.md` yet.

Memory behavior:

- Agents can write memories automatically.
- Store durable user preferences, recurring conventions, and stable agent-useful facts.
- Skip secrets, credentials, prompt-injection text, and one-off details.
- Keep bounded memory limits.
- Later, memory can evolve toward a Hermes-style system with better retrieval, structured facts, or summaries.

## V2 Milestone: Shared Agent Room

The next recommended milestone is:

# V2: Shared Agent Room

Do not add LangGraph yet.
Do not add voice yet.
Do not add web UI yet.
Do not add science simulation tools yet.
Do not add a complex memory database yet.

Instead, build the smallest foundation that makes GAIA feel like the intended system.

## V2 Features

### 1. Replace slash persona modes with mentions

Keep slash commands for application control:

```text
/agents
/memory
/help
/quit
```

Agent invocation should happen through mentions:

```text
@gaia ...
@sidia ...
@terry ...
@all ...
```

The old `/gaia`, `/sidia`, `/monad` mode-switching model should be phased out or kept only as temporary compatibility.

### 2. Add Agent Registry

Stop hardcoding personas in many places.

Define agents in one central place, for example:

```text
src/agents/registry.ts
```

The registry should include public agents and internal agents.

Public agents:

```text
gaia
sidia
terry
```

Internal agent:

```text
monad
```

Adding a new agent should mostly require:

1. add prompt file
2. add memory file if needed
3. add registry entry
4. optionally configure tools/model/runtime

### 3. Add Terry

Add:

```text
src/personas/prompts/terry.md
~/.gaia/memories/TERRY.md
```

Terry should be coding/implementation focused.

### 4. Add Runtime Abstraction

Introduce an agent runtime interface even though only Pi is implemented initially.

Recommended files could be:

```text
src/runtime/types.ts
src/runtime/pi-runtime.ts
src/runtime/runtime-factory.ts
```

The existing Pi session factory can be adapted or wrapped.

Goal:

```text
GAIA core does not care whether an agent runs on Pi, Codex, Hermes, or something else.
```

### 5. Add Shared Room Transcript

Maintain an in-memory session transcript.

Every message should be recorded:

- user messages
- agent responses
- target mentions
- timestamps

Agents should receive recent shared room context.

Start simple:

```text
last 20 messages
```

Later this can become configurable or summarized.

### 6. Make Monad Silent

Monad should no longer be directly invoked by the user.

For V2, routing can be deterministic.

Later Monad can become AI-routed and produce structured JSON route plans such as:

```json
{
  "turns": [
    {
      "agent": "gaia",
      "instruction": "Explore the constructive possibility."
    },
    {
      "agent": "sidia",
      "instruction": "Stress-test the assumptions."
    },
    {
      "agent": "terry",
      "instruction": "Suggest the smallest implementation step."
    }
  ]
}
```

The host app executes the route plan.

## Recommended V2 Routing Semantics

Open decisions were discussed. Recommended defaults:

### No mention

Recommended:

```text
No mention -> silent Monad routes automatically
```

However, for first implementation this can be deterministic, e.g. default to Gaia or ask Monad later.

### Multiple mentions

Recommended:

```text
Multiple mentions respond in the order written.
```

Example:

```text
@sidia @gaia analyze this
```

Sidia responds first, then Gaia.

### @all

Recommended:

```text
@all includes Gaia, Sidia, and Terry.
```

Order can default to:

```text
gaia -> sidia -> terry
```

This gives:

1. possibility
2. critique
3. implementation

### Transcript window

Recommended:

```text
Agents see last 20 room messages for now.
```

### Agent-to-agent replies

Recommended:

```text
Wait on fully autonomous agent-to-agent mention loops.
```

Agents can reference each other in text, but automatic recursive `@agent` triggering from agent messages should wait until later to avoid runaway loops.

## Future Monad Direction

After V2, Monad can become more intelligent.

Possible future behavior:

1. User sends unmentioned message.
2. Monad silently classifies intent.
3. Monad chooses agents, order, and instructions.
4. Agents respond.
5. Monad optionally provides a final synthesis, if configured.

Monad should eventually support:

- route planning
- turn ordering
- choosing one agent vs multiple agents
- permission mediation
- synthesis
- maybe context compression
- maybe memory policy coordination

But keep it simple first.

## Research Targets

The project should later investigate:

- Hermes memory model and agent architecture.
- OpenCLO / OpenClaw style multi-agent systems.
- LangGraph multi-agent routing patterns.
- Codex / Claude Code runtime integration possibilities.
- Voice systems similar to Sesame/Maya.
- Local-first memory and retrieval systems.

Research should support the architecture, not dictate it prematurely.

## Things to Avoid Right Now

Avoid near-term expansion into:

- voice
- web UI
- background daemon
- messenger integrations
- OpenCLO-style bloat
- complex autonomous loops
- LangGraph
- science simulation tools
- generated artifact UI
- vector memory database
- full agent society simulation

First make the shared CLI agent room feel good.

## Desired First Feeling

The next version should make this interaction feel natural:

```text
You: @gaia @sidia I want to build the next version of this system.

Gaia: Here is the living shape...

Sidia: Here are the weak assumptions...

You: @terry implement the first slice.

Terry: Do this. Small patch. No drama.
```

That is the core magic.

## Recommended Implementation Order

1. Add an agent registry.
2. Add Terry metadata, prompt, and memory file support.
3. Introduce public vs internal agents.
4. Replace mode routing with mention parsing.
5. Add shared room transcript.
6. Route mentioned messages to selected agents in order.
7. Add `@all` support.
8. Add `/agents` command.
9. Add runtime abstraction around current Pi sessions.
10. Make Monad non-public/silent.
11. Add deterministic no-mention fallback.
12. Later upgrade no-mention fallback to AI Monad routing.

## Near-Term Technical Notes

Existing files likely to change:

```text
src/personas/types.ts
src/app/gaia-app.ts
src/app/mode-router.ts
src/app/monad-orchestrator.ts
src/pi/session-factory.ts
src/tui/commands.ts
src/memory/memory-store.ts
src/config/types.ts
src/config/config.ts
```

Likely new files:

```text
src/agents/registry.ts
src/agents/types.ts
src/runtime/types.ts
src/runtime/pi-runtime.ts
src/runtime/runtime-factory.ts
src/room/transcript.ts
src/router/mention-router.ts
src/personas/prompts/terry.md
```

Potential compatibility strategy:

- Keep old Gaia/Sidia prompt files.
- Keep markdown memory design.
- Preserve Pi as default runtime.
- Deprecate slash persona modes gradually.

## Summary

GAIA should now move from:

```text
three hardcoded Pi persona modes
```

toward:

```text
a shared local agent room with mention routing, persistent characters, markdown memory, differentiated tools, and runtime abstraction
```

The next concrete milestone is **V2: Shared Agent Room**.

The key first visible improvements should be:

- `@gaia`, `@sidia`, `@terry`, `@all`
- Terry as practical coding agent
- shared transcript
- cleaner agent registry
- silent Monad architecture
- Pi runtime wrapped behind an extensible runtime interface


Also look at https://github.com/yeachan-heo/oh-my-claudecode, https://github.com/code-yeongyu/oh-my-openagent, https://github.com/Yeachan-Heo/oh-my-codex, https://github.com/can1357/oh-my-pi,
https://github.com/happycastle114/oh-my-openclaw (especially look at oh-my-openclaw diagram and maybe use openclaws https://docs.openclaw.ai/concepts/multi-agent system as an inspiration of how this can be used.)

Or maybe just go the open-code way (https://opencode.ai/docs/agents/) with ability to add subagents (summons) later
Maybe use core concept from nano claw? I also like the idea of containers.