# GAIA

`gaia` is a local-first multi-agent room built on the Pi SDK.

Personas are global.
Project context is local.

That means Gaia, Sidia, and Terry live once under your GAIA home, like durable Hermes-style identities. Each project only adds instructions, room state, and optional local appends/overrides.

## Current shape

- global personas under `~/.gaia/agents/`
- project-local `AGENTS.md` context, like Pi
- project-local `.gaia/config.yaml`
- project-local room transcript in `.gaia/rooms/default/transcript.jsonl`
- deterministic `@agent` mention routing
- multiple agents in first-mentioned order
- per-agent global markdown memory
- Pi runtime for all agents
- sample global personas: `@gaia`, `@sidia`, `@terry`
- slash commands: `/help`, `/agents`, `/quit`

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
```

And it creates project-local room/context files:

```text
your-project/
  AGENTS.md
  .gaia/
    config.yaml
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

## Prompt layering

Each agent turn gets:

1. global agent `SOUL.md`
2. optional project agent `SOUL.md` override
3. optional project agent `APPEND_SOUL.md`
4. project `AGENTS.md` files, discovered from parent dirs to current dir
5. global agent `MEMORY.md`
6. recent room transcript

## Project-local agent overrides

You can customize an agent for one project without changing the global persona.

Examples:

```text
.gaia/agents/gaia/APPEND_SOUL.md   # append local behavior
.gaia/agents/gaia/SOUL.md          # replace global soul for this project
.gaia/agents/gaia/agent.yaml       # override metadata/tools/model for this project
```

Keep canonical identity and long-term memory global unless you have a clear reason not to.

## Workspace files

### `AGENTS.md`

Project instructions.
Use it for repo conventions, commands, constraints, safety notes, and preferences.

### `.gaia/config.yaml`

```yaml
defaultAgent: gaia
room: default
runtime: pi
transcriptWindow: 20
```

### `.gaia/rooms/default/transcript.jsonl`

Shared room history for the project.
Recent transcript is injected into each agent turn.

## Notes

- Unknown mentions fail loudly.
- Agent messages do not auto-trigger more routing.
- Pi is the only runtime right now.
- Safety isolation, smarter routing, and tests are still future work.
