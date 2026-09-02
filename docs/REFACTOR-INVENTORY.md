# v1 Refactor Inventory

Scope → source facts; baseline `6be4997` (main merged 2026-09-02).
Methods → `find`/`wc`; `rg`; basename direct-test convention; rough function spans = next declaration.

## Size

| rank | src TS | lines |
|---:|---|---:|
| 1 | services/room-service.ts | 4441 |
| 2 | server/http.ts | 2084 |
| 3 | daemon.ts | 1567 |
| 4 | core/types.ts | 1380 |
| 5 | harness/pi.ts | 1262 |
| 6 | domain/workspace-index.ts | 1212 |
| 7 | services/read-aloud.ts | 1174 |
| 8 | domain/rooms.ts | 1159 |
| 9 | services/summons.ts | 1131 |
| 10 | services/voice.ts | 1013 |

`src`: 36,558 lines; `web/src/*.js`: 14,843 lines; `test/*.test.ts`: 89.

| rank | web JS | lines |
|---:|---|---:|
| 1 | settings.js | 1392 |
| 2 | composer.js | 1290 |
| 3 | transcript.js | 1155 |
| 4 | statusbar.js | 809 |
| 5 | actions.js | 774 |
| 6 | archtree/renderer.js | 706 |
| 7 | readaloud.js | 684 |
| 8 | sidebar.js | 650 |
| 9 | events.js | 648 |
| 10 | dictation.js | 646 |

## Layering → upward imports

Search → `src/{harness,domain,core}` imports `../{server,daemon,services}`.

| file | import |
|---|---|
| harness/tools-pi.ts | services/artifacts.ts |
| harness/tools-pi.ts | services/caryll.ts |
| harness/tools-pi.ts | services/web-search.ts |
| harness/tools-pi.ts | services/web-fetch.ts |

Count: 4. Domain/core: 0. All 4 → harness→services inversion.

## Harness-id search

Scope excludes `harness/pi.ts`, `harness/spec.ts`; regex `harness ?===|harness ?!==|"pi"|"claude"|"codex"`.

Count: 18 textual matches; explicit `harness === "<id>"` / `!== "<id>"`: 0.

| file:line | context |
|---|---|
| services/read-aloud.ts:1102 | TTS engine id `"claude"` |
| services/voice.ts:57 | Claude voice daemon setting comment |
| core/harness-id.ts:2-3 | Pi canonical id; Claude/Codex legacy-id normalization |
| core/config.ts:11 | default harness `"pi"` |
| domain/skills.ts:22,70 | Pi skill-source label; `~/.pi` discovery |
| harness/proc.ts:17 | obsolete CLI examples in command comment |
| core/types.ts:1089 | comment: prohibited Claude branch |
| services/room-service.ts:4274 | comment: no Claude branch |
| services/hints.ts:289,454 | generic harness equality / config lookup |
| server/http.ts:961-962 | generic account-harness compatibility check |
| domain/agents.ts:94 | generic `harness` / legacy `runtime` field selection |
| domain/accounts.ts:47 | generic record validation |
| harness/host.ts:824 | generic account-harness compatibility check |

## Pi-only / removed-harness residue

| item | observed fact |
|---|---|
| `supportsForkAtMessage` | interface/consumers; one `true` implementer: harness/pi.ts:450 |
| `credentialProxy` | optional spec/host plumbing; one implementer: harness/pi.ts:1247 |
| `resetRoom` | required `AgentRuntime` method; one implementation: PiRuntime at pi.ts:660 |
| legacy ids | core/harness-id.ts maps `claude`, `codex`, `antigravity` → `pi` |
| legacy config field | domain/agents.ts:34,94 accepts `runtime` alias |
| web Claude/Codex | mostly visual/reference comments; operational names: `pet.js` / `pet-state.js` Codex-pet compatibility; transcript.js:1055 tool-name compatibility comment |
| scripts | scripts/import-claude-export.ts imports Claude.ai export; usage comment says `tsx` |
| setups | 3 setup manifests: fugu, fugu-trinity, monad; no harness-id reference |
| Knip | `bunx knip` 6.34.0; no config; reports 109 unused files + 59 exported types → candidate-only |

