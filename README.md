# GAIA

`gaia` is a local-first terminal persona room built on the Pi SDK.

Its main idea is simple:

- **Agent = hard control**: runtime, model, tools, and future sandbox policy.
- **Persona = soft control**: identity, voice, memory, roles, and behavior.
- **Room = shared place**: transcript, active roles, cursors, and runtime continuity.

Personas are durable. Projects add local context.

## Current shape

- global agents under `~/.gaia/agents/`
- agent-owned `persona/` folders
- central skill libraries under `~/.gaia/skills/` and project `.gaia/skills/`
- project-local `AGENTS.md` context, like Pi
- project-local `.gaia/config.json`
- project-local room state and transcript under `.gaia/rooms/default/`
- room-local active roles via `/role`
- deterministic `@agent` mention routing
- multiple agents in first-mentioned order
- per-agent global markdown memory
- persistent Pi session per room-agent pair
- sample global agents: `@gaia`, `@sidia`, `@terry`
- slash commands: `/help`, `/agents`, `/roles`, `/role`, `/quit`
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

It creates or verifies global agents:

```text
~/.gaia/
  agents/
    gaia/
      agent.json
      persona/
        SOUL.md
        MEMORY.md
        roles/
    sidia/
      agent.json
      persona/
        SOUL.md
        MEMORY.md
        roles/
    terry/
      agent.json
      persona/
        SOUL.md
        MEMORY.md
        roles/
  skills/
```

And it creates project-local room/context files:

```text
your-project/
  AGENTS.md
  .gaia/
    config.json
    skills/
    agents/
    rooms/
      default/
        state.json
        transcript.jsonl
        pi-sessions/
```

## Run

```bash
gaia
```

This starts the local web UI and prints the URL.

The legacy terminal UI is still available:

```bash
gaia tui
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

## Roles

A role is a markdown prompt overlay for an agent.
It can request Pi skills through frontmatter.

Global role:

```text
~/.gaia/agents/gaia/persona/roles/brainstorm.md
```

Project overlay:

```text
.gaia/agents/gaia/persona/roles/brainstorm.md
```

If both exist, GAIA appends the project role body after the global role body.

Example role:

```md
---
skills:
  - brainstorm
  - web
---
# Brainstorm Role

Explore options. Notice patterns. Ask crisp questions.
```

Room commands:

```text
/roles gaia              list Gaia's roles
/role gaia brainstorm    set Gaia's active role in this room
/role gaia none          clear Gaia's active role in this room
```

Active roles are stored in:

```text
.gaia/rooms/default/state.json
```

## Skills

GAIA does not implement its own skill engine.
It resolves role-declared skill names to Pi skill paths and lets Pi load them.

Lookup order:

1. `.gaia/skills/<name>/SKILL.md`
2. `~/.gaia/skills/<name>/SKILL.md`

Project skills win over global skills on name collision.

Skills are soft workflow instructions.
They do **not** grant tools. Tools stay in `agent.json` as hard control.

## Create a new agent

```bash
gaia agent create luma "Luma"
```

This creates:

```text
~/.gaia/agents/luma/
  agent.json
  persona/
    SOUL.md
    MEMORY.md
    roles/
      brainstorm.md
      research.md
      plan.md
```

The command refuses to overwrite an existing agent.
Edit the generated files directly.

## Prompt layering

Each agent turn gets:

1. global agent `persona/SOUL.md`
2. active role prompt, if set
3. optional project agent `persona/INTENT.md`
4. project `AGENTS.md` files, discovered from parent dirs to current dir
5. global agent `persona/MEMORY.md`
6. new room events since that agent's cursor
7. newest user message

The room cursor is a transcript line count for this MVP.
It prevents injecting the same room events again and again.

## Project-local agent overlays

You can customize an agent for one project without changing the global persona.

Examples:

```text
.gaia/agents/gaia/persona/INTENT.md       # project-local intent/instructions
.gaia/agents/gaia/persona/roles/plan.md   # project-local role overlay
.gaia/agents/gaia/agent.json              # override metadata/tools/model for this project
```

Legacy paths still load for compatibility:

```text
~/.gaia/agents/gaia/SOUL.md
~/.gaia/agents/gaia/MEMORY.md
.gaia/agents/gaia/INTENT.md
```

Prefer the new `persona/` paths for new work.

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

### `.gaia/rooms/default/state.json`

Room-local active roles, transcript cursors, and future Pi session metadata.

## Notes

- Unknown mentions fail loudly.
- Agent messages do not auto-trigger more routing.
- Pi is the only runtime right now.
- Containers, subagents, and stronger isolation are future seams, not part of this MVP.
