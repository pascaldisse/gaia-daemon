# GAIA Project Notes

## Current shape

Implemented now:

- global agents under `~/.gaia/agents/`
- project workspace under `.gaia/`
- web UI is default entrypoint
- Node serves frontend files directly from `web/`
- legacy terminal UI remains behind `gaia tui`
- HTTP + SSE controller flow for rooms, tasks, and settings
- project and global editable file registry
- persistent Pi session per room-agent pair
- role overlays, `@agent` routing, and shared room transcript
- tests pass for controller, runtime, roles, routing, state, and workspace loading

## Known simplifications

- no frontend bundler
- Pi is the only runtime
- one active task per room
- browser UI still lives mostly in `web/src/main.ts`

## Likely next refactor

- split `web/src/main.ts` by API, events, composer, transcript, and settings views
- add more server/API coverage
- keep README and project notes aligned with shipped behavior
