# GAIA Plan

## Current base

Implemented now:

- project-local `.gaia/` workspace
- `gaia init` workspace scaffolding
- workspace `SYSTEM.md`
- folder-based agent loading from `.gaia/agents/*`
- sample agents: `gaia`, `sidia`, `terry`
- per-agent `SOUL.md` and `MEMORY.md`
- default-agent routing
- deterministic `@agent` mention routing
- multiple mentions in first-mentioned order
- unknown-agent errors
- room transcript at `.gaia/rooms/default/transcript.jsonl`
- recent transcript injected into agent turns
- per-agent memory tool writing to local `MEMORY.md`
- simple runtime seam with Pi as the only runtime
- slash commands trimmed to app control: `/help`, `/agents`, `/quit`
- README updated for workspace mode
- old hardcoded persona switching and Monad orchestration removed

## Remaining work

### 1. Tests

Add coverage for:

- workspace loading
- routing
- transcript reads/writes
- memory mutations
- runtime prompt assembly

### 2. Small polish

- optional `/memory` and `/room` inspection commands
- cleaner transcript formatting
- better startup errors and validation
- optional model overrides per agent in `agent.yaml`

### 3. Later direction

Not for now, but still interesting:

- smarter Monad-style routing
- shared workspace memory if needed
- stronger isolation and tool audit
- richer TUI or web UI
- more runtimes beyond Pi
