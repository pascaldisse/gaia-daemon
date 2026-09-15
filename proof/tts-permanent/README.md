# Auto-TTS permanent fix · 2026-09-15

§ Scope
- Branch → `lane/tts-permanent`; implementation → `3c11aa1f043d500927327ec049392c1fb603c095`; unchanged capture commit → `28381f6`.
- Reviewed five commits → `774b4f5`, `07833a8`, `a18b9ff`, `13de67d`, `3c11aa1`; continuation → documentation/proof only, no implementation redo.

§ Root cause · reproduced mechanism, not original native incident
Browser-owned AudioContext suspension/autoplay blocking left buffered speech at clock zero behind a false playing indicator, without gesture recovery and unlocked-context preservation → `baseline-autoplay.json`.

§ Policy / configuration
- `TTS_MAX_AGE_S` → positive finite seconds; default **60**; configurable, not a fixed expiry threshold.
- Precedence → daemon environment `TTS_MAX_AGE_S` > `~/.gaia/app.json` → `general.TTS_MAX_AGE_S` > queue default; environment override exposed through `/api/app`, never persisted by auto-TTS toggle.
- Wiring → `src/services/app-settings.ts` → `state.general` → `initializeAutoReadAloud()` → `AutoTtsQueue`; parameter captured at queue initialization → reload client after changing policy.
- Age → event creation timestamp, not delivery time; checks at arrival, after async ownership, and recovery; expired/malformed/future timestamps → discard. Continuous uninterrupted speech → not a 60-second duration cutoff.
- Default `general.ttsPolicy` → `replace`, NOT append/FIFO: newer eligible reply → retire old fetch + scheduled sources, settle old playback, retain usable unlocked context, start replacement; pending ownership burst → latest generation only.
- Explicit `enqueue` compatibility → opt-in only; recovery still flushes predecessors; newest fresh reply only, otherwise silence.
- Recovery → unschedule interrupted PCM; resume same context; schedule only when running; freshness gate before recovery; device migration / running-clock stall → guarded rebind; close timeout parameter `contextCloseTimeoutMs`, default 3000 ms.
- Stall policy → `general.ttsStallSeconds`, default 3 seconds; transport watchdog parameter `watchdogMs`, default 500 ms.

§ PROVEN · existing app-tools captures
- Surface → isolated compiled GAIA app, headless Brave/Chromium, real Web Audio; copied reply fixtures persisted in isolated workspace; enqueue seam, NOT live SSE delivery.
- Candidate identity → `build-identity.json`: manifest commit `3c11aa1`; served/source readaloud SHA256 equal `83cc07b7ac861eeac60224494cebd4c761a2357a14d69cf9842187d7c8ce35b7`; build manifest `dirty:true` retained, not relabeled clean.
- Browser playback completion → `fixed-autoplay.json`: progressing context; hidden-tab completion `0:21/0:21`.
- Replacement + actual context suspension → `final-replacement-suspend.json`: first reply `0:02/0:21` → replacement `0:01/0:19`; one context; suspended→running in 28 ms; replacement continues.
- 90-second hidden-tab wait → `stale-90s.json`: old contexts' clock remains zero; newest fixture created at +75 s; return +90 s + browser-owned gesture → newest only, `ended` at `0:21/0:21`. NOT gesture-free autoplay proof.
- Expired arrival → `final-stale-drop-ended.json`: age 1891.964 s; synthesis requests unchanged 5→5; replacement `ended`.
- Capture naming caveat → `final-replacement-ended.json` actually records phase `playing` at rounded `0:19/0:19`; ended proof → preceding bullet, not filename.
- Earlier captures → `replacement-before.json`, `replacement-after.json`, `replacement.json`; historical closed contexts retained; no claim that every historical run created only one context.

§ PROVEN · fresh continuation checks
- No replay / new fixture / room post; existing isolated browser :62747, daemon :58928 retained.
- `app-eval.js --port 62747` → `continuation-app-state.json`: same replacement event, `ended`, `0:19/0:19`, one running context; prior suspend/resume events intact.
- `app-screenshot.js --port 62747` → `continuation-app.png`: ended player inspected.
- Existing CDP console/network capture → `continuation-console-summary.json`: 85 records, zero captured errors/exceptions, five HTTP 200 TTS responses; stale-drop log names `TTS_MAX_AGE_S=60`. Capture-window evidence only, not an all-session error guarantee.
- `bun run check` → exit 0; `check.log`; TypeScript gates pass; knip advisory findings present (`--no-exit-code`), NOT a clean dead-code audit.
- `bun test test/app-settings.test.ts` → 3 pass / 0 fail / 19 assertions.
- `bun test test/readaloud-auto.test.ts` → 9 pass / 0 fail / 40 assertions.
- `bun test test/readaloud-transport.test.ts` → 19 pass / 0 fail / 72 assertions.
- `bun test ./web/src/auto-tts.test.js` → 13 pass / 0 fail / 27 assertions.
- Unique source tests → **44 pass / 0 fail / 158 assertions**; `tests.log`, `queue-source-test.log`. Initial unprefixed web path also matched `dist/web/src/auto-tts.test.js`; both passed, then exact `./` source-only rerun; no double-counting.
- Test temporary files → worktree `.gaia/tts-permanent-test-temp` via `TMPDIR`; no `/tmp` writes.

§ UNVERIFIED
- Original native WKWebView 0:04 stall → not reproduced; native passive reconnaissance only → `STATUS.md`.
- Actual No Man's Sky / OS alt-tab, CoreAudio device takeover, audible speaker output, physical device unplug/replug → not exercised.
- Corrected end-to-end real agent SSE → auto playback, multi-tab ownership under real background throttling, all-stale hidden-tab recovery in actual browser → not demonstrated by these captures; all-stale queue semantics unit-tested only.
- Production installation/rebuild, live environment/config override, native-client reload → pending; no permanent-fix/full-live acceptance claim.

§ Pascal-only deployment / EXACT restart instruction
- Observed production daemon → PID 5589, `/Applications/gaia-daemon.app/Contents/MacOS/gaia-daemon`; parent shell PID 5583. PID observations only; never use stale PID kill commands.
- Installed manifest → commit `1ecc58d6493200bd17d13cf65c74b98b2aff6c8b`, root/buildRoot `/Users/pascaldisse/projects/gaia-daemon`; candidate NOT installed.
- Shared main → same commit; unrelated uncommitted changes present. Integration BLOCKED pending preservation/reconciliation by owning lanes; no main edits/merge in this continuation.
- Prerequisite → safely integrate `lane/tts-permanent` into canonical main under root merge-only rules; source containment check:
  ```sh
  git -C /Users/pascaldisse/projects/gaia-daemon merge-base --is-ancestor 3c11aa1f043d500927327ec049392c1fb603c095 HEAD
  ```
- Only after integration/check success → in a non-main GAIA room connected to the **installed production daemon**, submit exactly:
  ```text
  /rebuild
  ```
- Target → installed daemon above; rebuild from canonical main + re-exec. Bare restart / current pre-integration `/rebuild` → NOT deployment of this lane.
- After daemon reconnect → **Cmd-R in the GAIA client/tab using Auto-TTS**, loading fresh snapshotted JS; browser autoplay permission may still require a deliberate click.
- No Brave process restart; no claude-voice restart; no shell kill / `bun run restart`; no commands executed by this continuation. Production PIDs retained; isolated proof services retained.
