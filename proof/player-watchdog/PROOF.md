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
