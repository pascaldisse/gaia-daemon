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

## ADV-009 · HIGH · A6 extraction disables typechecking on the durability seam (`// @ts-nocheck`)

Atom → A6 room-service split; files `src/services/room/turn-loop.ts` (512 lines) + `src/services/room/fork.ts` (178 lines).

Defect → both extracted modules begin with `// @ts-nocheck` and take `private readonly service: any`. 690 lines carrying the durability seam (reserved `pendingTurn.eventId` commit path, `flushPartialReply`, `clearPendingTurn`, multi-target hand-off marker install, transcript fork/rewind + cursor capping) are excluded from `bun run check`. The green gate is therefore not evidence for this code: renaming/removing any `service.*` member or changing a durability signature compiles silently. Pre-split, this code was typechecked inside `room-service.ts`.

Repro:
```sh
W=/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/chat-mtk78q14-wa40
rg -n 'ts-nocheck|service: any' "$W/src/services/room/"*.ts
sed -i '' '1s|// @ts-nocheck|//|' "$W/src/services/room/turn-loop.ts" "$W/src/services/room/fork.ts"
bunx tsc -p "$W/tsconfig.json" --noEmit 2>&1 | grep -E 'room/(turn-loop|fork)'
git -C "$W" checkout src/services/room/turn-loop.ts src/services/room/fork.ts
```

Expected @ REFACTOR-LAWS (gate = proof) → extracted modules typechecked, helper↔façade contract explicit (typed interface, not `any`).

Actual @ `main` / worktree `a85cfea` → `bun run check` EXIT=0 while the two files are check-exempt; removing the suppression yields **9 errors** (fork 5, turn-loop 4), e.g.
```
src/services/room/turn-loop.ts(15,57): error TS2304: Cannot find name 'SendMessageOptions'.
src/services/room/fork.ts(134,11): error TS18046: 'cursor' is of type 'unknown'.
src/services/room/fork.ts(55,35): error TS7006: Parameter 'event' implicitly has an 'any' type.
```
Runtime behavior UNVERIFIED (no live queue run this atom); the gate-coverage regression is measured.

---

## 2026-09-02 bounded parent verdict · Jareth

Range → `820e568..main@2128ac7` · review branch → `room/chat-mtk78q14-wa40`.

Gate 真:
- `bun run check` → exit 0; Knip debt still emitted/non-enforcing → ADV-003 remains.
- diff-touched tests, isolated files → accounts 5 · context-gate 2 · gaia-tool 14 · hints 3 · paths 2 · prompt 22 · retry 1 · rooms 51 · runner-host-proxy 2 · skills 3 = **105/0**.
- split/durability controls → room-service 98 · pi-runtime 39 · daemon-delete 4 · runner-host 18 · summons 35 = **194/0**.
- Telegram formatter control → **10/0**; architecture boundary failure unaffected → T-K1.

Live 真 → compiled isolated daemon · `GAIA_HOME` isolated · port 18787:
- U1→U3 then edit U2 → PASS; active transcript loses old tail; rewound archive retains it; Pi edited-user parentId points to A1.
- retry U1 → PASS; regenerated root branch only.
- tiny `/compact luna` → PASS clean no-op (`session too small`).
- agent→agent mention then edit → UNVERIFIED.
- queue A1 ToolProviders · A6 crash/WAL recovery · A7 boot/settings reload → UNVERIFIED.
- cleanup → daemon killed · live dist/home removed · `lsof -nP -iTCP:18787 -sTCP:LISTEN` empty.

Current clean atoms → A2a `0d9f141` · A2b `cec7a22` · A2c `e47adf0` · A3 retry `5948608` · A8b `7a218ab` · A9 `df58abc`. A8 first atom ADV-005 superseded structurally by A8b; historical ticket retained append-only. A6/A7 focused behavior tests green ≠ architecture clean → ADV-007/008/009.

RULE0 → 0 · layering → 0. New-wave tickets → HIGH 4 · MED 2 · LOW 3. Cumulative ledger sections → BLOCKER 3 · HIGH 7 · MED 2 · LOW 3; T-V4 duplicates open ADV-004 evidence.

### Late-main delta · A6b `8fcad7e` (landed during review)

Main moved `2128ac7` → `8fcad7e` after first verdict; branch merged latest main before landing.
- ADV-007 current measurement → `room-service.ts` 2,527 lines, not 3,718; A6b extracts 1,201 lines but façade remains >3× plan ceiling 800 → ticket remains HIGH.
- ADV-009 current measurement → check-exempt surface expands: `commands-facade.ts` 514 + `sanitize-facade.ts` 247 join `fork.ts` 178 + `turn-loop.ts` 512 under `// @ts-nocheck` = **1,451 lines**. New façade context types expose `[key: string]: any`; ticket severity remains HIGH.
- post-merge gate 真 → `bun run check` exit 0 (non-enforcing Knip debt emitted) · `bun test test/room-service.test.ts` **98/0**.
## ADV-PASS-2 · 2026-09-02 · 陰の木 adversarial refactor audit