Knip function/value candidates reported: `sandboxBackend` (harness/sandbox/spec.ts:139); `parseHarness` (harness/spec.ts:561); usage constants/parsers (harness/usage.ts:40-53); `codexPetsRoot`/`isValidPetPackageName` (server/pet.ts imports); `RESERVED_AUTHORS` (services/commands.ts:263); `CONSOLIDATE_STATE_FILE`/`runsInLastDay` (services/consolidate.ts:19,50); `keepAwakeSupported` (services/keep-awake.ts:38); `resolveSetup`/`buildMonadConfig` (services/setups.ts:115,172).

## God functions (>120 rough lines)

| lines | file | function | start |
|---:|---|---|---:|
| 944 | server/http.ts | `handleApi` | 636 |
| 490 | services/room-service.ts | `runAgentTask` | 1389 |
| 301 | server/http.ts | `handleHarness` | 1594 |
| 218 | server/http.ts | `reloadNow` | 409 |
| 190 | services/room-service.ts | `sendMessage` | 685 |
| 125 | services/room-service.ts | `configureRoomServiceReload` | 348 |

No `harness/pi.ts` function exceeded threshold by declaration-span metric.

## Duplicate-pattern candidates

| pattern | locations |
|---|---|
| global `~/.gaia` path construction | core/paths.ts canonical; services/plugins.ts:148; services/room-service.ts:251; services/stt-apple.ts:114; server/http.ts:101+; harness/pi.ts:1192 |
| `~/` expansion | server/http.ts:2043; harness/host.ts:87-88; harness/image-read.ts:78 |
| transcript reads | services/summons.ts:237; domain/workspace-index.ts:361,1112; canonical path core/paths.ts:101 |
| local `sleep` | server/http.ts:92; services/voice.ts:384; harness/reaper.ts:103 |
| retry/backoff loops | server/http.ts:328; core/sqlite.ts:63-91; services/read-aloud.ts:876/963; services/room-service.ts:2137-2221 |
| JSON-response helper | `rg` `jsonResponse|Response.json|new Response(JSON.stringify` → 0 exact hits; server/http.ts uses local `json(...)` |

## Durability / bridges facts

- domain/rooms.ts:6-14 → queue persisted; pending turn WAL; transcript then atomic state write; resume check.
- core/types.ts:228-237 → queued `eventId` reserved before append; `recorded` idempotency.
- domain/rooms.ts:1035-1093 → queue persistence; reservation; queue→pending atomic custody transfer.
- core/types.ts:383-384 → `pendingTurn`, `queue` state fields.
- Telegram formatter is `services/telegram-bridge-format.ts`; comments identify separate `scripts/telegram-bridge.mjs` process.

## Direct-test gaps ≥200 lines

Metric → no basename-matched `test/<basename>.test.ts`; not claim of no indirect coverage.

| lines | src file |
|---:|---|
| 2084 | server/http.ts |
| 1567 | daemon.ts |
| 1380 | core/types.ts |
| 1262 | harness/pi.ts |
| 900 | harness/host.ts |
| 740 | harness/tools-pi.ts |
| 568 | harness/spec.ts |
| 567 | services/setups.ts |
| 478 | domain/agents.ts |
| 424 | core/config.ts |
| 326 | services/embed-sidecar.ts |
| 319 | domain/memory.ts |
| 251 | harness/runner.ts |
| 247 | harness/usage.ts |
| 231 | core/store.ts |
| 226 | cli.ts |
| 221 | services/stt-apple.ts |
| 205 | services/usage-service.ts |
| 200 | harness/image-read.ts |

Indirect imports found for: server/http, daemon, core/types, harness/pi, harness/host, harness/tools-pi, harness/spec, services/setups.

## Gate

`bun run check` → FAIL. `src/harness/host.ts:407:45` TS2322: `"compact-clean"` not assignable to `"compact" | "compact-draft" | "compact-apply"`.
