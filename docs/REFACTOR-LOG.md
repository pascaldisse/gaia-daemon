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

### W1 process corpses
- 死 lane-worktree assumption: summoned lanes inherit the parent cwd, they do NOT get their own worktree ⇒ 3 lanes + root editing one tree. Fixed by steering mid-flight; every later spec creates its own worktree explicitly. 因 spec omission, not agent error.
- 死 @naru-flash: 402 Insufficient Balance ⇒ unusable this run; its atom absorbed by root.
