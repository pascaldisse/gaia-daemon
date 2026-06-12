# Web UI Notes

## Current shape

GAIA ships a web UI without a frontend bundler.

- `gaia` starts the Node server in `src/web/server.ts`
- Node serves `web/index.html` and `web/src/*` directly as ES modules
- transport is HTTP + SSE
- settings/file edits use explicit save

## Module layout (`web/src/`)

- `main.ts` — entry; installs global listeners and loads the app
- `dom.ts` — `h()` hyperscript helper
- `state.ts` — shared mutable UI state + `activeTask`
- `api.ts` — fetch wrapper
- `actions.ts` — app/workspace/message/cancel actions
- `events.ts` — SSE connection and streaming merge logic
- `render.ts` — root render, shell views (sidebar, topbar, room panel), `setError`
- `transcript.ts` — transcript, messages, thinking/tool activity
- `composer.ts` — composer, autocomplete, keyboard routing, focus
  management, thinking-effort control, on-call mute/hang-up buttons
- `settings.ts` — workspace panel, global settings modal (General / Voice /
  Agents tabs), file editors
- `voice.ts` — voice calls: unmute WebSocket client, opus mic capture,
  TTS playback worklet, live STT transcription into the composer
- `links.ts` — path/url detection, cmd/ctrl-click open targets
- `markdown.ts` — lightweight markdown rendering

Audio assets vendored from the unmute frontend live in `web/vendor/`
(opus-recorder UMD + encoder/decoder workers + output worklet).

All files are plain browser JavaScript under `.ts` paths; the server maps
`.ts` to `text/javascript`. Cross-module cycles (e.g. views → actions →
render → views) are function-level only and safe in browser ESM.

## Settings field hints

The formatted settings view is hint-driven. `/api/files/:id` responses carry
an optional `hints` object computed server-side (`src/app/settings-hints.ts`)
from live sources: workspace agents and rooms, Pi's model registry (with auth
status per provider), SDK tool names, and thinking levels. Hints map a
normalized JSON path to a generic input descriptor:

- `select` (with optional `(not set)` that omits the key on save)
- `multiselect` (checkbox chips, used for `tools`)
- `number`
- `boolean` (true/false select, serialized back as a JSON boolean)
- dependent selects via `groupBy` (model list filters by chosen provider)

The frontend renderer (`settings.ts`) has no per-field knowledge; hinted
fields missing from the file render as unset rows so e.g. `model.provider`
is editable on an agent.json that has no model block yet. Files on disk stay
plain JSON.

## Why no Vite

Keeping dependencies small matters more than bundling right now.
Direct-served source modules work, so Vite is not required.

## Next seams

- add API/server tests around `src/web/server.ts`
- add light browser-side smoke coverage
- editable voice transcription before auto-commit (see plan.md follow-ups)
