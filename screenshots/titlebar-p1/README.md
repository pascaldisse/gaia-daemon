# Titlebar P1 · 2026-09-05

## Root cause
- `16d90b8` → `src-tauri/src/lib.rs`: traffic-light y 19→9; `web/src/styles.css`: native bar 38→30px.
- `a304ef9` → `styles.css`: tabbar column 2; sidebar-width displacement; side panes/resizers consume native drag lane.
- Installed `/Applications/gaia-daemon.app/Contents/MacOS/web/src/{native.js,styles.css}` ↔ main@8558160 → byte-identical before edits; missing flag/inset hypothesis rejected.
- `tabsbar.js` deep/false markers → local Cargo-registry patch dependency; installed shell contains patch. Direct-target markers → stock + patched Tauri compatibility; portability hardening, not missing installed flag.

## Fix
- `styles.css:161–181` → native bar spans all columns; 38px height parameter; side panes/resizers start below.
- `lib.rs:50–62` → shared main/spawned-window coordinates; `GAIA_TITLEBAR_TRAFFIC_LIGHT_X/Y` defaults 12/21.
- Wry y ≠ button centre; PNG first pass y=19 → centre y=17pt; corrected y=21 → centre y=19pt, 12pt top padding, 14pt controls.
- `native.js` → inset option default 76px; OS/DOM fullscreen → 0px.
- `tabsbar.js:54–63` → direct-target markers on bar furniture + brand descendants; tabs/buttons unmarked.

## Pixel proof
- App → `tmp/titlebar-proof/GAIA-titlebar-proof.app`; final shell build from f888ee8; no coordinate environment overrides.
- Separate compiled daemon → HTTP :51064; shell debug :51065; isolated `GAIA_HOME` + workspace under `tmp/titlebar-proof/`.
- Capture → `GET /screenshot/window`; CoreGraphics own-window capture; includes native controls; WKWebView-only snapshot insufficient.
- `titlebar-1828.png` → actual native window, 914pt wide at 2×; 1828×186 top crop; matches supplied image width. PNG read/visually inspected.
- SEE → red/yellow/green controls centred at ~38 raster px in 76px bar; visible ~24px top padding; wordmark immediately right; tabs + empty strip continuous across window.
- DOM → `#tabbar[data-tauri-drag-region=""]`; bounds `(0,0,914,38)`; brand x=76; computed `--titlebar-inset: 76px`.
- `drag-routing.json` → real injected Tauri handler; IPC intercepted at transport, no OS drag invoked. Bar/brand descendants/strip/spacer → start_dragging; tabs/tab names/new/close/theme buttons → none.
- `fullscreen.json` → actual `setFullscreen(true)` + `isFullscreen()`; inset 0px; return → 76px.
- Controls → new-tab button creates room; pointer tab selection changes active room; theme button opens palette.

## Gates
- `bun test test/titlebar.test.ts test/web-tabs.test.ts` → 8 pass, 0 fail.
- Frontend `tsc -p web/tsconfig.json` → pass during initial gate; later repeat timed out under host load.
- `bun run check` + completion retry `bun --bun run check` → exit 2; nine missing Bun/bun-types diagnostics in plugins/loader.ts + web-fetch.ts. Baseline → `docs/RELEASE-0904.md` § Gate record.
- `bun scripts/build-daemon.mjs` → pass.
- `bun scripts/gaia-engine.mjs build` → final release pass, 8m17s.

## UNVERIFIED
- Physical pointer-driven window movement → Accessibility unavailable; routing proof ≠ physical drag proof.
- Full repository green check → blocked by § Gates baseline diagnostics.
- Installed-app behavior after deployment → no deployment; no restart/kill/install actions against `/Applications/gaia-daemon.app`.
