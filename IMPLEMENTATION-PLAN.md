# GAIA Tauri Shell — Implementation Plan

> **This file is the resume point.** Context may have been compacted. Read
> Section 0 first; it makes this plan self-contained. Everything needed to
> continue is on disk at the paths named below.

---

## 0. RESUME CONTEXT (read first after a context reload)

**What this is:** wrapping the existing **gaia-daemon** web UI in a native
**Tauri v2** shell, cross-platform (macOS, Windows, Linux, iOS, Android),
*additively* — the current web app stays 100% intact as a backup.

**Who/where I am:** I (Ari, matriarch) run *inside* the live gaia-daemon that
serves this room. Therefore ALL work happens in an isolated git worktree so I
never edit my own running host and crash myself.

**Isolated workspace (already created):**
- Worktree: `/Users/pascaldisse/projects/gaia-daemon-tauri`
- Branch: `feat/tauri-shell` (off `main` @ `7cd1736`)
- The running daemon lives in `/Users/pascaldisse/projects/gaia-daemon` (branch
  `main`) — **DO NOT edit files there.** Only work in the worktree above.

**Prior research (all verified, on disk in `/Users/pascaldisse/projects/webview2-re/`):**
- `BUILD-SPEC.md` — the unified conclusion (read this second).
- `RE-FINDINGS.md` — WebView2 in-window mechanism, reverse-engineered from the
  real `EmbeddedBrowserWebView.dll` (dynamic DirectComposition load, verified in binary).
- `PORTING-MAP.md` — DirectComposition → macOS Core Animation mapping.
- `CHROMIUM-CACONTEXT.md` — the Chromium macOS patch target (`contextId` relay).
- Extracted DLLs: `webview2-re/dll/EBWebView.{x64,arm64}.dll`.

**The one-paragraph conclusion driving this plan:**
You support exactly **two web engines**: **WebKit** (mandatory on iOS; the Tauri
default on macOS/Linux) and **Chromium** (free via WebView2 on Windows and via
System WebView on Android). **WebKit is the load-bearing baseline** — the UI must
be correct on WebKit everywhere. **Chromium is a per-platform enhancement**, free
on Win/Android and *optional/advanced* on macOS via a small Chromium patch that
publishes its `contextId` to a host `CALayerHost`. If that patch is ever painful,
the app still ships correctly everywhere on WebKit.

**How gaia serves its UI (do not change this contract):**
- `src/server/http.ts` serves static files from the repo's `web/` dir
  (`webRoot() = ../../web`), SPA-style (`index.html` fallback), on `gaiaPort()`.
- The daemon is a Node/tsx process (`gaia` CLI, `src/cli.ts`). Tauri will *wrap*
  this server, not replace it. The browser-accessible web UI remains the backup.

---

## 1. Goals & hard constraints

**Goal:** a native desktop+mobile app that renders the gaia UI, cross-platform,
with Chromium where free and WebKit as the universal baseline.

**Constraints (non-negotiable):**
1. **Additive only.** The existing web app + http server behavior is unchanged.
   Running gaia in a browser must still work identically.
2. **Worktree isolation.** All edits in `gaia-daemon-tauri`. Never touch the
   running `gaia-daemon` main checkout.
3. **Web version kept as backup** for the foreseeable future (own toggle to run
   headless/browser mode).
4. **No self-crash.** Nothing in this work restarts or rebuilds the daemon
   instance currently serving this room.
5. **WebKit-correct first.** Ship on the default engines before any Chromium
   embedding effort.

---

## 2. Architecture

```
┌─────────────────────────── Tauri shell (Rust, src-tauri/) ───────────────────────────┐
│  1. Ensure gaia daemon is running (spawn as sidecar if not already up)                │
│  2. Resolve its port (gaiaPort / config)                                              │
│  3. Open a native window → load  http://127.0.0.1:<port>/                             │
│         macOS/iOS  → WKWebView (WebKit)      [baseline]                                │
│         Windows    → WebView2 (Chromium)     [free]                                    │
│         Android    → System WebView (Blink)  [free]                                    │
│         Linux      → WebKitGTK (WebKit)       [baseline]                               │
│  4. (optional, macOS) Chromium enhancement via CALayerHost — Phase 3                   │
└───────────────────────────────────────────────────────────────────────────────────────┘
                 the gaia Node daemon + its http server are UNCHANGED
                 (browser access to the same URL = the backup path)
```

