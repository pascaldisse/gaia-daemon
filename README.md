> ⚠️ **HARNESS ABSTRACTION — ABSOLUTE RULE (see [AGENTS.md](AGENTS.md) §RULE #0).** pi/claude/codex are interchangeable harnesses behind ONE abstraction. Implement every capability ONCE at the abstraction layer (harness registry / RunnerHost / runner) so it applies to ALL harnesses — present, unimplemented, and future. NEVER special-case a harness, NEVER `if (harness === "pi")` in shared code, NEVER touch the thing underneath. A harness may ONLY declare its own wiring as DATA on its spec.

# GAIA Daemon

`gaia` is a local-first multi-agent workspace built on the Pi SDK.

> **v2.** This is the from-scratch rewrite: same concepts, same on-disk
> formats (v1 workspaces open unchanged), same HTTP+SSE surface — restructured
> into strict layers (`core → domain → harness → services → daemon → server`),
> with durability guaranteed by protocol (a write-ahead turn journal and a
> persisted message queue), runtime details stored on transcript events
> forever, and a web client that is honest, typed JavaScript. The autopsy of
> v1 is in [CRITIQUE.md](CRITIQUE.md); the architecture in
> [DESIGN.md](DESIGN.md).

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
  each agent message shows the model that actually produced it, and the
  composer shows the target agent's live model + context-window usage — with
  a warning chip when the provider switched models mid-turn (e.g. a Fable →
  Opus capacity/safety fallback)
- voice calls per agent through the vendored unmute stack (`unmute/`)
- sample global agents: `@gaia`, `@sidia`, `@terry` (plus `@dario`, the
  thanks-dario reviewer — see below)
- slash commands: `/help`, `/agents`, `/roles`, `/role`, `/summon`,
  `/thinking`, `/clear`, `/fork`, `/setup`, `/consolidate`, `/compact`,
  `/recall`, `/schedule`, `/steer`, `/cancel` (alias `/stop`), `/rewind`,
  `/thanks-dario` (alias `/dario`)
  (`/compact` invokes the harness's own session compaction — pi
  `session.compact()`, claude's headless `/compact`, codex
  `thread/compact/start` — never a gaia re-implementation)
- claude.ai-style message forking, uniform across harnesses: ✎ edit any user
  message (re-sends from that point) or ⟳ retry any reply (regenerates it);
  later events are rewound — preserved in the room's `rewound.jsonl`, never
  deleted — sessions reset, and the kept transcript window replays
- paste images & files straight into the composer (plain system paste, no
  button): previews above the input, bytes stored durably under the room's
  `files/` dir, and every harness gets them uniformly — images natively
  (pi prompt images, claude stream-json image blocks, codex `localImage`
  items), everything else as on-disk path breadcrumbs any agent can open
  with its file tools
- dynamic selectable previews for `/` commands and `@` agents
- **thanks-dario mode**: when a provider-side safety classifier keeps
  rerouting a room's model (e.g. Fable → Opus), `/thanks-dario` summons
  `@dario` — a seeded reviewer persona (DeepSeek by default, repointable with
  `/model @dario …`) — who reads the replay window and proposes minimal
  redactions; a popup shows his strategy options and a before/after diff, and
  only approved edits are applied: originals are preserved in the room's
  `redactions.jsonl` (rewritten messages carry a ✂ tag), sessions reset, and
  the next turn replays the sanitized history. `/thanks-dario on` auto-runs
  the review whenever a model-fallback lands in the room
- settings stay plain text files; the formatted view renders smart controls
  from server-computed hints

Environment overrides: `GAIA_HOME` (global home, default `~/.gaia`) and
`GAIA_HOST` / `GAIA_PORT` (web-server bind address, default `127.0.0.1:8787`;
port `0` picks a free one).

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

### Read aloud (the transcript play button)

Every committed agent message carries a ▶ button that speaks it: the server
strips markdown for speech (code blocks, links, tables, emoji; tool calls are
never part of the text), synthesizes with the author's TTS engine, and streams
a WAV back. Engines are registered as data (`src/services/read-aloud.ts`) and
selected per agent:

- `kyutai` (default) — the bundled unmute TTS service, auto-started on demand
- `claude` — a local claude-voice daemon (separate project) speaking with the
  claude.ai "Read aloud" voices (`airy | buttery | mellow | glassy | rounded`)
  through your own account; GAIA calls its `POST /synthesize` endpoint

Per-agent choice lives in `agent.json`:

```json
"tts": { "engine": "claude", "voice": "airy" }
```

Global defaults live in `~/.gaia/voice.json`: `ttsEngine` (fallback engine),
`claudeVoiceUrl` (default `http://127.0.0.1:8778`) and `claudeVoiceDir` (a
claude-voice checkout to auto-start when its daemon is down; empty = never).

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
  `read-only`. `memory`, `recall`, and `summon` are real Codex tools: the same
  tool implementations pi uses are declared as `dynamicTools` on the thread and
  executed in-process by the daemon when Codex calls them.

For the `claude` harness, `memory`/`recall`/`summon` are delivered through a
small `gaia` CLI the agent runs (reads go straight to disk; writes and summon
call back to the running daemon, which stays the single writer) — no MCP
required for gaia's own tools, though external `mcpServers` from settings are
passed through. The `claude`/`codex` providers are locked in the settings UI to
Anthropic / OpenAI-Codex models respectively.

## Sandbox

Because every harness runs a turn in the same `gaia __run-agent` subprocess, the
daemon can wrap that one process in an OS-level sandbox — uniformly, with no
knowledge of which harness is inside. Backends are swappable: adding one is a new
`src/harness/sandbox/<name>.ts` that calls `registerSandbox(...)` plus one import
line, the daemon analogue of a single-file container-runtime swap.

Two backends ship (plus the swap seam for more):

- **`macos-seatbelt`** (the default real backend; the only one shipped enabled) —
  wraps the launch in `sandbox-exec`. It ships with macOS, so it needs no image or
  daemon and works out of the box. Posture, two axes:
  - **Writes (allowlist):** confined to the workspace (git-tracked, recoverable),
    temp, and regenerable caches; the rest of the host is read-only. Two carve-outs
    stay read-only even inside the writable trees — the policy files
    (`config.json`, project `agent.json`) and the pi credential store
    (`~/.pi/agent/auth.json`) — so a turn can neither rewrite its own governance
    nor tamper with keys it can read.
  - **Reads (denylist):** a sensitive set is denied — SSH / cloud / CI
    credentials, keychains, `~/Documents`, `~/Desktop`, `~/Downloads` — with the
    workspace and `GAIA_HOME` re-allowed on top, so a confined turn can't
    exfiltrate unrelated secrets. Residual, stated plainly: it can't hide the
    turn's *own* provider key (it's in the env), and non-sensitive host files stay
    readable; airtight read-isolation is the deferred credential-proxy work
    (see `HANDOFF-SANDBOX.md`).
