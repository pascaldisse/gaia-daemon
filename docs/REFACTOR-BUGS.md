# Refactor adversary tickets

Scope → `main` + active `wip/*` / `room/*` refactor atoms · fixes forbidden · evidence from isolated adversary worktrees.

## ADV-001 · BLOCKER · `wip/a0-compact-clean@97e4c24` must not merge

Atom → root-WIP preservation commit `97e4c24` (`5502e39..97e4c24`) · 16 files · +486/−88 · multiple unrelated behavior changes.

Defect → committed conversation-ending feature deleted while daemon endpoint remains wired:
- `src/services/room-service.ts` → `RoomService.endConversation()` + suppression/reactivation paths removed
- `src/daemon.ts:1098` → surviving `service.endConversation(...)` call
- result → compile failure + live endpoint regression

Repro:
```sh
R=/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/chat-mtk78q14-wa40/.gaia/review-97e4c24
cd "$R"
bun run check
bun test test/room-service.test.ts
bun test test/end-conversation.test.ts
```

Expected → check exit 0 · room-service 98/0 · endpoint 1/0 and HTTP 200.

Actual @ `97e4c24`:
- check exit 2 → `src/daemon.ts(1098,20): TS2339 Property 'endConversation' does not exist on type 'RoomService'`
- room-service → 95 pass / 2 fail · `service.endConversation is not a function`
- endpoint → 0 pass / 1 fail · HTTP 400 ≠ 200

Independent control @ `main@dc2c552` + docs-only review commits → room-service 98/0 · endpoint 1/0.

Boundary → preservation branch only; never merge/cherry-pick wholesale. Extract independent intended changes into bounded atoms + own tests.

## ADV-002 · HIGH · `main@dc2c552` adds untested `compact-clean` wire path

Atom → A0 `dc2c552` · `src/harness/{host,protocol,runner,spec}.ts` · +24/−1.

Defect → new runtime protocol branch has zero test reference; existing RunnerHost test covers only ordinary `compact`:
```sh
git -C /Users/pascaldisse/projects/gaia-daemon grep -n -E 'compactClean|compact-clean' dc2c552 -- test web/src/'*.test.js'
```
Expected → tests assert host command framing, runner dispatch, progress/result forwarding, unsupported-runtime error.
Actual → zero matches.

Gate replay @ review branch `7cd43bb` (contains exact `main@dc2c552` + docs):
- `bun run check` → exit 0
- `bun test test/runner-host.test.ts` → 18 pass / 0 fail
- `bun test test/runner-host-proxy.test.ts` → 2 pass / 0 fail

Risk → type seam proven; live behavior/error framing unproven. No live slot required for A0, but focused regression coverage remains mandatory before clean adversary verdict.

## ADV-003 · BLOCKER · A4 dead-code gate is deliberately non-enforcing

Atom → A4 `b8845eb` · `knip.json` + `package.json`.

Defect → `check:dead` uses `bunx --bun knip --no-exit-code`; `bun run check` succeeds while Knip reports violations. Contradicts `docs/REFACTOR-PLAN-v1.md:25` → “dead code can't regrow.”

Repro:
```sh
R=/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/chat-mtk78q14-wa40/.gaia/review-b8845eb
cd "$R"
bun run check
```

Expected → nonzero until the configured dead-code baseline is clean; later regressions block.

Actual → exit 0 with 3 unused files · 1 unused dependency · 3 unlisted dependencies · 2 unlisted binaries · 116 unused exports · 58 unused exported types · 10 configuration hints.

Additional determinism risk → `knip` absent from `devDependencies`; every check invokes `bunx` package resolution rather than the lockfile-pinned project tool.

Verdict → A4 fails its sole enforcement objective; do not merge until W1 A2 debt is removed/baselined and Knip runs without `--no-exit-code` from a pinned dependency.

## ADV-004 · HIGH · A3 path dedup changes `GAIA_HOME` behavior inside refactor atom

