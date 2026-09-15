# Player watchdog · latest request-isolation acceptance

§ LATEST → `2f19aec` compiled candidate; `ec8241e` request ownership/retirement + `a171e3a` mandatory frame/EOF IDs + `2f19aec` diagnostic layout.
`bun run check` EXIT0; final separate tests transport28/cache7/HTTP1/call5/voice25 = 66PASS/0FAIL; legacy bridge baseline unchanged4TIMEOUT (§prior).
Identity → `recheck/final-candidate-identity.log`; served/source/snapshot hashes identical.
Fresh final A→native clock freeze→actual B button→old context resume: A nodes stopped+disconnected+buffer=null; A segments/total/sources0; stale-ID + untagged frames rejected; B663534 samples, only current-request sources. Real AudioTransport; no replacement implementation.
B freeze→timer rebuild1→nonzero analysed speech; freeze replacements→two consecutive failures→terminal status/progress stationary over2s. Cumulative rebuilds3 includes earlier healthy rebuild; not three consecutive failures.
Final screenshot `recheck/final-terminal.png` visually inspected; error state readable; full request ID in diagnostic title, not layout.
`bun proof/player-watchdog/recheck/verify-request-evidence.mjs` → PASS over captured browser evidence.
Final browser physical output muted AFTER analyser → no further test speech in Pascal's game; digital native playback verified, physical speaker/NMS root cause UNVERIFIED.
Voice-call live recovery → prior `d25cfe9` (§prior); final voice-call unit tests PASS, shared module unchanged except transport admission/retirement.

§ Stale-audio audit
Before patch: `_stopSources` called stop only; no disconnect/buffer release. Destroy retained segments. Frames implicitly belonged to transport; outer fetch/abort guards already existed. These ownership/retirement gaps now closed; no proof they caused Pascal's live incident.
Client replay cache: NONE — no IndexedDB/blob/in-memory message cache in current read-aloud path; only current transport segments. Stale flatten() cache comment corrected.
Server cache: SHA256(speakable text)+engine+voice+model; metadata full identity checked; text changes miss. No cross-message key collision found; cache tests cover changed text/voice/model.
Backend account identity absent from cache key → same named voice/text/model may reuse a prior render after account switch. Account-switch invalidation NOT implemented; no backend identity source established in this task.
Confirmed old galaxies audio → lane-private `home/cache/tts/078392b6…audio`, rendered17:30:37CEST; hash matches `Third call reply. Galaxies…` exactly. `recheck/cache-audit.json` metadata/mtime/text joins.
Audible lane tests18:48–18:50 are a confound for Pascal's report; no claim of proving stale main-player nodes or pre17:00 synthesis. Later tests muted.

§ PRIOR WATCHDOG ACCEPTANCE → below; original task before stale-audio amendment

# Player watchdog · 2026-09-15

§ Candidate
Base `6b5de4c` → recovered prior lane; five ordered picks:
`58122b2→f1df376`, `f9ba109→baba0ab`, `f282a7f→dbc0821`, `00d45ff→544dfbc`, `8e3c282→f430d15`.
Manual-only conflict cleanup `d25cfe9`; auto-TTS restoration NONE; voice-call code unchanged.
Compiled candidate `d25cfe9` → private daemon 54102/PID14228; isolated app-tools browser 54116/PID13353.
Served/source/snapshot SHA256 identical → `recheck/candidate-identity.log`.

§ Fresh gates → recheck/
`bun run check` EXIT0; knip advisory output retained.
Separate `bun test` files: transport27 + cache7 + HTTP1 + call5 + voice25 = 65PASS/0FAIL.
Legacy bridges: STT2PASS/1TIMEOUT; TTS6PASS/3TIMEOUT.
Unmodified main baseline → SAME8PASS/4TIMEOUT; not repaired/not waived as green.

§ Compiled browser acceptance
Actual manual reply button → real daemon route → claude-voice PCM → production AudioTransport.
Fault seam → native AudioContext subclass; frozen exposed clock + native suspension; no transport replacement/direct watchdog invocation.
Healthy peak0.243225 → freeze0.954667s → timer rebuild1 → position1.482688s/peak0.003021; later normal completion.
Continuous replacement freeze → configurable default budget2 → terminal `audio dead — click ⟳`; theme danger rgb(224,95,157), `.audio-dead`; screenshot `recheck/terminal.png` visually inspected.
Frozen pair500ms → position0.656s/bar1.5% unchanged; terminal pair2000ms → same position/bar, sources0, peak0, rebuilds2.
Explicit private call + real new assistant reply → SAME transport; freeze15.850688s → rebuild1/position16.789354s/peak0.261505.
Call microphone = silent MediaStream seam; microphone/STT acceptance NOT claimed. Call ended.
Browser errors0 → `recheck/browser-console.json`; app-console `/console` unavailable on Chromium → captured console via browser seam; app-info `/info` likewise unsupported, CDP/app-eval/screenshot operational.
`bun proof/player-watchdog/recheck/verify-evidence.mjs` → assertions PASS over captured live artifacts; not a substitute transport test.
Physical loudspeaker/NMS fullscreen recurrence/native WKWebView → UNVERIFIED; digital PCM + injected frozen-clock failure verified.

§ Evidence layout
`recheck/` = fresh relaunch evidence; sibling files = retained prior-lane evidence, not fresh acceptance.
Live daemon/Brave/claude-voice/NMS untouched; no main-room posts; isolated room `player-proof` only.
Deployment → Pascal: `/rebuild` in a non-main room, then Cmd-R.
