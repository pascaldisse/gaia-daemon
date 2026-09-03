# Pass 5 W3 live verifier · 2026-09-03

- branch → adversary/pass5-live-terra; source → a995bb09614da244170ce637607adc8ecf3e5c26.
- workspace → /Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/ghoul-terra-mtkrd610i7uwmq; run → /Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/ghoul-terra-mtkrd610i7uwmq/.gaia/live-test-runs/pass5-20260903020111.
- port → 18787 precheck empty → evidence/lsof-before.txt.
- dog control → `bun test test/dog-mode-integration.test.ts` → `8 pass · 0 fail` → evidence/dog-regression.log.

## BLOCKER · P1 · LIVE-P5-001 · compiled build cannot start from exact baseline

- repro → initialized pinned `design`/`unmute` submodules: design `bf41ca3f35e3741d3ae757872f0ccd596cfd8f1a`; then `bun run build --out .gaia/live-test-runs/pass5-20260903020111/dist`.
- expected → compiled daemon output; required live items 1–5 runnable.
- actual → rc 1: `src/services/artifacts.ts` exports `../../design/src/artifacts.js` + `artifact-revisions.js`; pinned design contains only `design/src/artifacts.ts` + `artifact-revisions.ts`; Bun resolve errors for both `.js` paths.
- evidence → /Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/ghoul-terra-mtkrd610i7uwmq/.gaia/live-test-runs/pass5-20260903020111/evidence/build.log; submodule → `git -C design status --short --branch` = detached `bf41ca3`.
- verdict → 1–5 UNVERIFIED; daemon never started; no source/submodule workaround attempted; no fix.