## ADV-011 · HIGH · A5c LIVE prerequisite cannot deliver required `@luna` turn
Atom → `gaia/jareth-mtklhqjcox0sbw-pass2@d7d637e` live build; daemon hash `d7d637e`.
Repro:
```sh
W=/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/naru-kimi-mtkliyd9wo8b3i
GAIA_HOME="$W/.gaia/livehome" GAIA_PORT=18787 "$W/.gaia/livetest-dist/gaia-daemon"
# authenticated POST /api/workspaces -> id 3efc0c32a73d6aaf
# authenticated POST /api/workspaces/3efc0c32a73d6aaf/rooms/default/messages
# body: {"text":"@luna LIVE-AUDIT-EXACT-TOKEN","queue":true}
```
Expected → required exact `@luna` message accepts (202), reserves durable user event, then enables edit/retry and pending-turn recovery audit.
Actual → HTTP 500 `{ "error":"Unknown agent: @luna. Available agents: @dario, @gaia, @sidia, @terry" }`; GET events remains `[]`; no `transcript.jsonl`, `rewound.jsonl`, or `pi-sessions` evidence exists for this flow.
Boundary → ticket only; no fix. The isolated daemon did build and listen on 127.0.0.1:18787. UNVERIFIED → agent→agent mention/edit parent chain; web/artifact; SIGKILL/restart exactly-once; settings reload; full registered-route authenticated smoke.

## ADV-012 · LOW · A5c leaves dead parallel route residue
Atom → `b8db169` route extraction · measured at `main@20eb9b6`.
Repro:
```sh
W=/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/main-build
rg -l '\bsanitizeEditRefs\b' "$W/src" "$W/test"
rg -n '\bbootId\b' "$W/src/server/routes/api.ts"
bun run check
```
Expected → every new `src/server/routes/*.ts` export has production/test caller; split leaf contains no abandoned local duplicate.
Actual → `sanitizeEditRefs` exported only at `src/server/routes/rooms.ts:9`, zero callsite; `src/server/routes/api.ts:28` retains unused `const bootId = ""` while live SSE uses `ctx.bootId` at line 194. `bun run check` exits 0 because Knip is non-enforcing and reports `sanitizeEditRefs` among 115 unused exports.
Behavior impact → none measured; dead parallel surface only.

## ADV-PASS-2 · parent verdict · `main@20eb9b6`
Range → `768115b..20eb9b6` · A5c/A7c/A7d + UI + late-main UI/drafts.

Static 真:
- PRAGMA → baseline=current: 4 `src/services/room/*` `@ts-nocheck` + 10 façade `as any`; NEW=0; ADV-009 remains open.
- RULE0 exact → 4 hits, all allowed `typeof ...harness === "string"` guards: `core/config.ts:384` · `domain/accounts.ts:47` · `server/routes/agents.ts:58` · `services/hints.ts:454`.
- layering upward imports → 0.
- hardcode scan → only `core/config.ts:41` configured default 8787 + seatbelt canonical `/private/tmp`; new violation=0.
- route retention → literal `/api|/v1` sets 36/36 exact; parameter regex sets 42/42 exact; missing route=0.
- new daemon/route export callsites → all ≥2 source/test files except ADV-012 `sanitizeEditRefs`.
- durability seams → queue/pending-turn recovery focused control 98/0; no late-main daemon/service delta.

Gate 真:
- `bun run check` at `a0f7bc8` → exit 0; Knip debt non-enforcing.
- `bun test test/http-routes.test.ts` → 7/0 final head.
- `bun test test/daemon-delete.test.ts` → 4/0; `bun test test/room-service.test.ts` → 98/0 before late web-only merge.
- `bun test web/src/composer-drafts.test.js` → 2/0 final head.

Live 真/未驗:
1. agent→agent mention + edit parent chain → UNVERIFIED; `@luna` prerequisite HTTP 500 → ADV-011.
2. ToolProviders web/artifact → UNVERIFIED beyond focused artifact HTTP unit.
3. SIGKILL pending-turn exactly-once → UNVERIFIED beyond 98/0 durability controls.
4. settings reload without room drop → UNVERIFIED.
5. full route-table authenticated smoke → UNVERIFIED; static table parity + route-focused 7/0 only.
- queue → § `docs/REFACTOR-LIVE-QUEUE.md`; blocked-run status appended.
- UI visual app drive → UNVERIFIED; pass law forbade gaia-daemon.app/8787.
- cleanup 真 → isolated daemon killed · dist/home removed · port 18787 `lsof` empty.

Atoms clean → A5c route registration parity · A7c harness claim extraction · A7d interaction extraction · UI commits `efc2e48`/`c80a074`/`2d3e9a2` static+check only · late `230ca8e` drafts unit 2/0.
Dead branch → two Vishnu/naru-opus lanes blocked before output; no disk artifact salvageable; STATIC performed by parent.

---

## ADV-011 resolution · live seed correction — 2026-09-02
- prior `Unknown agent: luna` → TEST-SETUP; not daemon regression.
- corrected seed → `<worktree>/.gaia/livehome/agents/luna/` copied whole; whole `accounts.json` + `config.json`; workspace payload listed `luna` before every probe.
- proof → TOKEN-1/2/3/4 + tool turn committed by luna; evidence `docs/REFACTOR-LIVE-RESULTS-20260902.md`.
- status → superseded as daemon ticket.