Atom → A3 sub-atom `5a39b0b` on `refactor/a3-dedup`.

Defect → callers formerly fixed to `homedir()/.gaia` now resolve through `globalPaths` → `gaiaHome()` → `GAIA_HOME`:
- `src/services/plugins.ts` → user command-plugin discovery root changes
- `src/services/room-service.ts` → ambient-watchdog root changes
- `src/services/stt-apple.ts` → compiled helper cache root changes

Repro:
```sh
git -C /Users/pascaldisse/projects/gaia-daemon show 5a39b0b -- src/core/paths.ts src/services/plugins.ts src/services/room-service.ts src/services/stt-apple.ts test/paths.test.ts
```
Expected for move/split/delete-only A3 → path semantics unchanged; any `GAIA_HOME` behavior correction lands as a separate behavior atom + caller-level tests.
Actual → `test/paths.test.ts` explicitly asserts the new `GAIA_HOME` routing, but no plugin/watchdog/STT caller regression test accompanies it.

Cumulative A3 gates @ `16cae4d`:
- `bun run check` → 0
- retry 1/0 · paths 2/0 · rooms 51/0 · orphan-reaper 11/0 · runner-host 18/0 · room-service 98/0 · summons 35/0 · transcribe 22/0 · voice 25/0
- pre-existing controls reproduced unchanged at parent `dc2c552`: auth-adversarial 0/4 · room-membership-security 0/3 · memory-service 20/1 timeout · voice-stt-bridge 2/1 timeout · voice-tts-bridge 6/3 timeout

Verdict → helper extraction itself is layer-correct/RULE0-clean; `5a39b0b` fails refactor purity until behavior change is separated or explicitly reclassified.

## ADV-005 · HIGH · A8 relocates the Pi god file instead of splitting it

Atom → A8 `2ad4e42` merged by `41836cd`.

Defect:
- old `src/harness/pi.ts` → 1,233 lines
- new `src/harness/pi/session.ts` → 1,013 lines
- new `src/harness/pi/tools.ts` → 19 lines
- new `src/harness/pi/events.ts` → 24 lines
- result → registration façade is small, but the runtime god file remains; W2 split objective not met
- duplication regrowth → identical private `piUserMessageText()` now exists in `pi/session.ts:333` and `pi/events.ts:6`; session copy has no caller

Repro:
```sh
W=/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/chat-mtk78q14-wa40
wc -l "$W/src/harness/pi.ts" "$W/src/harness/pi/session.ts" "$W/src/harness/pi/tools.ts" "$W/src/harness/pi/events.ts"
rg -n '^function piUserMessageText' "$W/src/harness/pi" "$W/src/harness/pi.ts"
```

Expected → bounded session/fork, tool assembly, event translation modules; no duplicate/dead helper.
Actual → 1,013-line `session.ts` retains nearly the complete former implementation; `tools.ts` only holds provider-fetch redirection.

Gate replay @ `main@41836cd` → `bun run check` 0 · pi-runtime 39/0 · runner-host 18/0. Runtime behavior gate clean; architecture verdict remains reject.

## ADV-006 · BLOCKER · A5 gate red + HTTP god file merely relocated

Candidate → `verify/a5@614e606` (code series `718a1cc..6a1873e`).

Defect:
- old `src/server/http.ts` → ~2,084 lines
- new `src/server/routes/runtime.ts` → 1,993 lines
- domain route modules → agents 4 · artifacts 2 · edit-retry 6 · memory 6 · rooms 27 · usage 6 lines
- `src/server/http.ts` → three-line re-export, not listener + dispatch
- `test/http-routes.test.ts` → one 40-line test of tiny parsing adapters + one auth endpoint; no per-domain route-table coverage

Repro:
```sh
git -C /Users/pascaldisse/projects/gaia-daemon diff --stat main...verify/a5
W=/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/chat-mtk78q14-wa40
for f in src/server/http.ts src/server/route.ts src/server/routes/*.ts test/http-routes.test.ts; do wc -l "$W/$f"; done
```

