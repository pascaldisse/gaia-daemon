# Bare-domain links · 2026-09-08

§ Cause
- Prior server-only patch ecb66ef → NOT ancestor of main acd906d.
- UI web recognition → HTTP(S)/www only; server bare target → workspace-relative file.

§ Fix
- `web/shared/web-target.js` → one URL classifier/normalizer; UI + server consumers.
- Bare hostname → HTTPS; port/path/query/fragment preserved by transcript tokenizer.
- Common file suffixes + explicit local prefixes → local; ambiguous domain/file → `https://` / `./` disambiguation.
- Cmd/Ctrl mousedown + following click → one open; web plain-click retained; local plain-click inert.
- Email suffix → no new browser link.

§ Gates
- `bun run check` → exit 0; existing non-gating knip findings retained.
- `bun test web/src/links.test.js` → 7 pass / 0 fail.
- `bun test test/open-target-web.test.ts` → 2 pass / 0 fail.
- `bun test test/http-routes.test.ts` → 9 pass / 0 fail.
- `bun scripts/build-daemon.mjs --out .gaia/notes/link-fix/bundle` → exit 0.

§ Live · owned compiled daemon :61838 / app-tools headless :61924
- Real composer submission → persisted user message; actual rendered tokens inspected.
- Agent reply attempted by composer → unrelated provider 402 Insufficient Balance; no reply claim.
- CDP trusted Command-mouse press/release on rendered `kaufland.de` → exactly ONE new page `https://www.kaufland.de/`; chat URL unchanged.
- Final-build CDP Runtime/Log capture → no events/exceptions.
- Compiled `POST /api/open-target {"target":"kaufland.de"}` → `{"target":"https://kaufland.de"}`; real macOS opener dispatched, not stubbed.
- app-eval + app-screenshot exercised; screenshot inspected. app-console incompatible with headless CDP `/console` → Runtime/Log used instead.
- Failed probes retained in room transcript: untrusted synthetic event → popup blocked; final-build background-tab rAF → blank DOM until owned popup closed; trusted final rerun PASS.
- Raw evidence → room worktree `.gaia/notes/link-fix/{live-click-final.json,native-open.json,chat.png,*tests.log,check.log,build.log}`.

§ Deployment
- User app :9333 untouched; no user-app reload/restart.
- Running native WKWebView on updated bundle → UNVERIFIED until user `/rebuild`.