**Key decision — daemon lifecycle:** Tauri app uses a **sidecar** (`externalBin`)
or a spawned child process to start `gaia` if no daemon is reachable on the port,
then loads the localhost URL. If a daemon is already running (e.g. the dev one),
it just attaches. This keeps the server code untouched and the web backup live.

---

## 3. Worktree & branch setup — DONE

```bash
# already executed:
git -C /Users/pascaldisse/projects/gaia-daemon \
    worktree add /Users/pascaldisse/projects/gaia-daemon-tauri -b feat/tauri-shell main
```
Verify anytime: `git -C /Users/pascaldisse/projects/gaia-daemon worktree list`.
All commands below run **inside** `/Users/pascaldisse/projects/gaia-daemon-tauri`.

---

## 4. Phase 1 — WebKit baseline desktop shell (macOS/Windows/Linux)

**Outcome:** a native window rendering the gaia UI on each OS's default engine.
This alone is a shippable desktop app and covers the WebKit baseline.

Steps:
1. **Add Tauri v2** without disturbing the Node project:
   - Install Rust toolchain if absent (`rustup`), and the Tauri CLI
     (`cargo install tauri-cli --version "^2"` or `npm i -D @tauri-apps/cli@^2`).
   - `cargo tauri init` (or `npm run tauri init`) → creates `src-tauri/` only.
     Keep it in a subfolder; do not modify root `package.json` scripts beyond
     adding a `tauri` script.
2. **Configure `src-tauri/tauri.conf.json`:**
   - `build.beforeDevCommand` / `beforeBuildCommand`: build the gaia web assets
     if needed (they already live in `web/` — likely a no-op or `npm run build`).
   - `app.windows[0].url`: `http://127.0.0.1:<port>/` (dev) — but prefer a small
     Rust bootstrap that resolves the port at runtime and navigates, rather than
     hardcoding.
   - `app.security.csp`: allow `connect-src`/`ws:` to localhost (gaia uses SSE/WS).
   - Bundle identifier: `com.gaia.daemon` (or existing convention).
3. **Rust bootstrap (`src-tauri/src/main.rs` / `lib.rs`):**
   - On setup: check if `127.0.0.1:<port>` responds; if not, spawn the gaia
     daemon (`gaia` CLI via sidecar or `Command`), wait for readiness (poll the
     port), then load the URL in the main window.
   - Graceful shutdown: only kill the daemon child if *this app spawned it*
     (never kill a pre-existing/dev daemon).
4. **Keep web backup:** add a config/env flag (e.g. `GAIA_SHELL=off`) so the
   daemon can still be launched headless and used via a browser exactly as today.
5. **Verify (acceptance):**
   - `npm run tauri dev` opens a native window showing the live gaia UI.
   - The same URL still works in a normal browser (backup intact).
   - The running room-serving daemon is unaffected (different port/instance).

---

## 5. Phase 2 — Mobile (iOS = WebKit, Android = Chromium)

1. **Android** (free Chromium via System WebView):
   - `cargo tauri android init`; configure the same localhost-load model. On
     mobile, the daemon can't be a localhost child the same way — decide:
     (a) bundle a lightweight local server, or (b) point at a remote gaia
     instance. **Open decision — see §10.**
2. **iOS** (WKWebView only):
   - `cargo tauri ios init`; WebKit is mandatory (see `webview2-re` research).
     Same load model as Android.
3. **Acceptance:** app builds for both, renders the UI; note WebKit-specific
   rendering issues (they also affect macOS default — fix once, benefits both).

---

## 6. Phase 3 — macOS Chromium enhancement (OPTIONAL / ADVANCED, defer)

Only if Chromium rendering on macOS is wanted for parity/debugging. Full mechanism
in `webview2-re/BUILD-SPEC.md` + `CHROMIUM-CACONTEXT.md` + `PORTING-MAP.md`.

