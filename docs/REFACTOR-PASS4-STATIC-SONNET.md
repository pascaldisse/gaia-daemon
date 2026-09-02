# REFACTOR PASS4 — Static Independent Review (陰根/Yama, naru-sonnet)

Scope: `4fda75d..338db79`. Baseline b98c3ce. Independent static inspection of ADV-014..019 vs docs/REFACTOR-BUGS.md repro expectations + closing architecture (broker real daemon sources/fail-closed, bundled manifests, plugins/rpg.mjs/, single registry/broker, lifecycle serialization/in-flight generation/dispose-once, edit/resend, dead duplicate absence, RULE0/harness-id branches/pragmas/upward imports/dead exports).

(section opened; findings appended below)

## ADV-014 · CapabilityBroker real daemon sources — VERIFIED FIXED
Repro: `sed -n '1,53p' src/services/capabilities/daemon-sources.ts` + `grep -n resolveWorkspaceGrantPolicy\|resolveWorkspaceTrust src/daemon.ts`.
Expected (per ROOT#9 closure) → daemon-owned grant/trust sources wired into `CapabilityBroker`, fail-closed on unresolved workspace/agent.
Actual → `daemon-sources.ts` reads `.gaia/config.json plugins.grants[agentId]` + `agent.json capabilities`; `resolveWorkspaceTrust` returns false when `agentFor` is undefined (unknown workspace/agent → untrusted). `daemon.ts:205-207` wires both into `new CapabilityBroker({...})` closing over `this.#liveWorkspaceFor` (sync, resident-cache only, no I/O — `daemon.ts:661-663`). Matches closure claim. No further action.

## ADV-015 · bundled plugins reach manifest runtime — CLAIM CONTRADICTED, NEW SEV-HIGH FINDING (ADV-020)
Closure claim (`docs/REFACTOR-BUGS.md:84-87`): "manifest inventory", "rpg/dog/Telegram focused tests green" ⇒ implies bundled command plugins (DogMode, RPG) are reachable through the daemon's production `PluginRegistry`.
Actual: every bundled manifest's `index.mjs` (the ONLY entrypoint `readPluginManifest` will import — `src/services/plugins/manifest.ts:153-160`, hardcoded `join(lexicalPackage, "index.mjs")`) is a no-op stub `export function register() { return {}; }` for **all four** daemon-placement packages:
```
plugins/defaults/index.mjs   → register() { return {}; }
plugins/fugu/index.mjs       → register() { return {}; }
plugins/rpg-engine/index.mjs → register() { return {}; }
plugins/rpg.mjs/index.mjs    → register() { return {}; }
```
Each paired `plugin.json` also declares `contributes.commands: []`. `PluginRegistry.commandContributions()` (`src/services/plugins/registry.ts:191-198`) flattens `entry.contributions.commands` off exactly this empty registration ⇒ zero commands reach `RoomService.pluginsPromise = loadCommandPlugins(options.pluginRegistry)` (`src/services/room-service.ts:415-417`), which in production is fed the daemon's real registry (`src/daemon.ts:396: pluginRegistry: this.pluginRegistry`). The real command logic (dog-mode.mjs's full `/dog /slap /shock /stfu /push /swallow /facial /release /doggy /creampie`, rpg.mjs's `plugin.mjs` panel/roster logic) still exists on disk but is **imported nowhere in production** — only directly by `test/dog-mode-plugin.test.ts` and `test/rpg-plugin.test.ts`, which bypass the registry entirely (`import plugin from "../plugins/rpg.mjs/plugin.mjs"`). `test/bundled-plugins.test.ts:27-37` (the test cited as proof) only asserts `stageReload()` succeeds and lists plugin ids — it never asserts `commandContributions()` is non-empty, so it cannot catch this.
Additionally the new manifest command contract itself cannot express the old surface even if wired: `PluginCommandResult` (`src/services/plugins/contracts.ts:14-16`) is `{reply?, steer?}` only — no `state`, `activeAgent`, `panel`, `prompt`, `rewriteAsMessage`, `renderCap`, `turnStart` (all present on the legacy `CommandPlugin` interface, `src/services/plugins.ts:62-71`, and required by dog-mode.mjs/rpg's plugin.mjs). `loadCommandPlugins` (`src/services/plugins.ts:93-108`) only ever sets `run`.
This is an in-scope regression: `git show 4fda75d:src/services/plugins.ts` still used a loose `readdirSync`-based loader for "bundled defaults" (comment: "Bundled defaults retain their established package-free shape until they receive their own manifest packages"); scope commits `4589145`/`74b0d70`/`6641107` replaced that with the manifest/registry path and shipped empty stubs, silently breaking the live command surface.
Repro (both independent, ≠ static-only):
```sh
git -C <worktree> show 338db79:plugins/defaults/index.mjs   # register() { return {}; }
git -C <worktree> show 338db79:plugins/rpg.mjs/index.mjs    # register() { return {}; }
bun test test/dog-mode-integration.test.ts
```
Expected → `/dog on` etc. resolve as documented ("same plugin API/shape... works identically with zero manual setup", plugins/defaults/dog-mode.mjs header comment).
Actual (真, run @ HEAD `b98c3ce`/`72bf6a8`, RoomService constructed exactly as production `daemon.ts` would via `pluginRegistry` option, no invented harness) →
```
bun test test/dog-mode-integration.test.ts
0 pass, 8 fail
'Unknown command: /dog. Try /help.'
... (7 more identical-shape failures, /dog /stfu /push /shock /slap etc. all "Unknown command")
```
Severity: **HIGH** (repro command produces a currently-failing, untouched-in-scope test; user-facing command surface entirely dead in production; ADV-015 closure claim is false for the actual production path). Ticket as **ADV-020** (new — not a duplicate of ADV-015's original repro, which only asked about discovery/validation reachability, not post-registration command-contribution emptiness).

## ADV-016 · single registry / no dead duplicate — VERIFIED
`grep -rln 'plugin-host\|plugin-manifest' src test` → 0 hits (both deleted, no residue). `grep -rn 'new PluginRegistry(' src test` → exactly one production site (`daemon.ts:192`), rest are test constructions. Matches closure claim.

## ADV-017 · lifecycle serialization — VERIFIED (inherited, unmodified in scope)
`PluginRegistry.#serialize` (`registry.ts:293-297`) chains every `stageReload`/`applyTurnBoundary`/`shutdown` through one `#lifecycle` promise tail; `#applyTurnBoundary` awaits `#dispose` of the previous generation before returning. Matches "VERIFIED · inherited c03795b" (not re-touched this pass).

## ADV-018 · A16 parent assertion — VERIFIED FIXED
`test/edit-resend-live.test.ts:373-374` now asserts `newTailEntry.parentId === editedMessageEntry.id` AND `!== oldTailEntry.id` — independent positive+negative proof of the actual fork parent, closing the ADV-018 gap (previously only an optional inequality). Not independently re-run live (opt-in `GAIA_LIVE_EDIT_RESEND=1`, out of ≤12min budget) — UNVERIFIED live-run, static assertion shape confirmed correct.

## ADV-019 · dead duplicate constant — VERIFIED
`AGENT_DIALOGUE_MAX_HOPS` canonical only in `room/summon-lifecycle.ts:17`, re-exported once by `room-service.ts:93`; no residue in `task-operations.ts`. Matches closure claim.

## RULE0 / harness-branch / pragma / upward-import / dead-export sweep (in-scope files only)
`grep -nE 'harness\s*===|harness\s*!==|@ts-ignore|@ts-nocheck|eslint-disable'` over `git diff --name-only 4fda75d..338db79 -- '*.ts'` → only 2 hits, both plain data-field reads (`config.harness`, not identity branches) in `core/config.ts`/`domain/agents.ts` — not RULE0 violations. No `services/**` file in scope imports `server/`/`daemon/`. No new findings.

## Summary verdict
ADV-014, 016, 017, 018, 019 → closure claims independently reproduce correctly.
ADV-015 → closure claim **does not hold for the production command-invocation path**; discovery/validation now works, but zero bundled commands are actually contributed, and the new command contract structurally cannot carry the old CommandPlugin surface (state/panel/prompt/renderCap/turnStart/rewriteAsMessage) even once wired. New ticket **ADV-020** raised above with independent repro + failing test evidence. Not a duplicate of any existing ADV-015 repro command (different failure mode: post-registration emptiness, not discovery unreachability).

Gate: not re-run this pass (static + one targeted `bun test` invocation only, per ≤12min budget); `bun test test/dog-mode-integration.test.ts` output above is the only dynamic evidence gathered, and it is the finding itself, not a gate substitute.
