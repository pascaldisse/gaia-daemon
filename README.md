# GAIA Daemon

`gaia` is a local-first multi-agent workspace built on the Pi SDK.

Its main idea is simple:

- **Agent = hard control**: harness, model, tools, and sandbox/permission policy.
- **Persona = soft control**: identity, voice, memory, roles, and behavior.
- **Room = shared place**: transcript, active roles, cursors, and runtime continuity.

Personas are durable. Projects add local context.

## Current shape

- web UI as the only frontend (`gaia` starts the server and prints the URL),
  laid out like a tmux/omarchy terminal multiplexer: rooms are tabs across the
  top, a powerline status bar runs along the bottom, and the whole thing
  restyles live through 11 swappable themes (default Tokyo Night) — see **Run**
- global agents under `~/.gaia/agents/`
- agent-owned `persona/` folders
- central skill libraries under `~/.gaia/skills/` and project `.gaia/skills/`
- project-local `AGENTS.md` context, like Pi
- project-local `.gaia/config.json`
- project-local room state and transcript under `.gaia/rooms/default/`
- room-local active roles via `/role`
- deterministic `@agent` mention routing
- multiple agents in first-mentioned order
- per-agent markdown memory (capped core + user profile + topic files) and
  full-text recall over the room history
- pluggable per-agent harness (`pi`, `codex`, `claude`) — see **Harnesses**
- one long-lived runner per room-agent pair: every harness runs each turn in a
  uniform `gaia __run-agent` subprocess, so a swappable OS-level **sandbox** can
  wrap exactly one process — see **Sandbox**
- summons run as nested child rooms (a `/summon` or the `summon` tool opens a
  sub-room in the tree); fan several out at once for a swarm — see **Summons**
- model switching through Pi's registry (API-key, subscription/OAuth, local);
  each agent message shows the model that actually produced it
- voice calls per agent through the vendored unmute stack (`unmute/`)
- sample global agents: `@gaia`, `@sidia`, `@terry`
- slash commands: `/help`, `/agents`, `/roles`, `/role`, `/summon`,
  `/thinking`, `/clear`, `/fork`
- dynamic selectable previews for `/` commands and `@` agents
- settings stay plain text files; the formatted view renders smart controls
  from server-computed hints

Environment overrides: `GAIA_HOME` (global home, default `~/.gaia`), `GAIA_HOST`
/ `GAIA_PORT` (web-server bind address, default `127.0.0.1:8787`; port `0` picks
a free one), and `GAIA_SANDBOX_IMAGE` (container image for the sandbox).

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
        memory/
          MEMORY.md
          USER.md
        roles/
    sidia/
      agent.json
      persona/
        SOUL.md
        memory/
          MEMORY.md
          USER.md
        roles/
    terry/
      agent.json
      persona/
        SOUL.md
        memory/
          MEMORY.md
          USER.md
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

The UI is a tmux-style multiplexer. Rooms are tabs; a powerline status bar shows
the workspace, active room, and agent state. tmux-flavoured keybindings (all
modified, so they never collide with the composer):

```text
Ctrl/Cmd+T            new room (tab)
Alt+1..9             jump to room tab N
Ctrl+Tab / Alt+←/→   next / previous tab
Ctrl+B               toggle the sessions sidebar
Ctrl+G               toggle the room panel
Alt+T                theme palette        Alt+Shift+T   cycle theme
Esc                  close the theme palette
```

Eleven themes ship (Tokyo Night by default, plus Cyberpunk, Catppuccin, Gruvbox,
Nord, Everforest, Kanagawa, Rosé Pine, Dracula, Matte Black, and an opt-in
green-CRT Matrix). The choice is per-browser.

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

## Harnesses

A harness is the backend that runs an agent's turns. Pick one per agent with
the `harness` field in `agent.json` (or a workspace default in
`.gaia/config.json`); it falls back to `pi`.

A harness is a faithful **translator** of the agent's `tools` array and posture
— not a place that hardcodes "modes". "Plan mode" or "read-only" are just
combinations of toggles, mapped onto each backend as faithfully as it can.

