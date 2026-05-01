# GAIA Plan

## Current base

Implemented now:

- global personas under `~/.gaia/agents/`
- `GAIA_HOME` override for the global persona home
- `gaia init` seeds global sample personas
- project-local `AGENTS.md` for repo instructions
- project-local `.gaia/config.yaml`
- project-local room transcript at `.gaia/rooms/default/transcript.jsonl`
- sample personas: `gaia`, `sidia`, `terry`
- global per-agent `SOUL.md` and `MEMORY.md`
- project-local agent overrides/appends:
  - `.gaia/agents/<id>/SOUL.md`
  - `.gaia/agents/<id>/APPEND_SOUL.md`
  - `.gaia/agents/<id>/agent.yaml`
- default-agent routing
- deterministic `@agent` mention routing
- multiple mentions in first-mentioned order
- unknown-agent errors
- recent transcript injected into agent turns
- memory tool writing to global agent `MEMORY.md`
- simple runtime seam with Pi as the only runtime
- slash commands trimmed to app control: `/help`, `/agents`, `/quit`
- README updated for global personas + project context
- old hardcoded persona switching and Monad orchestration removed

## Remaining work

### 1. Tests

Add coverage for:

- global persona initialization
- project workspace initialization
- AGENTS.md discovery order
- project-local soul override/append behavior
- agent config merge behavior
- routing
- transcript reads/writes
- memory mutations
- runtime prompt assembly

### 2. Small polish

- optional `/memory` and `/room` inspection commands
- cleaner transcript formatting
- better startup errors and validation
- clearer docs for model overrides per agent

### 3. Later direction

Not for now, but still interesting:

- smarter Monad-style routing
- optional project-local memory if explicitly requested
- stronger isolation and tool audit
- richer TUI or web UI
- more runtimes beyond Pi