Expected from A5 → actual route table; room/agent/memory/artifact/usage/edit-retry handlers owned by domain route files; listener+dispatch-only `http.ts`; focused domain tests.
Actual → complete `GaiaWebServer` + 1,800-line `handleApi` remain together in `routes/runtime.ts`; façade location changed, architecture did not.

Focused gate @ `verify/a5@614e606`:
- `bun run check` → 0
- `bun test test/http-routes.test.ts` → 1/0
- `bun test test/bundle-assets.test.ts` → **8/1**; assertion still requires `bundleSwapNames(fromSource)` ownership in `src/server/http.ts`, now a three-line re-export
- end-conversation 1/0 · HTTP background 2/0 · user-workspaces 1/0 · workspace-order 1/0

Verdict → mandatory touched test is red and W2 god-file objective fails. Do not land.

## Known planned debt · non-ticket

- A1 upward imports → resolved by `4233f82` / merge `630a7b5`; main scan at `41836cd` = zero.
- RULE0 literal harness-id branches introduced by reviewed atoms → none.

## ADV-007 · HIGH · A6 leaves the RoomService god façade at 3,718 lines

Atoms → A6 `350840e` (context gate) · `638fed8` (fork) · `3b2e317` (turn loop), merged through `2128ac7`.

Defect → extraction moved 790 lines into three helpers, but `src/services/room-service.ts` remains 3,718 lines; plan requires façade ≤800. Queue ownership, recovery, commands, dialogue, media, goals, sanitization, snapshots, and runtime state remain co-located. New façade methods instantiate helpers through `new RoomFork(this as any)` / equivalent structural escape, so the intended bounded façade contract is absent.

Repro:
```sh
W=/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/chat-mtk78q14-wa40
wc -l "$W/src/services/room-service.ts" "$W/src/services/room/"*.ts
rg -n 'new Room(Fork|ContextGate|TurnLoop)\(this as any\)' "$W/src/services/room-service.ts"
```

Expected @ plan §W2 A6 → `room-service.ts` façade ≤800 lines with explicit helper contracts; durability custody remains owned once.

Actual @ `main@2128ac7` → façade 3,718 lines · helpers 125/178/512 lines · structural `any` bridges at façade boundaries. Extracted seams may preserve behavior, but A6 architecture objective is not complete.

## ADV-008 · HIGH · A7 extraction leaves `daemon.ts` as a 1,334-line god file

Atom → A7 `8350bb2`, merged through `a5bc607` / `2128ac7`.

Defect → `reload.ts` (61 lines) + `wiring.ts` (335 lines) extracted, yet `daemon.ts` remains 1,334 lines and continues to own far more than boot sequencing. A7's declared endpoint is “daemon.ts = boot sequence”; moving 318 old lines while adding 457 does not establish that boundary.

Repro:
```sh
W=/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/chat-mtk78q14-wa40
wc -l "$W/src/daemon.ts" "$W/src/daemon/reload.ts" "$W/src/daemon/wiring.ts"
git -C "$W" show --stat 8350bb2
```

Expected @ plan §W2 A7 → boot-sequence façade in `daemon.ts`; reload and service wiring bounded behind extracted modules.

Actual @ `main@2128ac7` → 1,334/61/335 lines; atom adds 457 and deletes 318 lines. Live boot/reload behavior remains separately UNVERIFIED pending queue execution, but the static split objective already fails.

---

# Audit pass — 陰木 Vishnu/Kali (L2 STATIC), range 820e568..main (tip 2128ac7)

Static only. No fixes applied (fix forbidden — tickets only).

## L2 integration scans (measured 真)

