# GAIA

`gaia` is a local-first multi-agent workspace CLI built on the Pi SDK.

It opens a shared room inside your project.
One agent is the default.
You can mention other agents with `@agent`.
Each agent keeps its own `SOUL.md` and `MEMORY.md` inside `.gaia/`.

## Current shape

- project-local `.gaia/` workspace
- default agent routing
- deterministic `@agent` mention routing
- multiple agents in mention order
- per-agent markdown memory
- shared room transcript in JSONL
- Pi runtime for all agents
- built-in sample agents: `@gaia`, `@sidia`, `@terry`
- slash commands: `/help`, `/agents`, `/quit`

## Setup

```bash
npm install
npm run build
npm link   # optional, exposes `gaia`
```

Configure Pi auth the same way you configure Pi itself.
For example: `pi /login` or provider API-key environment variables.

## Initialize a workspace

Run this in your project:

```bash
gaia init
```

It creates:

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

## Run

```bash
gaia
```

Examples:

```text
What should we build next?
# routes to default agent, usually @gaia

@sidia critique this plan
# routes to Sidia

@gaia @terry compare options and implement the smallest step
# Gaia responds, then Terry responds
```

## Workspace files

### `.gaia/config.yaml`

```yaml
defaultAgent: gaia
room: default
runtime: pi
transcriptWindow: 20
```

### `.gaia/SYSTEM.md`

Shared workspace instructions for all agents.

### `.gaia/agents/<agent>/SOUL.md`

The identity and voice of one agent.

### `.gaia/agents/<agent>/MEMORY.md`

Local long-term memory for one agent.
The `memory` tool writes here.

### `.gaia/rooms/default/transcript.jsonl`

Shared room history.
Recent transcript is injected into each agent turn.

## Notes

- Unknown mentions fail loudly.
- Agent messages do not auto-trigger more routing.
- Pi is the only runtime right now.
- Safety isolation, smarter routing, and tests are still future work.
