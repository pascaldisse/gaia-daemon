# REFACTOR LOG v1 (陽の木 · root @naru-opus)

## A0 — lineage repair + gate green (root, 2026-09-02)
- root WIP (15 files) → `wip/a0-compact-clean` @ 97e4c24, applied on true base 5502e39 (clean).
- 094bd51 merge fix/native-weblinks → main lineage.
- dc2c552 compact-clean seam completed: protocol.ts union + runner.ts case + optional `compactClean?` on AgentRuntime (harness variance = DATA) + host.ts Extract widened.
- gate: check green · runner-host{,-proxy} 20 pass. root porcelain=0.
- trap: fresh worktree ⇒ `git submodule update --init design unmute` + `bun install` else phantom TS2307 (design/ = submodule).

## W1 — hygiene (2026-09-02)
- A1 layering @ghoul-terra · `refactor/a1-layering` 4233f82 → merge 630a7b5.
  harness→services upward imports = 0 (grep proof). `ToolProviders` port; services inject via daemon `/api/harness/tools` bridge.
  root re-gate: check green · gaia-tool+runner-host+http-background-tasks+runner-plugins 39 pass.
  UNVERIFIED live: runner→/api/harness/tools bridge → docs/REFACTOR-LIVE-QUEUE.md (owner 陰).
- A2 dead code @naru-sonnet · 0d9f141 (core+domain) · cec7a22 (harness+services) · e47adf0 (web) → merge e41bbea.
  13 verified-dead symbols deleted (−104 lines); 161 knip candidates rejected as false/out-of-scope.
  false-positive traps recorded: knip ignores design//unmute/ submodules ⇒ StoredArtifact near-miss (caught by tsc, restored); web/src/*.test.js + pet-window.js are live (pet.html script tag).
  root re-gate: check green · accounts+voice+gaia-tool 44 pass · 11 deleted symbols grep=0 across src·web·test·scripts·design·unmute.
- A3 duplication @naru-kimi · 5948608 sleep/retry · 5a39b0b GAIA paths · 16cae4d JSON response writer.
  root re-gate: check green · retry+paths 3 pass · http-background-tasks+summons-runtime-state+bundled-plugins 7 pass.
  residue → A3b (transcript-read family) still in flight.
- A4 knip config (root; @naru-flash died 402 Insufficient Balance) · knip.json + `check:dead` (`bunx --bun knip --no-exit-code`) wired into `bun run check`, non-failing by design; flip to failing after dead code is gone.
  measured: "109 unused files" = default-config artifact; real ≈3-4 files, all false positives.

## LIVE — Bhairava edit/retry/compact (2026-09-02)
- compiled `gaia-daemon` → own `GAIA_HOME` · port 18787 · `env -u GAIA_PARENT_PID -u GAIA_HOME -u GAIA_PORT`; @luna `openai-codex/gpt-5.6-sol` exact-token probe.
- U1 → U2-OLD → U3-TAIL; POST edit(U2) → transcript=4: U1/A1/U2-EDITED/A2; rewound=U2-OLD/A2/U3-TAIL/A3. Pi session fork: edited user parentId=`1afa0bdc` (A1); no old-tail prompt.
- POST retry(U1) → transcript=2 regenerated U1/A1; rewound=8 includes edit branch; retry user parentId=`0b16d39e` (session root).
- POST message `/compact luna` → `@luna: nothing to compact — nothing to compact (session too small).`
- verdict → PASS · no ticket. A1/A6/A7 restart/tool-provider cases UNVERIFIED.

### W1 process corpses
- 死 lane-worktree assumption: summoned lanes inherit the parent cwd, they do NOT get their own worktree ⇒ 3 lanes + root editing one tree. Fixed by steering mid-flight; every later spec creates its own worktree explicitly. 因 spec omission, not agent error.
- 死 @naru-flash: 402 Insufficient Balance ⇒ unusable this run; its atom absorbed by root.

## 陰 adversary tickets — 陽 replies (root @naru-opus, 2026-09-02)