### RULE0 — literal harness-id branches in shared code
Repro:
```
rg -n 'harness ===|harness !==|=== "pi"|=== "claude"|=== "codex"' /Users/pascaldisse/projects/gaia-daemon/src
```
Expected → zero shared-layer branches on a harness identity literal.
Actual → 13 hits, all non-violating: field comparisons against config/account
`harness` DATA (`domain/agents.ts:94`, `core/config.ts:384`, `domain/accounts.ts:47`,
`harness/host.ts:815`, `services/hints.ts:289,454`, `harness/spec.ts:509`,
`server/http.ts:967-968`) + 4 comment/doc mentions of the forbidden pattern.
**RULE0 hits: 0** (clean).

### Layering — upward imports
Repro:
```
rg -n 'from "\.\./(server|daemon|services)/' /Users/pascaldisse/projects/gaia-daemon/src/core /Users/pascaldisse/projects/gaia-daemon/src/domain /Users/pascaldisse/projects/gaia-daemon/src/harness
rg -n 'from "\.\./(server|daemon)/' /Users/pascaldisse/projects/gaia-daemon/src/services
```
Expected → no output. Actual → no output. **layer hits: 0** (clean).

### Hardcode scan
Repro:
```
rg -n '8787|18787|/tmp|claude-3|gpt-' /Users/pascaldisse/projects/gaia-daemon/src
```
Actual → 10 hits; `core/config.ts:41 port: 8787` = named DEFAULTS entry (allowed),
`harness/sandbox/seatbelt.ts:30,31,80` = sandbox path allowlist (allowed),
`services/caryll.ts:1` = tokenizer encoding import (allowed),
`services/voice.ts:144,149` + `services/transcribe.ts:258,274,275` = STT model
registry/default (allowed). One drift below.

### T-L2-1 duplicated STT default literal
severity: low · commit: pre-range (present through `2128ac7`)
Repro:
```
rg -n 'openai/gpt-4o-mini-transcribe' /Users/pascaldisse/projects/gaia-daemon/src
```
Expected → default declared once (`services/voice.ts:149 sttReplicateModel`) and
referenced by name at use sites.
Actual → `services/transcribe.ts:344` re-literals `"openai/gpt-4o-mini-transcribe"`
as its own fallback; changing the settings default silently diverges from the
transcribe fallback.

## L3 Vishnu (建) — commit purity / RULE0 / layering / hardcode / duplication


### T-V1 refactor(domain) commit changes transcript line semantics
severity: med
commit: 7d949ac "refactor(domain): centralize transcript reads"
repro:
```
git -C /Users/pascaldisse/projects/gaia-daemon show 7d949ac -- src/domain/workspace-index.ts
rg -n 'readTranscriptRecordsFrom' /Users/pascaldisse/projects/gaia-daemon/src/domain/rooms.ts
```
expected: labelled `refactor` ⇒ pure move/centralization, byte-identical behavior.
actual: counting basis swapped `lines.length` (non-empty raw lines) → `transcript.nextCursor`, and per-line JSON-parse skip replaced by `parsed.lineIndex` filtering. If readTranscriptRecordsFrom drops malformed/blank lines or indexes differently, `total_lines`/`closed_lines` persisted in the index DB and the rebuild trigger `lineCount < cursor.total_lines` shift meaning → possible spurious full room re-index or missed rebuild. Also `scrollTranscriptWindow` window bounds now derived from nextCursor. Needs an explicit equivalence test (`bun test test/rooms.test.ts` only covers the new reader).

### T-V2 refactor(harness) commit adds new feature surface (tool service providers)
severity: low
commit: 4233f82 "refactor(harness): inject tool service providers"
repro:
```
git -C /Users/pascaldisse/projects/gaia-daemon show --stat 4233f82
git -C /Users/pascaldisse/projects/gaia-daemon show 4233f82 -- src/harness/protocol.ts src/services/tool-providers.ts src/server/http.ts
```
expected: `refactor` = no new behavior; new capability ⇒ `feat`.
actual: +158/-29 across 12 files incl. new file src/services/tool-providers.ts, new protocol union members, new http.ts route logic. Purity/label mismatch, harder to bisect. No RULE0 violation observed (wiring declared as data on the spec).

