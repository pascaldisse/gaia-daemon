# GAIA Native Shell — HANDOFF (LOCKED COURSE — do not re-litigate)

> Written 2026-07-07 after too much course-thrashing. The spec below is FINAL.
> Do NOT propose alternatives, do NOT "retire Tauri", do NOT bundle Chromium.
> Read this fully before touching anything.

## 🔒 LOCKED GOAL (Pascal, verbatim intent — NEVER change course)
Build the GAIA **desktop** app as **Tauri + Chromium**, where Chromium is **whatever
Chromium-family browser is ALREADY INSTALLED on the machine** (Pascal's is **Brave**;
also valid: Chrome, Edge, Chromium, Vivaldi).

- **KEEP THE SMALL BINARY.** Do NOT bundle Chromium. This is NOT Electron. Do NOT ship
  CEF's ~170 MB libcef.
- **Tauri stays — permanently.** It is the native app: real OS windows (the ORIGINAL
  reason we started this), native menus + ⌘ accelerators, multi-window, cross-window
  events, and **iOS** (WKWebView, Apple-forced).
- Start from the public repo Pascal sent 3h ago: **https://github.com/tauri-apps/cef-rs**
  and **REWRITE it** so, instead of bundling its own Chromium, it embeds/drives the
  **installed** Chromium.
- Same model as **Windows WebView2**: app is tiny, Chromium runtime is the system's.
  We are reverse-engineering that mechanism for **macOS and Linux**.
- **"You make it work with ANY Chromium version installed on the computer."** ← the rule.

## Engine matrix (TWO engines, on purpose)
| Target | Engine | How | Native features |
|---|---|---|---|
| Windows | Chromium | WebView2 → system Edge/Chromium runtime (already works, no bundle) | full |
| **macOS / Linux** | **Chromium** | **installed browser (Brave/Chrome) embedded via `CALayerHost`/`CAContext` surface-sharing + driven over CDP** ← THE THING TO BUILD | full |
| iOS (+ Mac WebKit canary) | WebKit | Tauri / WKWebView | single-view + tabs |

Web layer must stay engine-agnostic (runs on Chromium AND WebKit) and feature-detect.

## Technical route (mechanism already POC-validated — do NOT re-discover)
Reverse-engineer how **WebView2 embeds an out-of-process Chromium's rendered surface**
into a native window, and do the same on macOS:
- **macOS:** Chromium creates a `CAContext` (`[CAContext contextWithCGSConnection:]`),
  sets its `.layer` to the compositing root, and exposes a `.contextId` (uint32 token).
  A second process embeds that surface via **`CALayerHost`** using the contextId →
  cross-process compositing (~3 private CoreAnimation symbols). See the **`whale-flash`
  sub-room POC ("calayer-poc")** — the mechanism is VALIDATED. Remaining work = wire it
  to an installed-Chromium subprocess + a Tauri-managed window.
- **Drive** the embedded Chromium (navigation/input/lifecycle) via **CDP**
  (`--remote-debugging-port`) against the installed browser.
- **Result:** Tauri native window, rendering = installed Chromium, small binary.

## ✅ DONE / current state (everything on `main`, one branch)
- `main` consolidated (fast-forwarded, one branch): native Tauri shell (`src-tauri/`),
  loopback-IPC fix, background-process tray (SHIPPED, live — the `⚙ N bg` chip),
  Pascal's voice-dictation WIP (commit `002b6d7`).
- Engine validation (useful, but via the WRONG vehicle): standalone `cefsimple` in
  `/tmp/cef-rs` proved Chromium renders GAIA from `:8787` and CDP works on `:9333`.
  ⚠️ This BUNDLED Chromium and was STANDALONE — it is NOT the deliverable.
- Worktrees: `/projects/gaia-daemon` (`main`, live) and `/projects/gaia-dev-app`
  (`feat/native-app` = the WKWebView build — KEEP as the **iOS / WebKit** path).
- Branch `feat/apple-container-backend` is unmerged — Pascal's call to keep or drop.

## ❌ WRONG paths already taken (do NOT repeat)
- Building a **standalone cefsimple** app (throws away Tauri).
- **Bundling** CEF's own Chromium (~170 MB, Electron-like).
- Saying/implying **"retire Tauri"** — Tauri is the shell AND the iOS path, permanent.
- `window.open` tear-off inside bare CEF (those are Chromium popups, not Tauri-managed
  native windows with menus/accelerators).

## 🚧 Hard operating rules (safety — enforced, do not violate)
- The live daemon (`:8787`, the `/projects/gaia-daemon` checkout) serves Pascal's REAL
  session right now. **NEVER** edit the live checkout's `web/` while he's connected,
  **NEVER** restart/kill that daemon, **NEVER** overwrite/hijack the running session.
  Do ALL dev in an isolated worktree and test in a **SEPARATE** window/port.
- **Coding tasks → summon `@jareth`** (has shell, ships end-to-end: write/build/commit/
  test). Do NOT use deepseek agents for coding (`@sidia` is read-only).
- Background long jobs; surface their status in-room; never block foreground for minutes.

## ⏭ Next concrete step
1. `@jareth` (Codex) hit its usage cap; resets ~18:03 → resume coding there.
2. Stand up the **macOS installed-Chromium-in-Tauri POC**: launch installed **Brave**
   with `--remote-debugging-port`, obtain its `CAContext.contextId`, embed via
   `CALayerHost` in a Tauri window, drive via CDP. Reference the `whale-flash`
   calayer-poc for the CoreAnimation mechanism and `cef-rs` for the Rust scaffolding to
   rewrite (strip the bundled-Chromium assumption; point at the installed browser).
3. Verify: Tauri window renders your Brave engine, small binary, no bundled Chromium.
