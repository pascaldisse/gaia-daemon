# Auto TTS — single-stream recon

§ Base
- Worktree → ~/projects/gaia-daemon-wt/auto-tts; branch → lane/auto-tts.
- Trunk → main c5b25c3; `git rebase main` → already current.
- Main dirty → unrelated edits; untouched. Running daemon/voice helper → untouched.

§ Divergences
- Trigger/ownership → manual `web/src/readaloud.js:351` toggle → browser `startReadAloud`; auto `src/daemon.ts:358` broadcast → `src/daemon/interactions.ts:37` → daemon-wide `AutoTtsQueue`; browser-independent, all rooms.
- Event lookup → manual `RoomInteractionLifecycle.readAloudStream` → `eventById(eventId, { display: true })`; auto → broadcast event captured at enqueue; no event re-read.
- Text → manual `readAloudStream` → `speakableText` once; auto queue → `speakableText` → replacement event → `readAloud` → `speakableText` again. Formatter not guaranteed idempotent.
- Request → manual POST `/api/workspaces/:workspace/rooms/:room/read-aloud/stream`, body `{eventId}`; auto direct batch `readAloud({...request, event: {author,text}, chunk})`; no manual HTTP route.
- Chunking → manual streaming engine: whole prepared text once; auto batch splitter: 120/200/300-character ramp, then 400-character chunks; synthesis/playback repeated per chunk.
- Voice endpoint → manual Claude POST `/stream`; auto Claude POST `/synthesize`; `/speak` unused by BOTH paths.
- Cache/archive → manual whole-text identity, engine `claude:stream`, PCM; auto per-chunk identity, engine `claude`, WAV.
- Health → manual engine selection/readiness/bootstrap/retry path; auto additional Claude-specific `health.ok && health.ready` guard before EVERY chunk, even non-Claude engines; unhealthy → skip rather than manual recovery.
- Playback → manual progressive PCM → one browser `AudioTransport`, Web Audio timeline/player/pause/seek/device migration; auto complete WAV → temp file → platform player (`GAIA_AUTO_TTS_PLAYER` / afplay / aplay), one process per chunk; no browser controls, no progressive playback.
- Errors/cancellation → manual visible UI error + fetch/transport teardown; auto daemon log + next queue item, disposal aborts platform player only; setting-off checks between chunks.
- Scheduling → manual one active message per browser tab; next manual play replaces previous; auto daemon-wide FIFO waits for playback completion across rooms.
- Fallback → manual batch-only engines intentionally use chunk endpoint; unconditional one-synthesis law vs exact manual fallback → additional scope ambiguity outside Claude/stream-capable engines.

§ Limits / contract
- `src/services/read-aloud.ts:26-29,659-697` → no whole-message cap; stream receives full `speakableText` result.
- ~/projects/claude-voice/voiced.js:205-244 → `/stream`, `/synthesize`, `/speak`: stringify/trim + empty-text rejection; no text-length maximum.
- Helper `startTTS` :60-72 → one socket/session; timeout scales with text length/config; `lib/tts.js:99` appChunks → text frames inside SAME socket, not separate synthesis/playback. Leave helper protocol untouched.
- `/speak` → local playback; NOT manual endpoint; substituting it would violate requested path identity.
- No proposed invented limit; no limit/config changes.

§ Decision boundary
- Strict same request AND playback → browser `startReadAloud` + `AudioTransport` reuse; replacing afplay required.
- Browser migration → loses current no-window playback unless additional playback ownership/lifecycle designed; current room-event SSE scoped by selected workspace/room (`src/server/http.ts:698-728`); naive client hook loses background rooms, risks duplicate playback across clients.
- Keeping daemon FIFO + using readAloudStream + collecting PCM into WAV/afplay → synthesis corrected, playback still divergent; NOT exact compliance.
- Required clarification before risky ownership change → browser-owned auto playback acceptable, or daemon-host playback mandatory?
- Live → UNVERIFIED-LIVE; no restart/audio test.