- **`none`** — the identity launch, no isolation. The posture for a *trusted*
  agent (see below).

**One confinement entrypoint.** `gaia __sandbox-exec --backend … --cwd …
[--writable …] [--deny-read …] [--readonly-cwd] -- <argv>` builds a launch with
the same resolver the daemon uses and execs it — the single place a sandbox is
constructed. External callers (the pi skill's launcher) confine through it instead
of rolling their own profile, so pi jobs and gaia summons get the identical
posture from one source.

Policy is resolved above the harness — an `agent.json` `sandbox` block overrides
the workspace `.gaia/config.json` one (`enabled`, `backend`, `writable`, `net`).
Two rules sit above that config, driven by the agent's **trust** flag:

- **Untrusted agents** (`trust: false`) can **never** run unsandboxed. They are
  forced enabled with a real backend, and no `sandbox` config can weaken that to
  `none`/disabled — only swap in a *different* real backend. This is the cheap or
  erratic tier (e.g. a DeepSeek worker): a scoped task and a room it can't trash.
- **Summons** (any agent running in a child room) default to a real backend too,
  so an agent-spawned turn is **never naked by default**. A *trusted* agent may
  override that — including back to `none` — but an untrusted one cannot.

Resolution is **fail-closed**: if the chosen backend isn't available on this
machine (e.g. an untrusted agent off macOS, where Seatbelt doesn't exist), the
turn refuses to run rather than silently dropping isolation. A trusted top-level
turn defaults to `none` (the trusted lead runs wide open).

## Summons

A summon is a private worker turn that runs as a **nested child room**. Trigger
one from the composer with `/summon <agent> <task>`, or give an agent the
`summon` tool and let it call workers itself. Each summon opens a sub-room under
the calling room in the tabs tree; its transcript is its own, and the parent sees
the worker's final result.

Fan several summons out at once and they run in parallel — that is the swarm.
`maxSummonsPerRoom` in `.gaia/config.json` (default 8) bounds how many run
concurrently per room. Summoned workers run sandboxed by default (see
**Sandbox**).

A summoned worker **cannot summon further workers by default** — it gets a scoped
task, not the keys to spawn its own swarm (this bounds runaway fan-out). An agent
opts back in with `allowNestedSummon: true` in its `agent.json`, but an untrusted
agent (`trust: false`) is refused regardless.

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
- `tts`: read-aloud engine + voice for the transcript play button, e.g.
  `{ "engine": "claude", "voice": "airy" }` (string shorthand `"claude:airy"`
  also works); default engine comes from `voice.json`'s `ttsEngine`
- `harness`: which backend runs the agent — `pi` (default), `codex`, or
  `claude`; falls back to `.gaia/config.json`'s `harness`, then `pi` (see
  **Harnesses**)
- `permissionMode` (Claude harness only): Claude Code permission mode, e.g.
  `plan` for a no-edit planning posture (`default`, `acceptEdits`, `plan`, …)
- `sandbox`: per-agent isolation policy (`enabled`, `backend`, `writable`,
  `net`) that overrides the workspace default (see **Sandbox**)
- `trust`: trust tier (default `true`). `trust: false` forces the agent into a
  sandbox it can't configure away, and bars it from summoning (see **Sandbox** /
  **Summons**) — the tier for cheap or untrusted models
- `allowNestedSummon`: let this agent summon further workers when it is itself a
  summon (default `false`; ignored for untrusted agents — see **Summons**)

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
- OS-level isolation is a swappable sandbox that wraps the per-turn runner. On
  macOS it defaults to a real `sandbox-exec` backend; summons and untrusted
  (`trust: false`) agents are sandboxed by default, the latter unconditionally
  (see **Sandbox**).
