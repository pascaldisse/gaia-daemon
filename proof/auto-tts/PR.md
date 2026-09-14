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