### T-V3 json() default content-type widened during "reuse" refactor
severity: low
commit: 16cae4d "refactor(core): reuse JSON response writer"
repro:
```
git -C /Users/pascaldisse/projects/gaia-daemon show 16cae4d
```
expected: pure call-site consolidation.
actual: `json()` gains 4th param `contentType` (default `application/json; charset=utf-8`); voice bridges pass bare `"application/json"` to preserve old headers. Behavior preserved but an API knob was added under a refactor label; the bridges now diverge from the daemon default charset — either intentional (document) or should be normalized.

### T-V4 pre-existing A3 path-semantics drift already flagged, still open
severity: med
commit: c1f029d "docs(refactor): flag A3 path-semantics drift" (re 5a39b0b centralize GAIA path resolution)
repro:
```
git -C /Users/pascaldisse/projects/gaia-daemon show c1f029d
git -C /Users/pascaldisse/projects/gaia-daemon show 5a39b0b -- src/core/paths.ts src/harness/host.ts src/services/stt-apple.ts
```
expected: drift closed or test-pinned before landing further path work.
actual: drift documented but no follow-up commit in 820e568..main resolves it. Carried into main.

## RULE0 (harness branching in shared code)
command:
```
rg -n 'harness ===|harness !==|=== "pi"|=== "claude"|=== "codex"' /Users/pascaldisse/projects/gaia-daemon/src
```
13 hits, ALL benign — verified each: `typeof x.harness === "string"` type guards (core/config.ts:384, domain/accounts.ts:47, services/hints.ts:454, server/http.ts:967), data comparisons agent↔account ownership (harness/spec.ts:509, harness/host.ts:815, server/http.ts:968, services/hints.ts:289), comments restating the law (room-service.ts:3551, core/types/ui.ts:108, spec.ts:6/165), domain/agents.ts:94 config fallback. No `harness === "pi"|"claude"|"codex"` literal branch in shared layer.
**RULE0 hits: 0**

## layering (server→daemon→services→harness→domain→core)
commands:
```
rg -n 'from "\.\./(server|daemon|services|harness|domain)' /Users/pascaldisse/projects/gaia-daemon/src/core
rg -n 'from "\.\./(server|daemon|services|harness)'        /Users/pascaldisse/projects/gaia-daemon/src/domain
rg -n 'from "\.\./(server|daemon|services)'                /Users/pascaldisse/projects/gaia-daemon/src/harness
rg -n 'from "\.\./(server|daemon)'                         /Users/pascaldisse/projects/gaia-daemon/src/services
rg -n 'from "\.\./server'                                  /Users/pascaldisse/projects/gaia-daemon/src/daemon
```
all five: zero output. **layer hits: 0**

## hardcode
command:
```
rg -n '8787|18787|/tmp|claude-3|gpt-' /Users/pascaldisse/projects/gaia-daemon/src
```
10 hits, all legitimate — no ticket:
- core/config.ts:41 `port: 8787` = the DEFAULTS object itself (correct home for a default).
- services/voice.ts:149 / transcribe.ts:344 model ids = default in settings object, overridable via `settings.sttReplicateModel`; transcribe.ts:274-275 = adapter registry KEYS (identifiers, not config).
- services/caryll.ts:1 = npm package path `gpt-tokenizer/...`.
- harness/sandbox/seatbelt.ts:30-31 comment, :80 `"/private/tmp"` = macOS canonical system path required by the seatbelt profile, not a workdir.
**hardcode hits: 0**

