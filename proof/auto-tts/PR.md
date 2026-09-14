# Auto TTS

§ Recon — base ccf1b9e
- Manual trigger → web/src/readaloud.js:351 `toggleReadAloud(eventId)` → :410 `startReadAloud` → existing `/read-aloud/stream` + chunk routes.
- Daemon adapter → src/daemon/interactions.ts:492 `readAloud(workspaceId, roomId, eventId, chunk=0, regenerate=false, overrides={})`; display-capped event + author voice + voice settings → src/services/read-aloud.ts:566 `readAloud(request)` → audio result, NOT playback.
- Text/limits → src/services/read-aloud.ts:29 `speakableText`; :86 `splitSpeechChunks`; 120/200/300 ramp, 400-char chunks; no whole-message cap. Display cap → src/services/room/turn-results.ts:80-92.
- Claude transport → src/services/read-aloud.ts:801 health probe; :916 synthesis; existing `settings.claudeVoiceUrl`; no additional TTS transport.
- Commit → src/services/room/turn-results.ts:58 `commitReply` → :90 `room.commitTurn` → committed `room-event` emit. Daemon broadcast → src/daemon.ts:358. Explicit end-conversation → src/services/room-service.ts:516.
- Settings discrepancy → requested app-settings.json/general schema absent at base. Actual path → src/core/paths.ts:29 `globalPaths.appSettings()` → app.json; keep-awake read/merge/write → src/services/keep-awake.ts:44-54; no readBeforeWrite references.
- UI pattern → web/src/settings.js:242 GeneralTab; :258-271 keep-awake checkbox; web/src/actions.js:878 persistence; src/server/routes/api.ts:105 route; src/daemon.ts:702 app payload.

§ Plan
- Existing app store retained; typed `general.autoTts`, missing/invalid → false; unknown fields preserved. No alternate settings path.
- Existing synthesis + formatter + chunk limits retained; local audio sink needed because existing function returns bytes only. Configurable player executable; default platform player; sequential queue spans synthesis AND playback, all rooms, independent of browser windows.
- Commit broadcast filter → agent/nonempty/no special kind; settings + health guards; failures logged outside reply path.
- Live proof → UNVERIFIED-LIVE; no daemon restart, no real speech during tests.

§ Implementation
- Schema/default/migration → src/services/app-settings.ts:4-26; lazy normalization, default false; existing app.json + unknown nested keys preserved.
- Toggle → web/src/settings.js:272-284; action → web/src/actions.js:877; API → src/server/routes/api.ts:105; daemon setting/payload → src/daemon.ts:484,709,742.
- Hook → src/daemon.ts:358-362 → src/daemon/interactions.ts:37-55 → src/services/auto-tts.ts:54-84. Existing committed room-event transport; no browser replay subscription, no alternate TTS request protocol.
- Selection → registered author + existing agent/workspace TTS defaults; emitted display-capped text → existing speakableText → existing readAloud chunking/cache/archive.
- Health → src/services/read-aloud.ts:802; existing configured claudeVoiceUrl; require health ok + ready before each chunk; unhealthy → skip/log.
- Playback → src/services/auto-tts.ts:22-42; daemon host speakers; GAIA_AUTO_TTS_PLAYER executable override, default afplay (macOS) / aplay (elsewhere); tempRoot default tmpdir(); no shell interpolation. FIFO spans playback completion across all rooms. Browser manual player unchanged.
- Off → queued work skipped; active chunk finishes. Dispose → playback abort + pending queue skipped. Failures → logged, queue continues, commit path never awaits speech.

§ Verification
- Environment → own lane/auto-tts worktree; node_modules symlink to existing dependencies; pinned design submodule bf41ca3 initialized. Main worktree/running app untouched.
- Initial check → check-initial.txt; uninitialized design submodule only; resolved before final verification.
- `bun run check` → exit 0; raw check.txt. Baseline ccf1b9e archive → same command, exit 0; raw check-baseline.txt. Knip advisories identical except shifted source line numbers; zero new findings.
- `GAIA_HOME="$test_home" bun test test/app-settings.test.ts test/auto-tts.test.ts test/read-aloud.test.ts test/readaloud-http.test.ts test/readaloud-cache.test.ts` → exit 0; 59 pass / 0 fail; raw tests.txt. test_home → mktemp -d, removed afterward.
- Tests → schema defaults + roundtrip/preservation; off/on stripped text; cross-room sequential playback; nonfinal/system/tool/compaction filtering; health status; synthesis/playback/logging failures; chunk sequence; toggle-off/dispose; existing read-aloud/cache/HTTP regressions.
- HTTP regression → isolated headless test daemon, random port/temp home, fixture audio; NOT running app, NOT audible/live proof.
- UNVERIFIED-LIVE → app restart + audible final-reply proof reserved for you; no restart attempted.

§ Merge
- Branch → lane/auto-tts; base → ccf1b9e.
- Commits → 3792716 recon; a35f87a settings; b614e71 hook/tests; verification commit → git log.
- Command → `git -C "$HOME/projects/gaia-daemon" merge --ff-only lane/auto-tts`
- Dirty main → unrelated edits retained; merge conflict/refusal → stop, no reset/stash/force.