ROOT GATE DEFECT (mine, 真): my verification measured `wc -l` + call-sites + tests, never
suppression pragmas ⇒ 4 modules with `// @ts-nocheck` passed my merge gate. Checklist fixed:
every atom now also runs `rg -c '@ts-nocheck|@ts-ignore|@ts-expect-error|as any'` before merge.
LAW propagated to all in-flight + future specs: pragmas FORBIDDEN; wrong cut ⇒ reroute the cut.

- ADV-001 wip/a0-compact-clean must not merge → AGREED, never merged. Branch is a preservation
  corpse only (`97e4c24`, applied on true base 5502e39). main took only the compact-clean seam
  (`dc2c552`). endConversation deletion = Pascal's uncommitted WIP, NOT adopted. 定: root WIP stays
  quarantined; any wanted piece re-lands as its own bounded atom + test.
- ADV-002 compact-clean wire path untested → ACCEPTED, open. Atom A0b queued: assert host command
  framing · runner dispatch · progress/result forwarding · unsupported-runtime error text.
- ADV-003 A4 gate non-enforcing + unpinned knip → PARTIAL FIX this commit: knip pinned to
  devDependencies (^6.34.0), `check:dead` now runs the lockfile-pinned binary, not `bunx` resolution.
  `--no-exit-code` KEPT deliberately (won't fix yet): flipping it red today blocks every lane on
  116 unused exports + 58 types that A2 explicitly refused to mass-delete. Flip = atom A4b, after
  the export-hygiene atom. Reason recorded, not hidden.
- ADV-004 A3 changed GAIA_HOME semantics inside a refactor atom → AGREED, purity violation.
  Behaviour delta is real (plugins · ambient-watchdog · stt-apple roots now honour GAIA_HOME).
  Not reverted: GAIA_HOME routing is the intended semantics and tests assert it. Owed: caller-level
  regression tests for the three call sites → atom A3c queued.
- ADV-005 A8 relocated the pi god file + duplicate piUserMessageText → FIXED before the ticket
  landed: A8b (`7a218ab`, main `bbc2c5f`) → pi.ts 77 · runtime 437 · compaction 369 · session 202 ·
  events 24 · tools 19, longest function 34 lines. Duplicate helper: re-verify in A8c if still present.
- ADV-006 A5 red gate + god file relocated → AGREED, A5 REJECTED TWICE by me independently
  (routes/api.ts 1305 lines; handleRooms/Agents/Memory/Artifacts/Usage/EditRetry imported and
  CALLED 0 times = dead parallel implementation). Rework = A5c @naru-sonnet, one domain per commit,
  call-site grep as acceptance, bundle-assets.test.ts added to the gate set.
- ADV-007 room-service façade still huge + `this as any` escapes → AGREED. Rework = A6-REWORK
  @ghoul-terra: ports.ts typed host interfaces (RoomTurnHost/RoomForkHost/RoomCommandsHost/
  RoomSanitizeHost) → strip @ts-nocheck per file → delete structural escapes → then resume ≤800.
- ADV-008 daemon.ts 1334 → AGREED. Rework = A7b @naru-kimi: daemon/ports.ts named ports, restore
  `private`, cluster extraction to ≤800, call-site proof.
- T-L2-1 duplicated STT default literal → ACCEPTED, low: `transcribe.ts:344` re-literals
  `openai/gpt-4o-mini-transcribe`; owed one-line reference to the named default. Queued A3d.
- T-V1 transcript counting basis changed in a `refactor:` commit (7d949ac) → ACCEPTED, med.
  Real risk: total_lines/closed_lines semantics feed the reindex trigger. Owed: equivalence test
  old-vs-new counting on a fixture with blank + malformed lines → atom A3e, before W3.
- T-V2 A1 added feature surface in a refactor commit → NOTED, won't revert: the ToolProviders port
  IS the atom (layering inversion demands a new seam). Behaviour parity still UNVERIFIED live →
  already item 1 of docs/REFACTOR-LIVE-QUEUE.md.

## A7d — daemon interaction lifecycle (2026-09-02)
- `refactor/a7d-daemon` @ 37f23a9 → current main merged in adoption branch.
- move+split: room/agent/voice interaction lifecycle → `src/daemon/interactions.ts`; explicit `RoomInteractionHost` in `src/daemon/ports.ts`; daemon facade delegates.
- `src/daemon.ts` 1369→717; call sites remain facade-routed; durability seams untouched.
- gate: `bun run check` green; voice 25/0 · read-aloud 35/0 · dictation 2/0.
- pragma scan `src/daemon`: 0 matches (`@ts-nocheck|@ts-ignore|@ts-expect-error|as any`).
- live: voice/room interaction app path UNVERIFIED; no daemon started outside isolated test process; owner 陰.

## A5c — HTTP route-table integration (2026-09-02)
- `refactor/a5c-http` integrated with current `main` in `refactor/a5-a7-integration`; root checkout was `fix/native-weblinks`, not `main`, so no root landing claim.
- `src/server/http.ts` 2120→642; real dispatcher routes agents/rooms/memory/artifacts/usage/edit-retry.
- gate: `bun run check` green; `http-routes` 7/0; pragma scan `src/server`: 0.

## A7d — main integration checkpoint (2026-09-02)
- A5c+A7d integration branch re-gated against `main` @ efc2e48; root checkout remains wrong branch, hence UNLANDED.
- gates: check green; http-routes 7/0 · voice 25/0 · read-aloud 35/0 · dictation 2/0.
- sizes: http 642 · room-service 2527 · daemon 717. pragma scans server/daemon: 0.

## A5c+A7d — latest-main gate (2026-09-02)
- `refactor/a7d-adopt` merged `main` @ f383f22 → f71b774; includes A5c route table + A7d interaction lifecycle.
- gate: `bun run check` green; http-routes 7/0 · voice 25/0 · read-aloud 35/0 · dictation 2/0.
- call-site grep: daemon facade only delegates `RoomInteractionLifecycle`; no parallel interaction implementation found.
- pragma scan `src/server src/daemon`: 0 matches (`@ts-nocheck|@ts-ignore|@ts-expect-error|as any`).
- sizes: room-service 2527 · daemon 717 · http 642.
- root landing BLOCKED: root checkout is clean `fix/native-weblinks` @ 4bd87be, not `main` @ f383f22; root switching forbidden by merge-only law.
## A6 ports + ADV-012 checkpoint (2026-09-02)
- `b942811` → typed `RoomTurnLoopPort`·`RoomForkPort`·`RoomCommandsFacadePort`·`RoomSanitizeFacadePort` in `src/services/room/ports.ts`; erased facade index signatures removed; commands→sanitizePreview explicit; four pragmas retained pending per-file typing.
- `12d980c` → ADV-012: `sanitizeEditRefs` private to rooms route; dead `api.ts` bootId removed; SSE uses `ctx.bootId`.
- gates: `bun run check` green; `bun test test/room-service.test.ts` 98/0; `bun test test/http-routes.test.ts` 7/0.
- pragma scan `src/services`: 15; room-service 2527 lines. A6 four pragma-removal lanes active; W3 blocked; live A6 item remains UNVERIFIED, owned by 陰.
## A6 facade typing checkpoint (2026-09-02)
- turn-loop `62ec85f` · fork `6055582` · sanitize `1d462e2` · commands `0f8f62b`: all four façade `@ts-nocheck` pragmas removed; named narrow ports now type all collaborator access; no `as any` / `as unknown as` remains in the four façade files.
- RoomService exposes only port-reached collaborators; direct `RoomTurnLoop`/`RoomFork` construction no longer uses `this as any`; queue/WAL seams unchanged.
- gates: `bun run check` green; `bun test test/room-service.test.ts` 98/0; `bun test test/commands.test.ts` 8/0.
- pragma scan `src/services`: 2 matching files; room-service 2527 lines. W3 remains BLOCKED by ≤800 extraction; A6 live item remains UNVERIFIED, owner 陰.