Summary of the route:
- Patch a Chromium build so it **relays its `CAContext.contextId`** out of
  `CALayerTreeCoordinator::EnsureCAContextAndRootLayer()`
  (`ui/accelerated_widget_mac/ca_layer_tree_coordinator.mm`) to our host process.
- The Tauri (Cocoa) side builds a `CALayerHost` with that `contextId`, hosts it
  in an `NSView` layered into the window; relay `NSEvent` input + set `NSCursor`
  on cursor-change (mirrors WebView2's `SendMouseInput` / `CursorChanged`).
- Public fallback: **IOSurface** path (+1 blit/frame, no private API).
- This is a *custom Chromium build to maintain*, not stock Brave. Cost is real;
  only pursue if the parity/debug value justifies it. **WebKit baseline ships without it.**

---

## 7. Phase 4 — Dev tooling (independent, high value, low cost)

1. **CDP debugging without embedding:** point **Playwright** at the same
   `http://127.0.0.1:<port>/` the app serves; drive real Chromium (installed
   Brave/Chrome) over CDP for the browser-tools workflow. Zero embedding, zero MB.
2. **Dual-engine Mac bench:** run two shells side by side — WKWebView instance
   (≈ iOS/Safari test target) and a Chromium instance (≈ Windows/Android) — to
   catch engine-specific rendering divergence early. This is the strategic payoff
   of the two-engine reality.

---

## 8. Testing & acceptance matrix

| Phase | Platform | Engine | Pass condition |
|---|---|---|---|
| 1 | macOS | WKWebView | native window renders UI; browser backup still works |
| 1 | Windows | WebView2 | renders; CDP available |
| 1 | Linux | WebKitGTK | renders |
| 2 | Android | System WebView | builds + renders |
| 2 | iOS | WKWebView | builds + renders; log WebKit-only issues |
| 3 | macOS | patched Chromium | contextId relay → CALayerHost shows live layers |
| 4 | macOS | Playwright/CDP | debug session drives real Chromium on localhost |

Baseline gate before any Phase 3 work: **UI is WebKit-correct on macOS + iOS.**

---

## 9. Risks & rollback

- **Self-crash:** avoided by worktree isolation; never rebuild/kill the serving
  daemon. Rollback = delete the worktree; `main` is pristine.
- **Web backup:** guaranteed intact (http server untouched; Tauri is additive).
- **Private CAContext API drift (Phase 3):** hedge with the public IOSurface path.
- **Mobile daemon model:** unresolved — see §10; do not block Phase 1 on it.
- **Full rollback:** `git worktree remove gaia-daemon-tauri` + delete branch. No
  trace on `main`.

---

## 10. Open decisions for Pascal

1. **Mobile backend:** on iOS/Android, does the app (a) bundle/run a local gaia
   node server, or (b) connect to a remote gaia instance? (Desktop uses a local
   sidecar; mobile can't spawn a Node child as easily.)
2. **Bundle identifier / app name / icon** for the native app.
3. **Pursue Phase 3 (macOS Chromium) at all**, or ship WebKit-only on Mac and
   keep Chromium only where it's free (Win/Android)? (Recommended: defer Phase 3.)
4. **Sidecar vs attach:** should the desktop app always spawn its own daemon, or
   prefer attaching to a running one when present? (Recommended: attach if the
   port is live, else spawn.)

---

## 11. What NOT to touch

- `/Users/pascaldisse/projects/gaia-daemon` (the running daemon's checkout).
- `src/server/http.ts` web-serving contract (Tauri consumes it as-is).
- The `web/` UI source (unless a WebKit-compat fix is needed — then it benefits
  all platforms, but do it deliberately and test both engines).
- Anything that would require restarting the daemon serving this room.

---

## 12. Immediate next actions (on resume)

1. `cd /Users/pascaldisse/projects/gaia-daemon-tauri`
2. Read `webview2-re/BUILD-SPEC.md` for the full rationale.
3. Answer the §10 open decisions (especially #1 mobile backend, #3 Phase-3 go/no-go).
4. Begin Phase 1, step 1 (add Tauri v2 into `src-tauri/`), commit early on
   `feat/tauri-shell`, do not push unless asked.
