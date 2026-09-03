# PASS 5 · W3 static adversarial sign-off — naru-sonnet

worktree=.gaia/worktrees/naru-sonnet-mtkrd6109tbgfp · branch=adversary/pass5-static-sonnet · baseline=a995bb0 (verified HEAD, clean, no ledger commit atop). Root checkout untouched (never entered).

## Verdict: ADV-020..023 all PASS (findings-only; no fixes applied)

### ADV-020 · bundled command plugins unreachable
- fix commit f218e91.
- repro test/dog-mode-integration.test.ts → 8 pass · 0 fail (was 0/8 pre-fix per ledger).
- inventory test/bundled-plugins.test.ts → 4 pass · 0 fail.
- PASS.

### ADV-021 · durable plugin command replies + capability denials
- fix commits 077d846 + 1dc052a + a995bb0.
- persistence-seam trace (independent code-path proof, not re-running the same computation):
  - src/domain/rooms.ts:737 `commitAuxiliaryEvent(event)` → withRoomLock → `commitEventLocked` (src/domain/rooms.ts:1178).
  - src/domain/rooms.ts:1163 `commitTurn(event, nextPending)` (agent-reply path, used by turn-results.ts:90 commitReply) → withRoomLock → SAME `commitEventLocked`.
  - commitEventLocked (rooms.ts:1178-1186): idempotent check `hasEventLocked` → `appendJsonlDurable(transcriptPath, event)` → `readJsonlFrom` to locate committed line → ONE `updateStateLocked` atomic write (writeJsonAtomic, rooms.ts:702) acknowledging the cursor. Both callers share this single private primitive — one seam, two thin call sites differing only in the state-delta closure (commitTurn also swaps pendingTurn; commitAuxiliaryEvent only advances the author's cursor).
  - caller: src/services/room/turn-results.ts:139-150 `appendPluginEvent()` → `this.service.room.commitAuxiliaryEvent(event)` then live `emit()` — append-before-emit, matching commitReply's own append(commitTurn)-then-emit order.
  - caller: src/services/room/queue.ts:111-122 `sendMessage()` plugin-command branch now calls `this.service.appendPluginEvent(text, result.denial?"capability-denied":"plugin-reply", ...)` instead of the old transient-only `emit({type:"room-event"})` (confirmed removed — no remaining transient-only room-event emit for a plugin reply/denial in queue.ts).
  - second-path check: `rg -n "room-event" src/services/room/queue.ts` shows only the emit AFTER appendPluginEvent's own internal emit + the unrelated steer/other event emits — no bypass write path found.
- read-side: src/domain/rooms.ts:527 roomEventFrom()/eventDetailsFrom() allowlist extended with `plugin-reply`/`capability-denied` kinds + `pluginDenialFrom()` reconstructor (src/core/types/events.ts new `PluginDenial`, `EventDetails.pluginDenial`) — both new kinds and the new field round-trip on read, not silently dropped.
- test/room-service.test.ts new ADV-021 cases (2 of the 101): reply case re-reads via a FRESH RoomHandle instance after commit (independent read, not the same in-memory object) confirming on-disk transcript kind=plugin-reply; denial case asserts pluginId/capability/agentId/reason + zero plugin-body side-effect + denial log line, trust:false path.
- PASS — same append+atomic-state-write seam as agent replies; no second persistence path found.

### ADV-022 · manifest staging trigger + lifecycle observability
- fix commit 2177872.
- trigger sites: src/server/routes/api.ts new `POST /api/plugins/reload` → `daemon.pluginRegistry.stageReload()`; settings-file PUT handler (api.ts ~L538) now also calls `stageReload()` on every settings write and returns `pluginReload` in the response body.
- observability: src/daemon.ts new `pluginLifecycleLog()` + `onEvent` wired into the PluginRegistry constructor (src/daemon.ts:219) — staged/stage-failed/swapped/disposed/dispose-failed all logged with generation+pluginIds.
- test/plugins-registry.test.ts → 8 pass · 0 fail, incl. staged-while-turn-holds-generation + swap-at-boundary + ordered-lifecycle-events cases.
- PASS.

### ADV-023 · unexported lifecycle internals
- fix commit 2177872.
- `rg -n 'export.*(RegistryLifecycleError|PluginTurnLease)' src/services/plugins/registry.ts` → 0 hits (both declared as bare `class`, no `export`).
- PASS.

## New exports since ad85ee3 (src/**/*.ts) — consumer check
- `PluginDenial` (core/types via events.ts) → consumed services/plugins.ts:9 (PluginResult.denial) + events.ts:93 (EventDetails.pluginDenial). Consumed.
- `RoomEventKind` gains `plugin-reply`/`capability-denied` → consumed domain/rooms.ts:527 allowlist + services/room/queue.ts:120 kind selection. Consumed.
- `PluginContext` (= PluginCommandContext alias), `PluginPanel` re-export, `PluginRenderCap`, `PluginCommandContext`, `PluginCommandRequest`, `PluginPanelField`, `PluginAgent` (services/plugins/contracts.ts) → all consumed transitively through services/plugins.ts, room-service.ts, room/{ports,commands-facade,sanitize-facade}.ts, plugins/registry.ts. `PluginAgent` has no direct external import but is a structural field type of the consumed `PluginCommandContext.agents` — not dead.
- No orphaned export found.

## Scans (touched files: core/types/events.ts, daemon.ts, domain/rooms.ts, server/routes/api.ts, services/plugins.ts, services/plugins/contracts.ts, services/plugins/registry.ts, services/room-service.ts, services/room/{commands-facade,queue,turn-results}.ts)
- RULE0 (harness-id branch in shared code): `rg 'harness\s*===' <files>` → 0 hits. PASS.
- pragma scan (`@ts-ignore`/`@ts-nocheck`/`eslint-disable`): 0 hits. PASS.
- upward-import/layering: services/plugins/* import only sibling services+core (capabilities/types, capabilities/broker, manifest.js, loader.js) — no daemon/server import. daemon.ts and server/routes/api.ts import services downward only (PluginRegistry, daemon.pluginRegistry) — correct direction. 0 violations found.

## Gate
- `cd <worktree> && bun run check` → rc≠0 (tsc -p tsconfig.json --noEmit fails): `src/services/artifacts.ts` / `cli-tools.ts` / `tool-providers.ts` cannot resolve `../../design/src/artifacts.js` + `artifact-revisions.js` — `design/` is an EMPTY directory in this worktree (submodule/build artifact not checked out). Confirmed PRE-EXISTING: `git show ad85ee3:src/services/artifacts.ts` already contains the same `export * from "../../design/src/artifacts.js"` re-export at baseline, and none of the 6 range commits (f218e91..a995bb0) touch artifacts.ts/cli-tools.ts/tool-providers.ts/design/. Environmental gap, not caused by ADV-020..023. Matches f218e91's own commit message ("bun run check remains blocked by pre-existing missing design/src artifacts imports; plugin TypeScript diagnostics are clean").
- Touched test files since ad85ee3, run individually:
  - `bun test test/bundled-plugins.test.ts` → 4 pass · 0 fail
  - `bun test test/dog-mode-integration.test.ts` → 8 pass · 0 fail
  - `bun test test/plugins-registry.test.ts` → 8 pass · 0 fail
  - `bun test test/room-service.test.ts` → 101 pass · 0 fail (incl. both new ADV-021 focused cases)
  - `bun test test/rpg-plugin.test.ts` → 2 pass · 0 fail
  - **total: 123 pass · 0 fail** across 5 files.

## Orphan sweep
- `lsof -nP -iTCP:8787 -sTCP:LISTEN` → held by the pre-existing host gaia-daemon.app instance (pid 27333, started before this pass) — not spawned by this pass's `bun test` runs (all 5 files are in-process unit suites, no HTTP listener started/observed in their output). Never touched port 8787 or gaia-daemon.app myself.

## No findings
No severity-tier tickets opened — ADV-020..023 all verified FIXED against their exact REFACTOR-BUGS.md repros; persistence seam is provably shared (single `commitEventLocked` primitive); no orphaned exports; no RULE0/pragma/layering violations; gate green modulo the pre-existing unrelated design/src TS resolution gap.

**FIXES FORBIDDEN — none applied. Findings-only pass.**
