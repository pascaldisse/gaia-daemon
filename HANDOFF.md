# GAIA Native Shell — HANDOFF (LOCKED COURSE v2 — do not re-litigate)

> Rewritten 2026-07-07 after Milestone A proved the "installed browser" path
> impossible and Pascal chose the two-mode design with the full trilemma in hand.
> This SUPERSEDES v1 (the "embed installed Brave via CALayerHost, no bundle" spec).
> Read this fully before touching anything.

## 🔒 LOCKED DECISION (Pascal, 2026-07-07 — chose this himself, informed)
Ship ONE codebase, ONE web UI, and **TWO build modes** of the native Tauri shell,
switchable by a **single compile-time flag** (see "The switch"):

1. **CEF mode** — bundled **CEF Chromium** (`tauri-apps/cef-rs`). Purpose: DevTools /
   CDP debugging + running/testing a real **Chromium** engine on macOS & Linux.
   Trade: larger bundle (ships the ~150 MB `Chromium Embedded Framework.framework`).
2. **WebKit mode (DEFAULT)** — Tauri **wry / WKWebView**. Purpose: **iOS** support
   (Apple-forced) + a **small** macOS bundle (no bundled Chromium).

Tauri stays permanently — it is the native shell for BOTH modes (real OS windows,
native menus + ⌘ accelerators, multi-window, iOS). The web layer stays
**engine-agnostic** (must run on Chromium AND WebKit; feature-detect, no engine
assumptions).

## ❌ DEAD PATH — proven impossible, do NOT reopen (Milestone A result)
"Embed the ALREADY-INSTALLED Brave/Chrome and drive it, no bundle" — **does not
work** on macOS. Proof in `gaia-cef/tools/installed-embed/FINDINGS-INSTALLED.md`
(commit `e651f6b`):
- CDP control of installed Brave works (`--remote-debugging-port`), BUT
- CGS/SLS window-reparenting does not visually embed (Brave stays its own window),
  and no CGS/SLS API exposes an unmodified Brave's `CAContext.contextId` → **no
  token to host via `CALayerHost`** without patching Chromium.
- Root cause: **macOS ships no system Chromium runtime to embed.** WebView2 works on
  Windows because Microsoft ships a *separate embeddable Chromium runtime* — it does
  NOT drive the installed Edge browser. macOS's only system-embeddable web engine is
  **WebKit**. Every working "real browser in a Tauri window" (cef-rs, Servo/Verso)
  **bundles a cooperating engine** — none drives the installed browser. That's why
  CEF mode = bundle, and small-Chromium-on-Mac is not on the menu.

## The switch (compile-time cargo feature, NOT a runtime toggle — on purpose)
- `src-tauri/Cargo.toml`: features `webkit` (default) and `cef`. `--no-default-features
  --features cef` selects CEF; default selects WebKit.
- `src-tauri` runtime selection is `#[cfg(feature = "cef")]`-gated.
- One friendly switch on top: env var `GAIA_ENGINE=cef|webkit` (default `webkit`)
  read by the tauri dev/build npm scripts (e.g. `npm run tauri:dev` = WebKit,
  `GAIA_ENGINE=cef npm run tauri:dev` = CEF), and/or explicit `:cef` script variants.
- **Why not a runtime `--engine` flag in one binary:** that binary would ALWAYS link
  CEF's ~150 MB framework, so the WebKit build would no longer be small — which is the
  entire reason WebKit mode exists. Compile-time keeps each build optimal; the WebKit
  build must NOT link CEF.

## Engine matrix
| Target | Default engine | Debug/Chromium option |
|---|---|---|
| macOS | WebKit (WKWebView) — small, native, iOS-shared | CEF mode (bundled Chromium, DevTools/CDP) |
| iOS | WebKit (WKWebView) — Apple-forced | — |
| Windows | WebView2 (system Chromium, no bundle) | — |
| Linux | WebKitGTK | CEF mode |

## ✅ DONE / current state (`main`)
- `main` consolidated: native Tauri shell (`src-tauri/`, WKWebView), loopback-IPC fix,
  background-process tray (`⚙ N bg` chip, live), voice-dictation WIP (`002b6d7`).
- **Two engine modes MERGED to `main`** (`feat/engine-modes`, merge `6a88a71`):
  `webkit`(default)/`cef` cargo features, `GAIA_ENGINE=cef|webkit` switch, cef-rs
  Chromium+CDP shell, `src-tauri/MODES.md`. Verified: WebKit ~14 MB (no cef linked),
  CEF ~307 MB (Chromium 149 + CDP). Milestone A research kept under `tools/`.
  CEF caveat: standalone cef-rs window + CDP, NOT yet full Tauri runtime (upstream #208).
- **WKWebView mic fix MERGED to `main`** (`fix/native-mic`, merge `7146462`): mic usage
  string + audio-input entitlement + WKUIDelegate loopback grant; folded into the
  webkit path during the engine-modes merge (unified `objc2 0.6.4`).
- `gaia-dev-app` (`feat/native-app`): the running WKWebView build.

## 🚧 Hard operating rules (unchanged — enforced)
- The live daemon (`:8787`) serves Pascal's REAL session. NEVER edit the live
  `gaia-daemon` checkout's `web/` while he's connected, NEVER restart/kill that daemon,
  NEVER overwrite/hijack the running session. All dev in an isolated worktree, tested in
  a SEPARATE window/port / scratch bundle.
- Coding tasks → summon `@jareth` (has shell, ships end-to-end). `@sidia` is read-only.
- Background long jobs; surface status in-room; never block foreground for minutes.
- Do NOT push to remote unless explicitly asked.

## ⏭ Next concrete steps
1. Scaffold the two-mode switch: `webkit`/`cef` cargo features + `#[cfg]` runtime
   selection + `GAIA_ENGINE` dev/build scripts. Default WebKit build must stay small
   (no CEF linked). (→ @jareth, in `gaia-cef` / `feat/engine-modes`.)
2. Integrate `tauri-apps/cef-rs` as the CEF-mode runtime: minimal Tauri window that
   renders the GAIA daemon URL via CEF, DevTools/CDP reachable. If cef-rs's Tauri
   runtime bridge is not ready, scaffold the feature path + a minimal CEF window and
   document the gap honestly.
3. Verify BOTH modes launch from one codebase (separate scratch bundles, never touch
   `:8787`): WebKit = small, CEF = Chromium + DevTools.
4. Land the mic fix (`gaia-mic`) and fold it into the WebKit path.