Every harness — Pi included — runs each turn in a uniform `gaia __run-agent`
subprocess (one long-lived runner per room-agent pair). The daemon launches all
three the same way, so the execution model has no harness-specific branches and
the **sandbox** has exactly one process to wrap (see **Sandbox**). The runner
talks back to the daemon over a small HTTP bridge for `memory`/`recall`/`summon`,
keeping the daemon the single writer.

- **`pi`** (default) — the Pi SDK, in-process. `memory`, `recall`, and `summon`
  are in-process tools. Models and auth come from Pi's registry.
- **`claude`** — spawns your installed `claude` CLI once per turn, inheriting
  your environment so it rides your logged-in **Claude subscription** (no API
  key needed; `claude` must be on `PATH`). The `tools` array maps onto Claude's
  own tools: `read`→Read/Grep/Glob, `write`→Write, `edit`→Edit, `bash`→shell,
  and `memory`/`recall`/`summon`→a narrow, locked `gaia` CLI grant (so they work
  even for agents with no general shell). `permissionMode` exposes Claude's
  permission modes (e.g. `plan`).
- **`codex`** — drives your installed `codex` app-server, riding your **Codex
  subscription** (`codex` must be on `PATH`). It honors `tools` coarsely through
  a workspace sandbox: `write`/`edit`/`bash` → `workspace-write`, otherwise
  `read-only`. `memory` works (via the `gaia` CLI); `recall` and `summon` are
  not available under Codex yet.

For the `claude` and `codex` harnesses, `memory`/`recall`/`summon` are delivered
through a small `gaia` CLI the agent runs (reads go straight to disk; writes and
summon call back to the running daemon, which stays the single writer) — no MCP.
The `claude`/`codex` providers are locked in the settings UI to Anthropic /
OpenAI-Codex models respectively.

## Sandbox

Because every harness runs a turn in the same `gaia __run-agent` subprocess, the
daemon can wrap that one process in an OS-level sandbox — uniformly, with no
knowledge of which harness is inside. Backends are swappable: adding one is a new
`src/runtime/sandbox/<name>.ts` that calls `registerSandbox(...)` plus one import
line, the daemon analogue of a single-file container-runtime swap.

Two backends ship:

- **`none`** (default) — no isolation; the identity launch. Selected unless a
  workspace opts into something stronger.
- **`apple-container`** — wraps the launch in Apple's `container run` (a Linux
  VM). The workspace mounts read-only, declared subdirs mount read-write, the
  rest of the host stays invisible, and `net: "none"` cuts network access. The
  `container` binary must be on `PATH`, and the image (`GAIA_SANDBOX_IMAGE`,
  default `gaia-agent`) must carry node + the gaia runner; building that image
  is a separate concern, like the pi skill's `Containerfile`.

Policy is resolved above the harness — an `agent.json` `sandbox` block overrides
the workspace `.gaia/config.json` one:

```json
{
  "sandbox": {
    "enabled": true,
    "backend": "apple-container",
    "writable": [".gaia/rooms"],
    "net": "none"
  }
}
```

Scope `writable` as narrowly as the turn needs (here, just the room scratch where
Pi writes its session files) and **never include the policy files themselves**.
The workspace mounts read-only, so `.gaia/config.json` and per-agent `agent.json`
are unwritable by default; widening `writable` to all of `.gaia` would re-expose
them, and since the next summon re-reads `config.json` from disk, a worker could
write itself a weaker policy for the following turn. Pin a summoned agent's
`sandbox` block in its `agent.json` (which lives in `~/.gaia`, outside the
workspace mount) so its isolation can't be downgraded from inside the workspace.

Two deliberate defaults: **summons default to `enabled: true`** (the riskier,
agent-spawned turns opt into isolation first), and resolution is **fail-closed**
— if a policy enables a backend that isn't available on this machine, the turn
refuses to run rather than silently dropping to no isolation. The backend
defaults to `none`, so until a workspace names a real backend nothing is actually
isolated yet — an enabled policy with no configured backend is a safe no-op, and
summons never break for lack of a runtime.

## Summons

A summon is a private worker turn that runs as a **nested child room**. Trigger
one from the composer with `/summon <agent> <task>`, or give an agent the
`summon` tool and let it call workers itself. Each summon opens a sub-room under
the calling room in the tabs tree; its transcript is its own, and the parent sees
the worker's final result.

