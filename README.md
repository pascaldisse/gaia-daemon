# GAIA

`gaia` is a local-first multi-agent room built on the Pi SDK.

Personas are global.
Project context is local.

That means Gaia, Sidia, and Terry live once under your GAIA home, like durable Hermes-style identities. Each project only adds instructions, room state, and optional local intent/config overrides.

## Current shape

- global personas under `~/.gaia/agents/`
- project-local `AGENTS.md` context, like Pi
- project-local `.gaia/config.json`
- project-local room transcript in `.gaia/rooms/default/transcript.jsonl`
- deterministic `@agent` mention routing
- multiple agents in first-mentioned order
- per-agent global markdown memory
- Pi runtime for all agents
- sample global personas: `@gaia`, `@sidia`, `@terry`
- slash commands: `/help`, `/agents`, `/quit`
- dynamic selectable previews for `/` commands and `@` agents

`GAIA_HOME` can override the global home path. Default: `~/.gaia`.

## Setup

```bash
npm install
npm run build
npm link   # optional, exposes `gaia`
```

Configure Pi auth the same way you configure Pi itself.
For example: `pi /login` or provider API-key environment variables.

## Initialize a project

Run this in your project:

```bash
gaia init
```

It creates or verifies global personas:

```text
~/.gaia/
  agents/
    gaia/
      agent.json
      SOUL.md
      MEMORY.md
    sidia/
      agent.json
      SOUL.md
      MEMORY.md
    terry/
      agent.json
      SOUL.md
      MEMORY.md
```

And it creates project-local room/context files:

```text
your-project/
  AGENTS.md
  .gaia/
    config.json
    rooms/
      default/
        transcript.jsonl
```

## Run

```bash
gaia
```

Press `/` to open the command preview.
Press `@` to open the agent preview.
Use ↑/↓ to select, Tab/Enter to insert, and Esc to hide.

Examples:

```text
What should we build next?
# routes to default agent, usually @gaia

@sidia critique this plan
# routes to Sidia

@gaia @terry compare options and implement the smallest step
# Gaia responds, then Terry responds
```

## Prompt layering

Each agent turn gets:

1. global agent `SOUL.md`
2. optional project agent `INTENT.md`
3. project `AGENTS.md` files, discovered from parent dirs to current dir
4. global agent `MEMORY.md`
5. recent room transcript

## Project-local agent overrides

You can customize an agent for one project without changing the global persona.

Examples:

```text
.gaia/agents/gaia/INTENT.md     # append project-local intent/instructions
.gaia/agents/gaia/agent.json    # override metadata/tools/model for this project
```

Keep canonical identity and long-term memory global. `SOUL.md` is never overridden per project.

## Workspace files

### `AGENTS.md`

Project instructions.
Use it for repo conventions, commands, constraints, safety notes, and preferences.

### `.gaia/config.json`

```json
{
  "defaultAgent": "gaia",
  "room": "default",
  "runtime": "pi",
  "transcriptWindow": 20
}
```

### `.gaia/rooms/default/transcript.jsonl`

Shared room history for the project.
Recent transcript is injected into each agent turn.

## Notes

- Unknown mentions fail loudly.
- Agent messages do not auto-trigger more routing.
- Pi is the only runtime right now.
- Safety isolation, smarter routing, and tests are still future work.
- ideas: agents can summon subagents. This is handled similarly to OpenCode. (We will not implement this yet though)
