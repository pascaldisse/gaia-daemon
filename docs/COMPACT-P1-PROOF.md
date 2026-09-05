# Compact P1 · corrected proof · 2026-09-05

## Scope

- branch → `fix/compact-p1` · base → `main` @ `8558160`
- correction → `f4a1f15`; `src/harness/pi/compaction.ts` restored byte-identical to main
- clean lifecycle + hook + ordinary-hook exclusion during clean operation → `src/harness/pi/clean-compact.ts`; default factory parameter; native SDK commit
- ordinary hook → unchanged factory; clean-operation gate outside original module; ordinary events → original handlers
- c4e744e semantics → existing newest-content helper imported; active-branch selection → clean-only hook; abandoned siblings excluded
- `d5eaf26`, `7b764e0`, `7efa9e9` → retained ancestors
- command → `/compact-clean [agent] [--summary <text>]`
  - explicit summary → atomic room+agent registration → clean runtime
  - absent summary → existing registration required; missing registration → no-op
- command owner → `src/services/room/compact-clean.ts`
- registry → `src/domain/clean-summaries.ts`; parameter default → home-relative index; cross-process lock; corrupt index → fail closed
- SDK allowlist → `dist/core/resource-loader.js` `getEnabledPaths(resolvedPaths.extensions)`; `noExtensions:true` excludes discovered globals
- enabled clean hook → explicit inline `<inline:clean-compact>`; external extension untouched/unloaded
- identity → runtime room/agent parameters, never `ctx.cwd`
- clean-checkout gate → design submodule initialized; `bun-types@1.3.14` declared/pinned

## Repeated gates · raw excerpts

```text
$ TMPDIR="$PWD/logs/compact-p1-r2/scratch" bun --bun run check
$ tsc -p tsconfig.json --noEmit && tsc -p web/tsconfig.json && tsc -p src/server/graphql.tsconfig.json --noEmit && bun run check:dead
$ knip --no-exit-code
CHECK_EXIT=0

$ bun test test/dsc-compact*.test.ts test/clean-compact*.test.ts
 5 pass
 0 fail
Ran 5 tests across 2 files. [32.97s]
CLEAN_TEST_EXIT=0

$ bun test test/pi-runtime.test.ts test/commands.test.ts test/runner-host.test.ts
 71 pass
 0 fail
Ran 71 tests across 3 files. [7.83s]
TOUCHED_TEST_EXIT=0

$ bun test test/room-service.test.ts --test-name-pattern 'compact|compaction'
 13 pass
 94 filtered out
 0 fail
Ran 13 tests across 1 file. [4.47s]
ROOM_TEST_EXIT=0
```

- tests → `TMPDIR="$PWD/logs/compact-p1-r2/scratch" PI_OFFLINE=1`
- Knip → nonblocking diagnostics; full raw logs → local ignored `logs/compact-p1-r2/`

## Repeated live proof · one isolated daemon

- build → `bun scripts/build-daemon.mjs --out "$PWD/logs/compact-p1-r2/build"`; `BUILD_EXIT=0`
- environment → `GAIA_PORT=0`, `GAIA_HOST=127.0.0.1`; isolated `GAIA_HOME`, Pi credentials, workspace
- fixture → HTTP-created room; `/help` creates pre-compaction Gaia history; SDK-persisted oversized bait prompt + safe final assistant entry
- execution → HTTP `/messages` → room service → runner subprocess → actual Pi SDK hook/commit; dummy credential, no model request

```text
ISOLATED_DAEMON_PID=48657 GAIA_PORT=0
[gaia] 2026-09-05T10:01:15.621Z daemon up pid=48657 ppid=1 at http://127.0.0.1:59560
ROOM_CREATED=compact-p1-proof-20260905-r2 DAEMON=http://127.0.0.1:59560
INDEX_BEFORE={"compact-p1-proof-20260905-0944":{"agents":{"compact-probe":"Task → verify isolated clean compaction. Old fixture → discarded; continue safe task."}}}
/compact-clean @compact-probe --summary Task → verify isolated clean compaction. Old fixture → discarded; continue safe task.
compact-clean: registered room=compact-p1-proof-20260905-r2 agent=compact-probe index=/Users/pascaldisse/.pi/agent/clean-summaries/index.json
[runner compact-probe] compact-clean: room=compact-p1-proof-20260905-r2 agent=compact-probe newestValidCutId=5724fdb7 preparationFloor=5724fdb7
compact-clean: committed room=compact-p1-proof-20260905-r2 agent=compact-probe floor=5724fdb7
INDEX_AFTER_ENTRY={"compact-p1-proof-20260905-r2":{"agents":{"compact-probe":"Task → verify isolated clean compaction. Old fixture → discarded; continue safe task."}}}
PERSISTED_FLOOR=5724fdb7 newestValidCutId=5724fdb7 BAIT_IN_REBUILT_CONTEXT=false
CLEAN_GAIA_FLOOR=1 CLEAN_GAIA_CURSOR=1
/compact @compact-probe
TRANSCRIPT author=system kind=undefined text=@compact-probe: nothing to compact — already compacted.
PLAIN_COMPACT_REGISTRY_DIFF=none PLAIN_COMPACT_SESSION_DIFF=none
LIVE_EXIT=0
ISOLATED_DAEMON_STOPPED=48657
```

## Original module · byte proof

```text
$ git diff --exit-code main HEAD -- src/harness/pi/compaction.ts
COMPACTION_BYTE_DIFF_EXIT=0
MAIN_DIFF=none src/harness/pi/compaction.ts sha256=42afb2aaa5f6abb731497ee3df63994189dc300a1940d65a25f098235516b4a2
MAIN_DIFF=none src/services/room/commands-facade.ts
MAIN_DIFF=none src/services/room/auto-compact.ts
MAIN_DIFF=none src/harness/host.ts
MAIN_DIFF=none src/harness/runner.ts
MAIN_DIFF=none /compact parser including --edit
```

- raw byte comparisons → `git show main:<path>` vs working file; final branch stat → original `compaction.ts` absent
- Gaia replay → original d5eaf26 test retained + new command coverage; 13 room-compaction cases pass
- throwaway index entries → retained for inspection; Nyari entry → absent

## UNVERIFIED

- production deployment / real Nyari room repair → not attempted; live app untouched
- subsequent real model turn / model-generated ordinary compaction → not exercised live
- full unfiltered room-service suite → not run; compaction-focused cases only