## duplication (post-refactor leftovers)
Split commits checked by stat symmetry (deletions ≈ insertions, single new file per removed block): 7a218ab, 8350bb2, 3b2e317, 2ad4e42, 638fed8, 350840e, df58abc — all show one-way moves, no old copy retained. Dead-export deletions 0d9f141 / cec7a22 / e47adf0 are pure `-` diffs. No duplicate-implementation ticket.
**duplication hits: 0 (stat-level check only — see UNVERIFIED)**

## clean atoms
7a218ab (pi compaction split) · 8350bb2 (daemon wiring/reload split) · 3b2e317 (room turn-loop extract) · 2ad4e42 (pi runtime split) · 638fed8 (room fork extract) · 350840e (room context-gate extract) · df58abc (core types split) · 0d9f141 · cec7a22 · e47adf0 (dead-export deletes) · 5948608 (retry sleep centralize) · 364909d (recorder asset path, 1-line web fix) · 5f307be · 94f12ea · 944dff2 · 7da562c · a93b633 · 6b30b8b · 49ea9cd · d190332 · f6a1ac7 (v2 skin, web/ only) · 91666d3 · 71e80b5 · 712d2c8 (harness id removal) · 31f99b9 (prompt opt-outs) · 5502e39 (web links) · all docs/* commits

RULE0 hits: 0
layer hits: 0

## UNVERIFIED
- duplication check = `--stat` symmetry + rg spot checks only; no line-level content diff of every moved block (time bound ≤10min).
- T-V1 semantic drift = read-level inference; NOT reproduced at runtime (no `bun test` run, no daemon exercise).
- `bun run check` NOT executed (read-only mandate, root = merge-only).
- merge commits (2128ac7, bbc2c5f, 8c71e31, a5bc607, 81abec6, 41836cd, b19d542, 5602e34, 48a29f3, 46d8454, b0cc858, 312d6ba, 630a7b5, e41bbea, 7cd43bb, 094bd51, 037643f, 6be4997) not diff-inspected for conflict-resolution drift.

## L3 Kali (審) — PLUGIN boundary + static supplementary

### T-K1 Telegram bridge format leaks into core services
severity: high
commit hash: main@2128ac7 (pre-range introduction; `git -C /Users/pascaldisse/projects/gaia-daemon show 820e568..main -- src/services/telegram-bridge-format.ts` has no diff)
exact repro (static; BUN only):
```sh
rg -n -i 'telegram|discord|slack|matrix' /Users/pascaldisse/projects/gaia-daemon/src/core /Users/pascaldisse/projects/gaia-daemon/src/domain /Users/pascaldisse/projects/gaia-daemon/src/services /Users/pascaldisse/projects/gaia-daemon/src/daemon /Users/pascaldisse/projects/gaia-daemon/src/server /Users/pascaldisse/projects/gaia-daemon/src/daemon.ts
bun test test/telegram-bridge-format.test.ts
```
expected: Telegram-specific parsing, 4096-byte policy, inbound/outbound bridge DTOs live in a channel plugin package and enter GAIA only through registered plugin/descriptor contracts; core/domain/services/daemon/server contain no channel-specific implementation.
actual: `src/services/telegram-bridge-format.ts` is imported directly by `scripts/telegram-bridge.mjs`; it exports `TelegramInbound`, `parseTelegramUpdate`, `formatOutgoingForTelegram`, `splitForTelegram`, and `TELEGRAM_MAX_MESSAGE_LEN` from the core `services` layer. No plugin registration/descriptor boundary mediates that channel code.

PLUGIN verdict: FAIL — Plugin machinery exists (`src/services/plugin-host.ts`, `src/services/plugins.ts`, `src/services/bundled-plugins.ts`, `src/harness/runner-plugins.ts`); Telegram bridge formatter nonetheless leaks directly into `src/services/`. No Discord/Slack/Matrix core/domain/services/daemon/server hit found.

UNVERIFIED:
- No `bun test` executed: static-only constraint.
- No daemon, summon, or app execution.
- Pre-range origin cannot be attributed to one commit under the mandated `820e568..main` `git show` scope.
