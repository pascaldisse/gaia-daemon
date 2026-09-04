# Clean compaction recon · 2026-09-04

## Current state

- `~/.pi/agent/clean-summaries/index.json` → `{}` · active room overrides=0
- 2026-08-29 nyari registration removal → deliberate · do not restore implicitly
- daemon internal loader → `src/harness/pi/compaction.ts:loadCleanCompactionOverride()`
- loader path → ordinary Pi `session_before_compact` hook · strict room+agent/default lookup
- external `~/.pi/agent/extensions/clean-compact.ts` → stale/inactive for daemon
  - daemon loader → `src/harness/pi/runtime.ts` `noExtensions:true`
  - Pi settings packages → extension absent
- separate clean-mode remnants:
  - present → protocol `compact-clean` · runner case · host `compactClean()`
  - absent → `/dsc-compact` parser/room dispatch · `PiRuntime.compactClean()`
  - result → no callable end-to-end clean mode on current `main`

## 2026-08-25 ask

- poisoned Pi context unable to model-summarize
- use Pi SDK compaction path · never hand-edit durable compaction output
- inject prewritten model-free clean summary only for explicitly registered room/agent
- preserve room transcript · advance Pi context floor beyond poisoned tail
- proof target → real compact + subsequent real agent turn

## Later controlling correction · 2026-08-31

- ordinary `/compact` must remain ordinary
- clean behavior → separate explicit `/dsc-compact`
- trigger filtering/model-free fallback confined to that command
- floor alone insufficient → Gaia `agentCursor` must advance with successful clean compaction

## Repair · applied on `fix/open-0827`

1. port complete `/dsc-compact` chain into refactored owners
   - command parser/registry → room command facade → host/runner protocol → `PiRuntime` → `PiCompaction`
2. remove clean-summary interception from ordinary `/compact`
3. explicit clean mode only → registry summary when present; deterministic safe fallback otherwise
4. port successor correctness beyond historical `c4e744e`
   - final-entry floor semantics
   - `agentCursor` advance
   - already-compacted/too-small completion semantics
5. tests
   - `/compact` unaffected with registry present
   - `/dsc-compact` reachable end-to-end
   - poison entry below floor · empty replay window after cursor advance
   - no-op still advances Gaia floor/cursor when clean summary supplied
6. live gate after explicit deploy approval
   - compiled daemon · disposable room/session · real `/dsc-compact` · real next turn

## Applied provenance · 2026-09-04

- `ec2a8dd` → `PiCompaction.clean()` + `PiRuntime.compactClean()` · registry-only · ordinary `/compact` isolation
- `c0e3dea` → parser/dispatch/facade + retained host wire · Gaia floor/cursor
- `d5eaf26` → next-turn replay window proof
- later-history semantics → `30de282` final content-entry floor · `fc45e43` cursor advancement · `2372340` registered Pi no-op completion
- explicit registration retained → `~/.pi/agent/clean-summaries/index.json` untouched `{}`

## Verification boundary

- static recon + source/history inspection → verified
- `bun run check` → pass
- focused clean chain → 74 pass (`pi-runtime`+commands+runner-host+room clean cases)
- full `room-service` suite → blocked by unrelated pre-existing stall-requeue timeout
- current live daemon clean behavior → UNVERIFIED · no restart/deploy
