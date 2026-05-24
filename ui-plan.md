# Web UI Notes

## Current shape

GAIA now ships a minimal web UI without a frontend bundler.

- `gaia` starts the Node server in `src/web/server.ts`
- Node serves `web/index.html` and `web/src/*` directly
- frontend uses plain browser-side code in `web/src/main.ts`
- transport is HTTP + SSE
- settings/file edits use explicit save
- legacy terminal UI remains behind `gaia tui`

## Why no Vite

Keeping dependencies small matters more than bundling right now.
The current frontend works as direct-served source files, so Vite is not required.

## Refactor seams

Most likely next cleanup:

- split `web/src/main.ts` into smaller modules
- add API/server tests around `src/web/server.ts`
- add light browser-side smoke coverage
- keep docs aligned with actual runtime behavior