## ADV-013 · HIGH · app payload 500 after corrected live seed — 2026-09-02
- repro → compiled isolated daemon @ `4bd87be`; corrected seed; `GET /api/app`.
- expected → 200 app payload.
- actual → 500 `Missing workspace config: .../ghoul-terra-mtklq5ixkikbww/.gaia/config.json`; boot also skips summon recovery for cwd workspace.
- impact → full authenticated A5c route smoke blocked; no fix in live child.

## Nyari triage — ADV-013 (09-02 23:35)
- ADV-013 reclassified PRE-EXISTING / MED, not A5c: throw = src/domain/workspace.ts:147, untouched 768115b..main (`git log -S'Missing workspace config'` empty; cwd-workspace path diff 0).
- Trigger: daemon cwd inside a dir w/ `.gaia/` but no `.gaia/config.json` (any worktree) → GET /api/app 500 + summon recovery skipped.
- A5 route smoke → PASS for parity (all other routes 200/401 as expected). Fix = W4 atom (auto-workspace: bootstrap config or skip cwd w/o config), not refactor scope.

## PASS #3 · W3 plugin system + W4 A16 live · 2026-09-03

Scope → `b4c126d..0bb260c` · audit branch `audit/pass3-w3-a16-20260903` · fixes forbidden.

### ADV-014 · HIGH · capability broker is a stub

Repro @ `0bb260c`:
```sh
git grep -nE 'new CapabilityBroker|grantSource|trustSource' -- src/services/plugins.ts scripts/telegram-bridge.mjs src/services/capabilities
```
Expected → daemon-owned grant policy + effective room/agent trust feed every manifest contribution invocation; `trust:false` remains forced-empty.
Actual → only live constructions use `grantSource: () => undefined, trustSource: () => false` (`src/services/plugins.ts:162`, `scripts/telegram-bridge.mjs:69`); nonempty `requiredCaps` permanently deny; no domain/config grant source reaches broker. Cap-free plugins exercise no authorization policy.

### ADV-015 · HIGH · bundled plugins bypass or never reach manifest runtime

Repro @ `0bb260c`:
```sh
git grep -nE 'loadCommandPlugins|PluginRegistry|listBundledPlugins|pluginRegistry:' -- src scripts
git ls-tree -r --name-only 0bb260c -- addons plugins | rg 'plugin.json|plugins/(defaults|fugu|rpg-engine)'
```
Expected → daemon boot discovers + validates bundled manifests before import; daemon retains one registry/lifecycle owner; `RoomService` receives its turn boundary.
Actual → `RoomService.pluginsPromise` calls `loadCommandPlugins()`; bundled defaults import loose `.mjs` directly (`src/services/plugins.ts:131-153,190-198`). `fugu`/`rpg-engine` have no `plugin.json` or daemon registry caller. Telegram's manifest is reached only by standalone `scripts/telegram-bridge.mjs`, not daemon boot. `RoomServiceOptions.pluginRegistry` remains optional and has no production injection; transient registries are discarded after startup wrappers are copied. Mid-turn manifest staging through the daemon is unreachable.

### ADV-016 · HIGH · two incompatible manifest/lifecycle systems coexist

Repro @ `0bb260c`:
```sh
git grep -nE 'interface PluginManifest|class PluginHost|class PluginRegistry' -- src/services
```
Expected → one manifest ABI + one lifecycle/registry implementation.
Actual → `src/services/plugin-manifest.ts` requires `{schema,name,entrypoint,permissions,...}` and feeds `plugin-host.ts`; W3 adds `src/services/plugins/manifest.ts` requiring `{id,placement,contributes,...}` and feeds `plugins/registry.ts`. `addons/telegram/plugin.json` matches only the second. Old `listBundledPlugins`/`PluginHost` have no production caller; parallel surfaces violate zero-duplication and cannot consume the same package.

### ADV-017 · HIGH · generation lifecycle is not serialized across disposer await

Repro @ `0bb260c` → registry candidate G0 disposer blocks on a promise; call `stageReload()` + `applyTurnBoundary()`; before resolving G0 disposer, stage/apply G1.
Expected → G0 disposal completes before G1 registration/swap/disposal begins.
Actual → `plugins/registry.ts:236-244` swaps + clears staged before awaiting old disposal; a second stage/apply can overlap G0 disposal with G1 lifecycle. Invocation lease (`:305-313`) protects contribution execution, not lifecycle operation serialization.

### ADV-018 · MED · A16 live assertion does not prove claimed fork parent

Repro @ `f812940`:
```sh
nl -ba test/edit-resend-live.test.ts | sed -n '362,371p'
```
Expected → `editedEntry.parentId === <assistant reply immediately before U2>.id`.
Actual → `preEditReplyEntry` is found by token only (may select U1 user entry) and never compared to `editedEntry.parentId`; only optional inequality against one old-tail entry is asserted. Live opt-in may pass with an arbitrary wrong parent.

