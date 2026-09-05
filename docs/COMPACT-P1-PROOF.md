# Compact P1 · 2026-09-05

## Scope

- branch → `fix/compact-p1` · base → `main` @ `8558160`
- `c4e744e` cherry-pick → `3b748df` · conflict → extracted `PiCompaction`; existing newest-content helper retained; active-branch selection + SDK context regression added
- `d5eaf26`, `7b764e0`, `7efa9e9` → ancestors retained
- command → `/compact-clean [agent] [--summary <text>]`
  - explicit summary → atomic room+agent registration → retained clean runtime
  - absent summary → registered summary required; missing registration → no-op
  - Nyari deleted registration → no implicit restoration
- new command owner → `src/services/room/compact-clean.ts`
- new hook owner → `src/harness/pi/clean-compact.ts`
- registry owner → `src/domain/clean-summaries.ts` · parameter default → home-relative index; cross-process lock; corrupt index → fail closed
- SDK allowlist → `dist/core/resource-loader.js` `getEnabledPaths(resolvedPaths.extensions)`; `noExtensions:true` → discovered global extensions excluded
- replacement → explicit named inline factory `<inline:clean-compact>` in `PiRuntime.createSessionMeta()`; injectable factory default → `PiCompaction.cleanExtension()`
- external `~/.pi/agent/extensions/clean-compact.ts` → untouched/unloaded; ordinary-compaction interception + external log-path side effects excluded
- room/agent identity → runtime parameters, never `ctx.cwd`; floor → active branch, never abandoned siblings
- ordinary `/compact` + `--edit` + auto-compaction → unchanged
- clean-checkout gate → design submodule initialized; missing Bun types declared/pinned `bun-types@1.3.14`

## Gates · raw excerpts

```text
$ TMPDIR="$PWD/.proof/scratch" bun --bun run check
$ tsc -p tsconfig.json --noEmit && tsc -p web/tsconfig.json && tsc -p src/server/graphql.tsconfig.json --noEmit && bun run check:dead
$ knip --no-exit-code
CHECK_EXIT=0
```

- Knip → existing nonblocking diagnostics; full raw output → local `logs/compact-p1/check.log`

```text
$ TMPDIR="$PWD/.proof/scratch" PI_OFFLINE=1 bun test test/dsc-compact*.test.ts test/clean-compact*.test.ts
 5 pass
 0 fail
Ran 5 tests across 2 files. [35.88s]
TEST_EXIT=0

$ TMPDIR="$PWD/.proof/scratch" PI_OFFLINE=1 bun test test/pi-runtime.test.ts test/commands.test.ts test/runner-host.test.ts
 71 pass
 0 fail
Ran 71 tests across 3 files. [21.38s]
TOUCHED_TEST_EXIT=0

$ TMPDIR="$PWD/.proof/scratch" PI_OFFLINE=1 bun test test/room-service.test.ts --test-name-pattern 'compact|compaction'
 13 pass
 94 filtered out
 0 fail
Ran 13 tests across 1 file. [26.46s]
ROOM_TEST_EXIT=0

D5EAF26_ANCESTOR_EXIT=0
AUTO_COMPACT_7B764E0_ANCESTOR_EXIT=0
AUTO_COMPACT_7EFA9E9_ANCESTOR_EXIT=0
DIFF_CHECK_EXIT=0
```

## Live daemon · one isolated instance

- binary → `bun scripts/build-daemon.mjs --out "$PWD/.proof/build"` · `BUILD_EXIT=0`
- environment → `GAIA_PORT=0`, `GAIA_HOST=127.0.0.1`, isolated `GAIA_HOME`/Pi credentials/workspace; no app restart/deploy
- fixture → HTTP-created room + SDK-created persisted Pi history; oversized bait prompt + safe final assistant entry; dummy credential, no model request
- command → real HTTP `/messages` → room service → runner subprocess → real Pi SDK hook/commit

```text
ISOLATED_DAEMON_PID=44168 GAIA_PORT=0
[gaia] 2026-09-05T09:42:56.946Z daemon up pid=44168 ppid=1 at http://127.0.0.1:52788
ROOM_CREATED=compact-p1-proof-20260905-0944 DAEMON=http://127.0.0.1:52788
INDEX_BEFORE={}
```

```text
/compact-clean @compact-probe --summary Task → verify isolated clean compaction. Old fixture → discarded; continue safe task.
compact-clean: registered room=compact-p1-proof-20260905-0944 agent=compact-probe index=/Users/pascaldisse/.pi/agent/clean-summaries/index.json
[runner compact-probe] compact-clean: room=compact-p1-proof-20260905-0944 agent=compact-probe newestValidCutId=7be85c53 preparationFloor=7be85c53
[runner compact-probe] compact-clean: committed room=compact-p1-proof-20260905-0944 agent=compact-probe floor=7be85c53
INDEX_AFTER_ENTRY={"compact-p1-proof-20260905-0944":{"agents":{"compact-probe":"Task → verify isolated clean compaction. Old fixture → discarded; continue safe task."}}}
PERSISTED_FLOOR=7be85c53 newestValidCutId=7be85c53 BAIT_IN_REBUILT_CONTEXT=false
TRANSCRIPT author=system kind=compact-complete text=@compact-probe: session compacted (75005 tokens before → ~28).
```

## Ordinary `/compact` parity

```text
/compact @compact-probe
TRANSCRIPT author=system kind=undefined text=@compact-probe: nothing to compact — already compacted.
PLAIN_COMPACT_REGISTRY_DIFF=none PLAIN_COMPACT_SESSION_DIFF=none
MAIN_DIFF=none src/services/room/commands-facade.ts
MAIN_DIFF=none src/services/room/auto-compact.ts
MAIN_DIFF=none src/harness/host.ts
MAIN_DIFF=none src/harness/runner.ts
MAIN_DIFF=none PiCompaction async compact(roomId:
MAIN_DIFF=none PiCompaction async function runCompactionFallback(
MAIN_DIFF=none PiCompaction private async native(
MAIN_DIFF=none /compact parser including --edit
ISOLATED_DAEMON_STOPPED=44168
```

- source parity → direct byte comparison against `git show main:<path>`; runtime parity → already-compacted case; registered-summary isolation → focused runtime tests
- Gaia cursor/replay → original `d5eaf26` test retained + duplicate through new `/compact-clean` registration; 13 room compaction cases pass
- local raw logs/fixture/build → `logs/compact-p1/` (ignored)
- throwaway global index entry → retained for inspection; Nyari entry → absent

## UNVERIFIED

- production app deployment / real Nyari room repair → not attempted; no live-app restart/kill
- subsequent real model turn / model-generated ordinary-compaction case → not exercised live
- full unfiltered `room-service` suite → not run; compaction-focused cases only
