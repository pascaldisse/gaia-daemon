# GAIA shell — dev tooling

Support tools for the Tauri shell effort. None of these touch the running gaia
daemon or the web app; they attach to whatever is serving `:8787`, exactly like
a browser would.

## `cdp/` — Playwright / CDP harness (Phase 4.1) ✅ proven
Drives a real Chromium (installed Chrome/Brave, or Playwright's bundled build)
over the Chrome DevTools Protocol against `http://127.0.0.1:8787/`: waits for the
`#app` to populate, asserts the title, and screenshots to `out/`. This is the
zero-embedding debugging path — full Chromium/CDP without shipping Chromium.

```bash
cd tools/cdp && npm i && npx playwright install chromium && node index.mjs
```
Verified end-to-end: launched Chromium → loaded the UI → title "GAIA" → screenshot.

## `dualbench/` — dual-engine visual bench (Phase 4.2)
Opens the GAIA UI side by side in **WebKit** (the Tauri `gaia-shell` binary,
≈ iOS/Safari) and **Chromium** (Brave/Chrome `--app`, ≈ Windows/Android) so
engine-specific rendering divergence shows up early. Daemon-safe: only opens
attach windows.

```bash
cd tools/dualbench && ./run.sh
```

## `calayer-poc/` — cross-process CoreAnimation PoC (Phase 3 foundation) ✅ validated
Two-process macOS proof that a **renderer** process can publish a private
`CAContext.contextId` and a **host** process can display that layer live,
zero-copy, via `CALayerHost` — the exact mechanism WebView2 uses on Windows
(DirectComposition) translated to macOS. See `PORTING-MAP.md` /
`CHROMIUM-CACONTEXT.md` in `webview2-re/`.

```bash
cd tools/calayer-poc && ./build.sh && ./renderer /tmp/id.txt & ./host /tmp/id.txt
```

**Key finding (FINDINGS.md):** the host needs **only** the `contextId` — no CGS
connection crosses the process boundary. Private surface is just 3 symbols:
`CAContext`, `CALayerHost`, `CGSMainConnectionID`. Chromium's own
`display_ca_layer_tree.mm` already implements the host side, so the Phase 3
Chromium patch reduces to relaying one `uint32_t` out of the GPU process.