### ADV-019 · LOW · A6f left a dead duplicate dialogue limit

Repro @ `0bb260c`:
```sh
rg -n 'AGENT_DIALOGUE_MAX_HOPS' src/services/room-service.ts src/services/room test/room-service.test.ts
```
Expected → one canonical dialogue-hop constant.
Actual → live canonical `summon-lifecycle.ts:17` is re-exported by `room-service.ts:94`; A6f copied byte-identical `export const AGENT_DIALOGUE_MAX_HOPS = 8` into `task-operations.ts:8`, where nothing imports or reads it. Knip also reports this export.

### A6c–A6h static verdict

- extraction discipline → PASS except ADV-019 residue; new queue/turn-results/summon/lifecycle/task/command/monad bodies have production facade/delegation callsites; no second behavior body found in `room-service.ts`.
- durability → PASS: queue/pending mutation owns one implementation in `domain/rooms.ts:1051-1157`; physical atomic write owns one implementation in `core/store.ts`; extracted room files invoke/read those seams, never reimplement persistence.
- A6h transient ledger typo → `bc6c96c` named nonexistent `c8069bb`; `c8023a3` corrected it to landed `a931351`; no HEAD residue.
- requested stale-branch salvage → `gaia/ghoul-terra-mtkojg90dhpql1@b1647ed` is not an ancestor of `0bb260c`. `b1647ed:room/command-execution.ts` and `a931351:room/command-execution.ts` have identical blob `474815c6`; this is the salvaged part. Dropped extraction-only parts: `615f90e` `room-maintenance.ts` (setup/clear/refresh/fork/event lookup/tool-result methods remain in facade at audited HEAD) and b164's function-style `background-tasks.ts` rewrite (main retains the independently landed class implementation from `8fcea00`). Dropped user behavior → none measured; dropped refactor surface → those two files/variants.

### W3 steal-list delivery

| item | verdict | evidence |
|---|---|---|
| manifest-first validation | PARTIAL | new validator/loader exists; bundled defaults bypass; daemon/addon boot discovery absent |
| atomic swap | PARTIAL | registry algorithm exists; no daemon owner; disposer overlap ADV-017 |
| turn lease | PARTIAL | registry invocation + optional RoomService seam exist; no production injection |
| capability broker | MISSING | API exists; real grants/trust absent → ADV-014 |
| disposer/dependency lifecycle | PARTIAL | reverse disposer exists; no retained shutdown owner/dependency graph; overlap ADV-017 |

### Static non-findings

- `rg -n 'pragma|harness\\s*===|harness\\s*!==' src/services/plugins src/services/capabilities src/services/plugins.ts` → 0.
- W3 service imports → no server/daemon upward import; harness contribution wire remains data contract.
- `src/services/plugins/loader.ts` → not test-only: default loader for transient command registry + standalone Telegram registry; no daemon-owned persistent consumer.

### Gate · parent @ `cf73776` (code tree = `0bb260c`; ledger-only delta)

- `bun run check` → exit 0 · 6.80s; TypeScript worlds green; configured `knip --no-exit-code` ran and reported existing debt (4 unused files · 116 unused exports · 77 unused exported types).
- touched tests discovered by `git diff --name-only b4c126d..0bb260c -- 'test/**'` → 10 files.
- each file run separately → `edit-resend-live` 4 pass/1 live skip · `plugins-capabilities` 16/0 · `plugins-contracts` 4/0 · `plugins-loader` 2/0 · `plugins-manifest` 4/0 · `plugins-migration` 4/0 · `plugins-registry` 5/0 · `room-service` 99/0 · `rooms` 53/0 · `telegram-bridge-format` 3/0. Aggregate → 194 pass · 1 intentional live skip · 0 fail.
- Knip enforcement → configured but non-enforcing (`package.json` `check:dead = knip --no-exit-code`); gate cannot fail on dead exports.

### Live verdict · isolated compiled daemon @ `0bb260c`

- A16 → **PASS**. Command: `GAIA_LIVE_EDIT_RESEND=1 ... bun test --timeout 120000 test/edit-resend-live.test.ts` → 5 pass · 0 fail. Token `TOKEN-4435348c`: active transcript contained A1 + A2-EDITED only; `rewound.jsonl` contained A2-OLD; Pi session edited-user `19268617.parentId=69b6694a` (A1 assistant), not old-tail `93aa687d`. Independent disk inspection proves this run's parent chain despite ADV-018's insufficient automated assertion.
- plugin bundled-command/generation boundary → **FAIL · unreachable**. Production grep found no daemon/server `pluginRegistry` injection; bundled defaults use loose loader. Therefore no honest live path can stage a bundled manifest during a room turn. No invented harness; ADV-015.
- cleanup → PASS: child killed isolated daemon; removed generated `dist/`, home, workspace; `lsof -nP -iTCP:18787 -sTCP:LISTEN` empty; orphan process sweep empty.
- live owner branch proof → `gaia/ghoul-terra-mtkotwumdct15f@555941f`.

### Landing gate · merged newer main `249e7b1` into audit branch

