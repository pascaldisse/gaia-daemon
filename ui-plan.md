# Web UI Refactor Plan

## Summary

Build the real UI as a minimal vanilla TypeScript web app with a Node backend. The `gaia` command starts the web UI by default, prints the local URL, and serves both the static frontend and GAIA API. Keep the Pi SDK in the Node process; do not move core runtime logic into the browser or Tauri.

The implementation path:

- UI-neutral GAIA core controller
- HTTP API for snapshots, settings, workspaces, rooms, and messages
- SSE stream for chat/task events
- Vanilla TS component system inspired by `ui-test/index.html`
- Tauri-ready frontend with no direct Node/file access

## Key Changes

- Split room orchestration from terminal rendering.
- Keep the old terminal UI behind `gaia tui`.
- Make `gaia` start the web app by default.
- Add a command/capability registry shared by CLI/TUI/web.
- Add a global recent-workspaces registry.
- Whitelist editable files through descriptors, not arbitrary browser-submitted paths.
- Use explicit save for settings edits.
- Render JSON and Markdown as settings-like controls with a raw toggle.

## Interfaces

- UI-neutral events: `snapshot`, `room-event`, `task-start`, `text-delta`, `tool-start`, `tool-end`, `task-end`, `task-error`, `settings-saved`.
- Controller methods: `loadWorkspace`, `listWorkspaces`, `listRooms`, `getSnapshot`, `sendMessage`, `getEditableFiles`, `readEditableFile`, `writeEditableFile`.
- HTTP/SSE API:
  - `GET /api/app`
  - `POST /api/workspaces`
  - `GET /api/workspaces/:id/snapshot`
  - `POST /api/workspaces/:id/rooms/:roomId/messages`
  - `GET /api/events?workspaceId=...&roomId=...`
  - `GET /api/files/:fileId`
  - `PUT /api/files/:fileId`

## Frontend

- Vanilla TypeScript, Vite-compatible file layout.
- Reusable components for sidebar, transcript, composer, room/workspace panels, settings modal, and file settings editors.
- Terminal-like retro-future visual direction from `ui-test/index.html`.
- UI lists generated from backend snapshot data wherever possible.

## Long-Running Task Design

- V1 supports one active agent turn per room.
- Each turn is represented internally as a task with id, room id, targets, status, timestamps, and streamed events.
- Task status is exposed in the Room panel now, with room for future queueing/cancellation.

## Test Plan

- Controller tests with fake runtimes.
- Command registry and legacy slash command parsing tests.
- Editable-file whitelist tests.
- API tests for snapshots, messages, files, and SSE event formatting.
- Frontend build check once Vite is installed in the environment.
- Keep `npm test`, `npm run check`, and production build passing.

## Assumptions

- Frontend stack: vanilla TypeScript + Vite-compatible layout.
- Transport: HTTP + SSE.
- Workspace selection: recent workspaces plus add-by-path.
- Save behavior: explicit save.
- Chat v1: single active turn per room.
- `gaia` starts the web UI; old terminal UI remains as `gaia tui`.
- Tauri later wraps the same built frontend and launches the Node GAIA backend as a sidecar.
