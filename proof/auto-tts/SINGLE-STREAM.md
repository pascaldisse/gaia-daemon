# Auto TTS — single-stream

§ Current decision — supersedes § Decision boundary / baseline blocker
- User → browser-owned playback authorized; selected room only; hidden/unfocused eligible; no headless audio.
- One owner → Web Locks `gaia-auto-tts`, ifAvailable; held through playback/idle until pagehide/unload. Without Locks → localStorage lease + heartbeat + arbitration; ownership loss → stop auto transport.
- localStorage caveat → no atomic compare-and-set; fallback exclusion best-effort under suspended tabs/adversarial timing; Web Locks strict arbitration.
- No substitute transport → same `startReadAloud`, POST `/read-aloud/stream`, event-ID resolution, `speakableText` once, streaming cache, `AudioTransport`.
- Manual priority → owning tab's shared player: loading/playing/paused manual request blocks auto; manual takeover cancels active auto; queued replies skipped while manual busy. Independent manual playback in other tabs → existing behavior unchanged; no global manual-player arbitration requested/added.
- Settings → daemon-authoritative `app-settings` event to all tabs; reconnect `/api/app` refresh guarded against newer events; no client-side preference store.
- Navigation → active auto stopped on room change; active manual preserved.
- Web Locks API error/denial → fail closed; no fallback after lock contention/rejection (avoids separate lease owner competing with a valid Web Lock owner). Missing Locks API → lease fallback.
- FIFO → actual AudioTransport completion, NOT HTTP EOF; stop/error/disposal settle current item; next reply rechecks setting/room/ownership/manual priority.
- Committed room-event only; duplicate event IDs suppressed; no snapshot/history replay; background arrivals log skip; server selected-room scope unchanged.
- Removed → src/services/auto-tts.ts; daemon broadcast hook; RoomInteractionLifecycle auto queue/disposal; afplay/aplay/temp WAV auto sink/config override. Daemon retains preference/API only.
- Existing manual batch-only fallback retained unchanged; Claude/stream engines → one full synthesis + one playback per reply; no new text cap.
- Tests → web/src/auto-tts.test.js + auto-tts-owner.test.js; shared-player integration → test/readaloud-auto.test.ts, alongside existing test/readaloud-transport.test.ts; daemon removal/full-stream regression → test/auto-tts.test.ts.
- Integration fixture location → test/ avoids importing Node service TS into DOM web tsc program. Initial web placement → RequestInit diagnostic; relocated, no production type workaround.
- Live → UNVERIFIED-LIVE; browser autoplay policy/output routing require your app restart + listening; running daemon untouched.

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

§ Baseline verification — NOT fix proof
- `bun run check` → exit 0; raw → single-stream/check.txt; existing Knip advisories retained.
- `bun test test/auto-tts.test.ts` → exit 0; 14 pass / 0 fail / 36 expectations; raw → single-stream/tests.txt.
- At baseline only → source/tests unchanged; existing chunk-sequence regression still passed. Superseded by § Current decision.
- Historical verdict → BLOCKED-PLAYBACK-OWNERSHIP; resolved by § Current decision.
- Merge (recon/proof only, NOT a fix) → `git -C "$HOME/projects/gaia-daemon" merge --ff-only lane/auto-tts`; dirty main refusal → stop, no force/reset/stash.

§ Final verification
- `bun run check` → exit 0; raw → single-stream/check-browser.txt. Knip advisory-only; new web tests match existing unconfigured-web-test warnings; no new runtime dead-code finding.
- `bun test test/auto-tts.test.ts` → exit 0; 4 pass / 0 fail / 13 expectations; raw → single-stream/tests-daemon-final.txt.
- `bun test web/src/auto-tts.test.js web/src/auto-tts-owner.test.js test/readaloud-auto.test.ts test/readaloud-transport.test.ts test/app-settings.test.ts test/read-aloud.test.ts test/readaloud-cache.test.ts` → exit 0; 76 pass / 0 fail / 173 expectations; raw → single-stream/tests-browser-final.txt.
- Full raw command outputs → room tool results; committed files above.
- Total → 80 pass; test doubles/temp directories; no live daemon endpoint, real synthesis, listening, restart, or build/deploy.
- Health helper → private again; internal manual readiness behavior retained.
- Branch → lane/auto-tts; main c5b25c3 ancestor; worktree clean after final commit.
- Merge → `git -C "$HOME/projects/gaia-daemon" merge --ff-only lane/auto-tts`; unrelated dirty-main refusal → stop, no reset/stash/force.
- Verdict → AUTO-TTS-SINGLE-STREAM-READY-UNVERIFIED-LIVE.