Fan several summons out at once and they run in parallel — that is the swarm.
`maxSummonsPerRoom` in `.gaia/config.json` (default 8) bounds how many run
concurrently per room. Summoned workers are sandbox-enabled by default (see
**Sandbox**).

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
    memory/
      MEMORY.md
      USER.md
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
- `harness`: which backend runs the agent — `pi` (default), `codex`, or
  `claude`; falls back to `.gaia/config.json`'s `harness`, then `pi` (see
  **Harnesses**)
- `permissionMode` (Claude harness only): Claude Code permission mode, e.g.
  `plan` for a no-edit planning posture (`default`, `acceptEdits`, `plan`, …)
- `sandbox`: per-agent isolation policy (`enabled`, `backend`, `writable`,
  `net`) that overrides the workspace default (see **Sandbox**)

## Prompt layering

The system prompt for each agent session contains:

1. global agent `persona/SOUL.md`
2. active role prompt, if set
3. optional project agent `persona/INTENT.md`
4. project `AGENTS.md` files, discovered from parent dirs to current dir

Each turn prompt then adds:

5. the agent's memory block (`persona/memory/`), only when it changed since
   the last turn
6. new room events since that agent's cursor
7. newest user message

Memory travels in the turn prompt instead of the system prompt so memory
writes never force a session reload mid-conversation. The room cursor is a
transcript line count for this MVP. It prevents injecting the same room
events again and again.

## Memory

Each agent owns a `persona/memory/` directory with three tiers:

- `MEMORY.md` (cap 4,000 chars) — durable agent notes and an index of topic
  files; always in the agent's context
- `USER.md` (cap 2,000 chars) — what the agent knows about you; always in
  the agent's context
- topic files (cap 10,000 chars each) — anything that doesn't earn
  always-in-context status, e.g. `debugging.md` or `agents/sidia.md` (notes
  about another agent); the agent reads them on demand

Agents with the `memory` tool curate these files themselves
(add/replace/remove/read/list). The tight caps are deliberate: when a file
nears its limit the tool tells the agent to consolidate, and a write that
would exceed the cap errors instead of silently dropping content. Writes
that look like secret material (private keys, API-key shapes) are rejected.

Agents with the `recall` tool can additionally full-text search the entire
room history — every past session, beyond the transcript window — backed by
a zero-dependency SQLite FTS5 index (`recall.db` next to the transcript;
derived data, safe to delete).

Memory files are plain markdown: read them, edit them by hand, or use the
settings UI (they appear under each agent's Memory group). Pre-release
layouts with a single `persona/MEMORY.md` migrate automatically on load.

Under the `claude` and `codex` harnesses the agent reaches these same files
through the `gaia` CLI rather than an in-process tool; the data, caps, and
secret-filtering are identical (see **Harnesses**).

## Project-local agent overlays

You can customize an agent for one project without changing the global persona.

Examples:

```text
.gaia/agents/gaia/persona/INTENT.md       # project-local intent/instructions
.gaia/agents/gaia/persona/roles/plan.md   # project-local role overlay
.gaia/agents/gaia/agent.json              # override metadata/tools/model for this project
```

Pre-release layouts that kept these files at the agent root (e.g.
`~/.gaia/agents/gaia/SOUL.md`) are migrated into `persona/` automatically the
next time the agent loads.

## Workspace files

### `AGENTS.md`

Project instructions.
Use it for repo conventions, commands, constraints, safety notes, and preferences.

### `.gaia/config.json`

```json
{
  "defaultAgent": "gaia",
  "room": "default",
  "transcriptWindow": 20
}
```

Optional keys:

- `"harness"` (`pi` | `codex` | `claude`) sets the default harness for every
  agent in the workspace; per-agent `agent.json` overrides it (see **Harnesses**)
- `"maxSummonsPerRoom"` bounds concurrent summons per room (default 8, see
  **Summons**)
- `"sandbox"` sets the workspace-wide isolation policy, overridden per agent
  (see **Sandbox**)

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
- Three harnesses ship: `pi` (default), `claude`, and `codex` (see **Harnesses**).
  `claude`/`codex` ride your logged-in subscriptions via their own CLIs.
- OS-level isolation is a swappable sandbox that wraps the per-turn runner
  (`none` by default, Apple `container` available); summons run sandboxed by
  default (see **Sandbox**).