- `bun run check` @ `ca5f591` → exit 0 · 6.97s; configured Knip inventory emitted.
- `bun test test/room-service.test.ts` @ `ca5f591` → 99 pass · 0 fail · 9.45s.
- scope verdict remains pinned to requested `0bb260c`; newer A6i maintenance extraction is outside PASS #3 scope.

---
## ROOT #9 closure · 2026-09-03

### ADV-014 · FIXED · `c529bf4`
- daemon owns broker sources: workspace `.gaia/config.json` `plugins.grants[agentId]` + loaded `agent.json` `capabilities`; default `{}`/`[]`.
- trust source → existing `isTrusted(agent)`; missing workspace/agent fail closed; `trust:false` bypasses grant lookup → no non-safe capability.
- evidence → `bun test test/capabilities-daemon-sources.test.ts` 6/0; untrusted network denial · trusted grant allowance · granted/untrusted denial.

### ADV-015 · FIXED · `6641107`
- manifest inventory → `plugins/{defaults,fugu,rpg-engine,rpg.mjs}` + `addons/telegram`; Telegram `process:"standalone"`.
- roots → injectable `bundledDir("plugins")` + `globalPaths.commandPluginsDir()`; no loose `readdirSync` command loader.
- evidence → `test/bundled-plugins.test.ts` validates inventory before import; rpg/dog/Telegram focused tests green.

### ADV-016 · FIXED · `1de4129`
- one production `PluginRegistry` + `CapabilityBroker` → `src/daemon.ts`; RoomService adapter receives injected typed registry; no module-level loader/default registry.
- evidence → registry/room/bundled tests green; construction scan below.

### ADV-017 · VERIFIED · inherited `c03795b`
- `PluginRegistry.#serialize` queues stage/apply/shutdown through one lifecycle tail; disposer await remains serialized.
- evidence → `test/plugins-registry.test.ts` lifecycle/staging cases green after #9 integration.

### ADV-018 · FIXED · `6bca2e1`
- A16 fixture reads new Pi-session tail `parentId`; equality to edited message id + inequality to old tail required.
- red → expected edited id, actual old-tail id; green → `test/edit-resend-live.test.ts` 4/0 + one live skip.

### ADV-019 · FIXED · `6bca2e1`
- dead `task-operations.ts` duplicate deleted; canonical `room/summon-lifecycle.ts` export retained/re-exported.
- evidence → canonical-only `rg AGENT_DIALOGUE_MAX_HOPS` scan.

## PASS #4 FINAL — W3 completion live + closing static

### PASS #4 parent gate salvage · code `338db79`
- `naru-flash` lane → infrastructure failure before output: HTTP 402 `Insufficient Balance`; no repository verdict derived.
- independent root salvage → `bun run check` rc 0 (6s).
- touched existing tests, each isolated → `bundled-plugins` 3; `capabilities-daemon-sources` 6; `edit-resend-live` 4 + live opt-in 1 skipped; `plugins-capabilities` 16; `plugins-manifest` 4; `plugins-registry` 6; `room-service` 99; `rpg-plugin` 2; `telegram-bridge-format` 3. Total → 143 pass · 0 fail · 1 live skip.
- deleted since `4fda75d` → `plugin-host.test.ts` · `plugin-manifest.test.ts` · `plugins-migration.test.ts`.
- raw gate evidence → `.gaia/pass4-parent-gate.log` (worktree-local; command/output/rc/duration).

### ADV-020 · HIGH · bundled command plugins unreachable through production registry
- code → `338db79`; introduced across `4589145` · `74b0d70` · `1de4129` · asserted by `6641107`.
- repro → `bun test test/dog-mode-integration.test.ts`; control → `bun test test/dog-mode-plugin.test.ts`.
- expected → bundled `/dog` + discipline commands load at zero setup through daemon registry; real plugin behavior retained.
- actual → integration `0 pass · 8 fail`; replies = `Unknown command: /dog` / `/stfu` / `/push` / `/shock` / `/slap`; pure plugin control `23 pass · 0 fail`.
- cause → all bundled manifest `contributes.commands=[]`; all manifest `index.mjs` files return `{}`; real `plugins/defaults/dog-mode.mjs` + `plugins/rpg.mjs/plugin.mjs` have no production importer; manifest command result also lacks legacy `state|activeAgent|panel|prompt|rewriteAsMessage|renderCap|turnStart` surface.
- `plugins/rpg.mjs/` verdict → migration artefact/shim, not functioning manifest package: file-like directory + no-op `index.mjs`; real RPG module stranded as `plugin.mjs`.
- evidence → `docs/REFACTOR-PASS4-STATIC-SONNET.md`; raw parent runs → `.gaia/pass4-parent-dog-regression.log` + `.gaia/pass4-parent-dog-control.log`.

