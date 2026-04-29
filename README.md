# GAIA Pi Wrapper

`gaia` is a minimal standalone CLI agent wrapper around the Pi SDK. V1 focuses on three personas, mode switching, Pi coding tools, and bounded markdown memory.

## Setup

```bash
npm install
npm run build
npm link   # optional, exposes `gaia`
gaia init
```

Configure Pi auth/model settings the same way you configure Pi itself (`pi /login` or provider API-key environment variables). Optional GAIA config lives at `~/.gaia/config.yaml`.

## Run

```bash
gaia
```

Slash commands:

- `/gaia` — warm constructive Gaia mode
- `/sidia` — skeptical critical Sidia mode
- `/monad` — director mode that routes through Monad, then Gaia/Sidia
- `/help` — command help
- `/quit` — exit

## Memory

Markdown memories live under `~/.gaia/memories/`:

- `USER.md` shared user profile/preferences
- `GAIA.md` Gaia-specific notes
- `SIDIA.md` Sidia-specific notes

Memory is injected as a frozen snapshot when each persona session starts. Memory writes persist immediately through the `memory` tool, but active prompts refresh on the next run.

## Scope

Implemented now: project skeleton, config, persona prompts/sessions, readline terminal UI, slash mode switching, markdown memory, simple Monad orchestration, Pi tools, and conservative safety confirmation for risky tool calls.

Deferred: web search, Python science tools, generated HTML artifacts, richer subagents, external memory providers, gateway/background daemon, voice, and web UI.
