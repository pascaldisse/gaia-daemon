# CLAUDE.md

@AGENTS.md

The file above is the law of this repo — read it first. RULE #0 (the harness
abstraction is absolute, no per-harness branches in shared code) is a hard
regression when broken.

## Docs map

- `AGENTS.md` — project rules (imported above)
- `DESIGN.md` — v2 architecture: layering, WAL turn protocol, durable queue
- `MEMORY-DESIGN.md` — Memory v4: union store, local-first embeddings, global hybrid recall, loud health (v3 archived in `docs/history/`)
- `REPLACEMENT.md` — feature-parity roadmap (all gaps shipped)
- `README.md` — user-facing overview + CLI
- `docs/IMPORT.md` — importing a claude.ai data export (`scripts/import-claude-export.ts`)

## Commands

- `npm run dev` — run daemon via tsx (no build step; web/src is served as-is)
- `npm run check` — typecheck daemon (`tsconfig.json`) + web (`web/tsconfig.json`, strict checkJs)
- `npm test` — `tsx --test test/**/*.test.ts`
- `npm run stop` / `restart` — daemon listens on :8787
- `gaia` CLI = `src/cli.ts` (`dist/cli.js` after build); subcommands include
  `serve`, `setup`, `__run-agent`, `__sandbox-exec`

## Layering (imports point down only)

`server → daemon → services → harness → domain → core`
Wire contracts live in `src/harness/protocol.ts`.

## Subsystem quick map

<!-- keep this section current when moving these files -->
- Every on-disk path is computed ONCE in `src/core/paths.ts`; every shared type lives in `src/core/types.ts`.
- Personas ("agents" in code): seed/scaffold/loader `src/domain/agents.ts`; on disk `~/.gaia/agents/<id>/` (`agent.json` + `persona/SOUL.md` + `persona/memory/`). Model = `agent.json` `model.name` (claude harness passes it as `--model`; aliases: fable/opus/sonnet/haiku).
- System prompt assembly (SOUL → role → INTENT → AGENTS.md chain): `src/harness/prompt.ts`.
- Harness specs: `src/harness/spec.ts`, per-harness `src/harness/<x>.ts` (data-on-spec, no id branches).
- Rooms + turn WAL + durable queue: `src/domain/rooms.ts` (`RoomHandle`, single writer) + `src/domain/workspace.ts`; on disk `<workspace>/.gaia/rooms/<id>/` (`transcript.jsonl` + `state.json`; `recall.db` is derived). Orchestration: `src/services/room-service.ts`.
- Memory v3: `src/domain/{memory,facts,episodes,memory-index}.ts` (core MD files + `facts.jsonl` + `episodes.jsonl` + derived `index.db`), service layer `src/services/memory-service.ts`, consolidation `src/services/consolidate.ts`.
- HTTP surface: `src/server/http.ts`; daemon: `src/daemon.ts`.
- Web client: `web/src` — plain JSDoc-typed .js, may NOT import `src/` (no build step)