### ADV-021 · HIGH · registry command results + capability denials disappear from durable room evidence
- code/build → source `338db79`; compiled tree `a9550fb` = source + docs only.
- repro → generated manifest command `/probe trusted` then same command with seeded agent `trust:false`; both HTTP `202`, task `complete`.
- expected → trusted+granted reply in transcript; untrusted non-safe capability denial in transcript/log; denied plugin body never entered.
- actual → authorization floor works: side-effect marker count remains `1→1`; trusted + denied transcripts/events both empty; denial absent from daemon log; client only receives completed task.
- cause seam → `RoomQueue.sendMessage()` emits plugin command reply as transient `room-event`; no durable append; `runPlugin()` converts broker rejection to reply, then same transient-only path.
- evidence → `docs/REFACTOR-PASS4-LIVE.md` LIVE-P4-001; `.gaia/live-test-runs/pass4-20260903012416/{probe-trusted.json,probe-untrusted.json,marker-count-before-denied.txt,marker-count-after-denied.txt,transcript-after-allowed.jsonl,transcript-after-denied.jsonl,daemon.log}`.

### ADV-022 · HIGH · no live manifest staging trigger or daemon lifecycle observability
- code/build → source `338db79`; compiled tree `a9550fb`.
- repro → boot probe manifest `1.0.2`; hold `/probe inflight`; replace manifest/entrypoint with `1.0.3`; finish old turn; invoke `/probe next`.
- expected → old generation completes; staged generation swaps at turn boundary; next invokes `1.0.3`; old disposer exactly once at swap in daemon log.
- actual → `V102 entered generation=1 args=inflight` + `V102 entered generation=1 args=next`; no stage/swap; disposer only at shutdown.
- static corroboration → sole production `stageReload()` call = `Daemon.boot()`; daemon registry constructed without `onEvent`; manifest changes cannot request staging or log lifecycle events.
- evidence → `docs/REFACTOR-PASS4-LIVE.md` LIVE-P4-002; `.gaia/live-test-runs/pass4-20260903012416/{probe-inflight.http,probe-next.http,manifest-executions.txt,evidence/manifest-after-change.json,daemon.log}`.

### ADV-023 · LOW · plugin lifecycle classes exported without production consumers
- code → `338db79`.
- repro → `rg -n '\b(RegistryLifecycleError|PluginTurnLease)\b' src --glob '*.ts'`.
- expected → every export in `src/services/plugins/*` + `src/services/capabilities/*` has non-test production consumer.
- actual → both symbols occur only inside `src/services/plugins/registry.ts`; unnecessary public surface.
- evidence → `docs/REFACTOR-PASS4-STATIC-KIMI.md` STATIC-002.

### PASS #4 closing static verdict
- trust floor → PASS: `trust:false` + agent/workspace `network` grants still denied; all-cap grant source cannot override; trusted+granted allowed; focused static gate `31 pass · 0 fail`.
- authority scan → PASS: provider/model terms only contribution vocabulary + prohibition comment; no identity-based capability decision; no harness-id security branch.
- layering/RULE0/pragmas → PASS: capability/plugin services import no daemon/server layer; forbidden branch + pragma scans zero.
- composition → PASS: one production `new PluginRegistry` + one `new CapabilityBroker` at `src/daemon.ts:192/205`; no `readdirSync` plugin loader.
- export inventory → FAIL only ADV-023.
- bundled RPG directory → FAIL under ADV-020; no-op manifest shim, not real command package.

### PASS #4 live queue verdict · compiled source `338db79`
- A1 ToolProviders bridge → UNVERIFIED in PASS #4; not rerun.
- A5 HTTP route suite → UNVERIFIED; only authenticated `GET /api/app` rc 0 during seed validation.
- A7 recovery + deferred settings reload → UNVERIFIED; not rerun.
- A6 retry/edit/rewind + restart/WAL suite → PARTIAL: A16 edit/resend branch only; remaining scenarios not rerun.
- A6c durable queue → UNVERIFIED; not rerun.
- W4 A16 opt-in → PASS: real compiled daemon; `GAIA_LIVE_EDIT_RESEND=1 ... bun test --timeout 120000 test/edit-resend-live.test.ts` → `5 pass · 0 fail` in 7.52s; transcript/rewound/Pi parent-chain disk evidence retained.
- A10 manifest validation → UNVERIFIED live; not rerun.
- A13 typed contributions/capabilities → FAIL: trusted body entered + untrusted body blocked, but reply/denial observability missing → ADV-021.
- A14 manifest command → FAIL: custom fixture executes but durable room proof missing → ADV-021; bundled command unreachable → ADV-020.
- ROOT #9 bundled command/generation/denial → FAIL: ADV-020 · ADV-021 · ADV-022.
- cleanup → PASS: daemon killed; generated `dist/home/ws` removed; `lsof -nP -iTCP:18787 -sTCP:LISTEN` = empty; run-root orphan sweep = empty.

### PASS #4 final gate
- `bun run check` → rc 0 · 6s.
- every existing test touched in `4fda75d..338db79`, isolated process/file → 143 pass · 0 fail · A16 live opt-in 1 skipped in gate; deleted tests identified, not run.
- touched files → `bundled-plugins` 3 · `capabilities-daemon-sources` 6 · `edit-resend-live` 4+1 skip · `plugins-capabilities` 16 · `plugins-manifest` 4 · `plugins-registry` 6 · `room-service` 99 · `rpg-plugin` 2 · `telegram-bridge-format` 3.
- additional regression repro → `dog-mode-integration` 0/8; independent pure-plugin control 23/0 → ADV-020.
- raw output → `.gaia/pass4-parent-gate.log`.

