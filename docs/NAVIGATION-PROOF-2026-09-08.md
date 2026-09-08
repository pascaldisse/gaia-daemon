# Navigation / rendering · 2026-09-08

§ Cause
09-05 navigation branch never landed → main 9d6563d still network-blocked; stale responses overwrite latest clicks; SSE corrective selection writes.
Closed activity bodies → eager markdown/JSON/diff DOM construction, repeated on room switches and stream updates.

§ Change
Prior navigation branch integrated into current main → latest-intent abort/deadline + bounded session cache + read-only resync + pager ownership + ordered server mutations/parallel snapshot facets.
Merge → Cmd/Ctrl/middle-click tab behavior retained; sidebar click-time selection check centralized.
ActivityDetails → deferred body factories for tool/thinking/GAIA-think/skill/summon; restored-open bodies synchronous; same-node reopen preserves body/scroll.
HTTP memory fixture → embeddings/reranker off; endpoint assertions unchanged; no external 334MB download prerequisite.

§ Real compiled app
Owned daemon :54259; single app-tools headless browser CDP :54344. Two isolated workspaces; copied transcripts/attachments, no model turns. Live :9333 → passive info/console only; no reload/input.
Baseline 9d6563d → 700ms delayed earlier response: client A / server B after final B click. Fixed → B/B.
Heavy copied transcript 6.6MB → DOM descendants 21,481 → 1,503; diagnostic main-thread longest task 95 → 50ms. Diagnostic run narrow/hidden sidebar after overlay dismissal → rendering/race evidence only, not visible-click acceptance.
Final visible desktop 1440×900 → sidebar opened through brand control; every row checked visible before pointer dispatch. Cached room paints 34–80ms; workspace paints 33–35ms; state adoption synchronous. 700ms delayed response, injected503 rollback/reconnect, rapid cross-workspace chain, transcript IDs versus room-scoped HTTP GET → PASS.
Expansion → initially zero closed bodies; tool/native-thinking reveal PASS; same-body reopen PASS; room away/back open-state/body restoration PASS.
Console capture → Runtime exceptions0 / console errors0 / new browser errors0. Earlier copied-room attachment404 preserved; source attachment copied before final run. app-console /console unavailable on Chromium → direct CDP Runtime/Log monitoring. app-nav argument bug → owned-origin navigation through app-eval; user window untouched.
Screenshot desktop-visible.png visually reviewed; private transcripts/scripts/logs/screenshots → worktree .gaia/navigation-proof/. Sanitized metrics → [navigation-proof/2026-09-08.json](navigation-proof/2026-09-08.json).

§ Gates
bun run check → PASS, existing knip advisories.
bun test --preserve-symlinks test/web-navigation.test.ts → 17PASS.
Individual bun test → ordered-blocks4 / select-room-race1 / room-membership-security6 / http-routes9 / http-user-workspaces1 / web-tabs3 PASS.
room-service → 107PASS / 1FAIL stalled-turn requeue timeout. Same isolated test on untouched main9d6563d → timeout5s. Broader suite NOT green; unrelated failure not suppressed.
Initial ordered-blocks shim → missing fragment flatten/remove/replaceChildren; corrected, product assertions retained. HTTP repeat → external model-download timeout; fixture isolated above.
Independent ghoul-opus review → no blocking correctness/security findings.

§ Boundary
Fresh uncached rooms still require server response; largest diagnostic first visit132ms, not universally instant. Cached heavy rendering still measurable; open massive payloads/global daemon load not eliminated.
User WKWebView/live deployment → UNVERIFIED until user /rebuild; no restart authorization assumed.
