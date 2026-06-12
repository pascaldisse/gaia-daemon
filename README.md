# GAIA

`gaia` is a local-first persona room built on the Pi SDK.

Its main idea is simple:

- **Agent = hard control**: runtime, model, tools, and future sandbox policy.
- **Persona = soft control**: identity, voice, memory, roles, and behavior.
- **Room = shared place**: transcript, active roles, cursors, and runtime continuity.

Personas are durable. Projects add local context.

## Current shape

- web UI as the only frontend (`gaia` starts the server and prints the URL)
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
- model switching through Pi's registry (API-key, subscription/OAuth, local);
  each agent message shows the model that actually produced it
- voice calls per agent through the vendored unmute stack (`unmute/`)
- sample global agents: `@gaia`, `@sidia`, `@terry`
- slash commands: `/help`, `/agents`, `/roles`, `/role`, `/thinking`
- dynamic selectable previews for `/` commands and `@` agents
- settings stay plain text files; the formatted view renders smart controls
  from server-computed hints

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
```

And it creates project-local room/context files:

```text
your-project/
  AGENTS.md
  .gaia/
    config.json
    rooms/
      default/
        state.json
        transcript.jsonl
```

Optional overlay directories such as `.gaia/agents/` and `.gaia/skills/` are loaded if you create them later.
Pi session folders are created lazily under `.gaia/rooms/<room>/pi-sessions/` after agent turns run.

## Run

```bash
gaia
```

This starts the local web UI and prints the URL.
The Node process serves the frontend directly from `web/`, so no separate frontend bundler is required.

For local development with auto-restart and browser reload support:

```bash
npm run dev:watch
```

- changes under `src/` restart the Node process
- changes under `web/` reload the browser

In the composer, type `/` for the command preview and `@` for the agent preview.
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

## Voice calls

Each agent row in the room panel has a call button (📞). On a call you talk
naturally — no push-to-talk, no Enter. The [unmute](https://github.com/kyutai-labs/unmute)
stack does the audio work (STT, TTS, turn-taking, barge-in) while GAIA stays
the brain: every spoken turn runs through the same agent, model, tools, and
room transcript as typed messages. The agent's text replies still appear in
the chat (marked 🎙), you can still type, and what you say is transcribed
live into the composer box.

unmute ships inside this repo under `unmute/` (MIT licensed, Copyright 2025
Kyutai — see `unmute/LICENSE`), including the macOS port that runs STT on
Metal and TTS on MLX. Voice needs two host tools: `uv` (runs the Python
services) and `cargo` (builds `moshi-server` for STT on first use).

There is nothing to start by hand. Clicking the call button boots whatever
parts of the voice stack (STT, TTS, unmute backend) are not already running,
shows the startup progress in the topbar, and connects when the stack
reports healthy. The very first call downloads Python dependencies and
models, so it can take a few minutes; later calls only reload models.
Hanging up stops the services GAIA started; externally started ones are left
alone. If a default port is taken by some other process, GAIA transparently
runs the service on a free port instead.

- the agent's optional `voice` field in `agent.json` selects the TTS voice
- service logs land in `~/.gaia/logs/voice/`
- voice options live in `~/.gaia/voice.json`, edited under the **Voice** tab
  in global settings: `unmuteUrl`, `unmuteDir` (defaults to the bundled
  `unmute/` copy), `autoStart`, `startTimeoutSec`, `speakOnSilence` +
  `silenceDelaySec` (whether/when the agent speaks up on its own during a
  long silence), and `disableThinking` (thinking is forced off during calls
  and restored on hang-up)
- the `💭 #level` text under the composer shows the current agent's thinking
  effort: click toggles between the current level and off, right-click opens
  a menu with all levels, and `/thinking [agent] <level>` does the same from
  the keyboard. Outside a call changes persist to that agent's `agent.json`;
  during a call they apply to the call only
- on a call, mute (🎤) and hang-up (⏹) buttons appear under the text input;
  muting sends silence so the conversation timing stays intact
- interrupting the agent mid-sentence cancels its turn, like Esc on a text task
- `scripts/voice-stack.sh` still exists to run the stack manually (GAIA will
  detect and reuse it instead of starting its own)

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
Edit the generated files directly (or through the settings UI, which renders
dropdowns for these fields).

Optional `agent.json` fields:

- `model`: `{ "provider": ..., "name": ... }` pins a model from Pi's
  registry; omitted means Pi's default
- `thinking`: thinking effort (`off`...`xhigh`); also changeable from the
  composer's `💭 #level` control and `/thinking`
- `voice`: TTS voice for calls (an unmute `voices.yaml` entry)

## Prompt layering

The system prompt for each agent session contains:

1. global agent `persona/SOUL.md`
2. active role prompt, if set
3. optional project agent `persona/INTENT.md`
4. project `AGENTS.md` files, discovered from parent dirs to current dir

Each turn prompt then adds:

5. global agent `persona/MEMORY.md`, only when it changed since the last turn
6. new room events since that agent's cursor
7. newest user message

Memory travels in the turn prompt instead of the system prompt so memory
writes never force a session reload mid-conversation. The room cursor is a
transcript line count for this MVP. It prevents injecting the same room
events again and again.

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

All settings are plain text files. The web UI's formatted view renders smart
controls on top of them (dropdowns for agents, rooms, models, tool
checkboxes) using server-computed field hints; the raw view always shows the
file as-is. Model choices come from Pi's model registry, including custom and
local models from `~/.pi/agent/models.json` and subscription (OAuth) or
API-key auth configured via `pi /login`.

### `.gaia/rooms/default/transcript.jsonl`

Shared room history for the project.

### `.gaia/rooms/default/state.json`

Room-local active roles, transcript cursors, runtime details, and Pi session metadata.

## Notes

- Unknown mentions fail loudly.
- Agent messages do not auto-trigger more routing.
- Pi is the only runtime right now.
- Containers, subagents, and stronger isolation are future seams, not part of this MVP.