### PASS #4 overall verdict
- **W3 NOT DELIVERED** → bundled commands absent + durable command/denial evidence absent + no live reload trigger; queue also not fully rerun within bounded lane.

## W3 REAL DELIVERY · 2026-09-03

### ADV-020 · FIXED · `f218e91`
- RED → `bun test test/dog-mode-integration.test.ts` → `0 pass · 8 fail`; `/dog` et al. → `Unknown command`.
- GREEN → `bun test test/dog-mode-integration.test.ts` → `8 pass · 0 fail`.
- real package registrations → defaults/dog-mode · fugu · rpg-engine · rpg; `plugins/rpg.mjs/` shim removed; Telegram declaration/registration retained standalone.
- contract → reply · steer · activeAgent · state · rewriteAsMessage · targets · panel · prompt · renderCap · turnStart preserved through registry adapter.
- inventory proof → `bun test test/bundled-plugins.test.ts` → `4 pass · 0 fail`; every bundled manifest declares commands; each resolves callable through production registry.

### ADV-021 · FIXED · `077d846` · integration `1dc052a`
- RED → plugin replies/denials emitted transient `room-event` only; transcript empty; denial provenance/log absent.
- GREEN → `bun test test/room-service.test.ts` → `101 pass · 0 fail`; fresh RoomHandle reread proves transcript persistence.
- reply → `kind=plugin-reply`; denial → `kind=capability-denied`; `details.pluginDenial={pluginId,capability,agentId,reason}`.
- durability seam → `appendPluginEvent` → shared room-lock fsynced append + atomic cursor acknowledgement, then live emit; no memory-only reply path.
- trust:false proof → contribution body counter `0`; denial log `[capabilities] denied plugin=... capability=... agent=... room=... reason=...` captured.

### ADV-022 · FIXED · `2177872`
- RED → lifecycle gate `7 pass · 1 fail`: missing ordered plugin-id observability.
- GREEN → `bun test test/plugins-registry.test.ts` → `8 pass · 0 fail`.
- trigger → settings-file PUT stages registry; `POST /api/plugins/reload` stages only.
- daemon observation → staged · swapped · disposed logs include generation/plugin IDs.
- boundary proof → held v1 command → staged v2 → boundary blocked → v1 complete → v2 next → v1 disposer once; ordered events asserted.

### ADV-023 · FIXED · `2177872`
- lifecycle internals un-exported; production registry owns their use.
- proof → `rg -n 'export.*(RegistryLifecycleError|PluginTurnLease)' src/services/plugins/registry.ts` → `0`.

## Pass 5 W3 sign-off — 2026-09-03

- baseline → `a995bb0`; isolated adversary branch → `adversary/pass5-w3-signoff`.
- live lane → `ghoul-terra-mtkrd610i7uwmq`; branch `adversary/pass5-live-terra`; evidence commits `84eebe5` + `237ce60`.
- dog regression → PASS: `bun test test/dog-mode-integration.test.ts` → `8 pass · 0 fail`.

### ADV-024 · P1 · exact baseline cannot produce compiled daemon
- repro → initialized pinned submodules; `bun run build --out .gaia/live-test-runs/pass5-20260903020111/dist`.
- expected → compiled daemon from `a995bb0`; W3 live sign-off runnable.
- actual → rc 1; `src/services/artifacts.ts` imports `../../design/src/{artifacts,artifact-revisions}.js`; pinned design `bf41ca3` contains `.ts` only; Bun cannot resolve either `.js` module.
- consequence → required live items 1–5 UNVERIFIED; daemon never started; no workaround/fix permitted in adversary pass.
- evidence → `docs/REFACTOR-PASS5-W3-LIVE.md`; child run `/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/ghoul-terra-mtkrd610i7uwmq/.gaia/live-test-runs/pass5-20260903020111/evidence/{build.log,dog-regression.log,lsof-before.txt,lsof-after.txt,orphan-sweep.txt}`.
- cleanup → generated dist/home/ws removed; daemon PID none; port 18787 listener empty; orphan sweep empty.

### Pass 5 static adversary verdict
- lane → `naru-sonnet-mtkrd6109tbgfp`; branch `adversary/pass5-static-sonnet`; evidence commit `183f0e8`; detail → `docs/REFACTOR-PASS5-STATIC-SONNET.md`.
- ADV-020 → PASS: exact dog repro `8 pass · 0 fail`; bundled inventory `4 pass · 0 fail`.
- ADV-021 → PASS: agent `commitTurn()` + plugin `commitAuxiliaryEvent()` converge on private `commitEventLocked()` → one room lock · idempotent append · transcript line resolution · one atomic state acknowledgement; queue append-before-emit; no second plugin persistence path.
- ADV-022 → PASS static: API + settings PUT stage reload; lifecycle logger covers staged/swapped/disposed with generation/plugin IDs; registry gate `8 pass · 0 fail`.
- ADV-023 → PASS: lifecycle classes private; export scan zero.
- new exports → all production-consumed; RULE0/pragmas/upward-import scans → zero violations.
- tickets → none from static pass.

### Pass 5 parent static gate
- `bun run check` → rc 0.
- each existing test touched in `ad85ee3..a995bb0`, isolated → `bundled-plugins` 4 · `dog-mode-integration` 8 · `plugins-registry` 8 · `room-service` 101 · `rpg-plugin` 2 = **123 pass · 0 fail**.
- evidence → `.gaia/pass5-parent-static-gate.log`.

### Pass 5 final verdict
- W3 live items 1–5 → UNVERIFIED due ADV-024 before daemon boot.
- W3 DELIVERED → **NO**.
- `a995bb0+` safe to build into app → **NO**: production compiled-build command fails at exact baseline.


## Nyari triage — ADV-024 (09-03 02:10)
- ADV-024 reclassified TEST-SETUP, not main: design submodule pointer bf41ca3 identical b800c07→a995bb0 (b800c07 = Pascal's running build); import `design/src/artifacts.js` dates from d8572f5; `bun run scripts/build-daemon.mjs --out` from .gaia/worktrees/main-build @ a995bb0 → binary 79330658 bytes, rc 0 (Nyari's hand). Child used `bun run build --out` in a fresh worktree; passes 2/4 built the same tree fine.
- Live recipe law: build ONLY via `bun run scripts/build-daemon.mjs --out <worktree>/.gaia/livetest-dist` after `git -C <worktree> submodule update --init --recursive`.

## PASS5B ledger pass — 2026-09-03 (ghoul-sonnet, ATOM 3)

Source → `docs/REFACTOR-PASS5B-LIVE.md` (base `62fdfe8`, branch `live/pass5b`, run root `.gaia/live-test-runs/pass5b-20260903020808`). Ledger-only atom; no code touched.

## PASS5B-001 · MED · A16 opt-in compiled-live rerun times out under default 120000ms

Atom → W3 pass 5b compiled live rerun; `docs/REFACTOR-PASS5B-LIVE.md` item 4.

Repro:
```sh
GAIA_LIVE_EDIT_RESEND=1 LIVE_WORKSPACE_DIR=<worktree>/.gaia/livews GAIA_PORT=18787 \
  bun test --timeout 120000 test/edit-resend-live.test.ts
```
Expected → 5 pass / 0 fail (matches PASS #3 20260903 evidence: `5 pass · 0 fail` @ `0bb260c`, and PASS #4 evidence: `5 pass · 0 fail` @ `338db79`).
Actual @ `62fdfe8` → rc 1, 4 pass / 1 fail, transcript wait timeout; evidence `a16-test.log`, `a16-exit.txt` under `.gaia/live-test-runs/pass5b-20260903020808/`.

Verdict → not a proven regression on this single run alone (prior compiled runs at `0bb260c`/`338db79` both passed 5/0 under the same 120000ms harness default). No fix; ticket only. Boundary → next live attempt MUST raise the invocation to `--timeout 240000` (§`docs/REFACTOR-LIVE-QUEUE.md` W4 A16) before re-asserting pass/fail. If 240000 still times out, that is new evidence and the default-timeout theory is falsified — open a fresh ticket, do not fold into this one.

## PASS5B-002 · HIGH · `POST /api/plugins/reload` does not refresh an already-open RoomService's command map

Atom → W3 pass 5b compiled live rerun; `docs/REFACTOR-PASS5B-LIVE.md` item 3.

Repro (must stay in ONE already-open room end-to-end — a fresh room/RoomService after reload is not evidence either way):
```sh
# room R already open, RoomService instance already live before any of the below
1. hold a v1 command turn in room R (blocking probe)
2. mutate manifest/entrypoint on disk → v2
3. POST /api/plugins/reload
4. release the held v1 turn → expect v1 completes on generation 1
5. issue the next command in the SAME room R → expect generation 2 (v2) served
6. inspect disposer/event log → expect exactly one v1 dispose entry
```
Expected → held v1 turn completes on its own generation; reload stages v2; the very next turn in the SAME open room R serves v2; disposer for generation 1 fires exactly once (§`docs/REFACTOR-LIVE-QUEUE.md` ROOT #9 W3 live repros, "staged manifest boundary"; matches ADV-022's static `held v1 command → staged v2 → boundary blocked → v1 complete → v2 next → v1 disposer once` claim).
Actual @ `62fdfe8` → the RoomService instance already open before reload retained its generation-1 command map through the reload; no observed stage/swap boundary inside that open room; only a subsequent settings-file PUT reload (a different reload path, implying new RoomService construction) picked up v2. Evidence → `v2-reload.json`, `v2-daemon.log`, `v3-settings.json`, `v3-daemon.log` under `.gaia/live-test-runs/pass5b-20260903020808/`.

Verdict → escalates PASS5B item 3 from UNVERIFIED to suspected defect: `POST /api/plugins/reload` on an already-open room either does not reach that room's live registry reference, or the open RoomService reads a stale command-map snapshot instead of the daemon-owned `PluginRegistry` through the boundary each turn. No fix (ticket only, static ADV-022 claim re-tested live and not yet confirmed by this repro's constraints).
