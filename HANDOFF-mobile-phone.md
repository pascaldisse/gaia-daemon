# HANDOFF — GAIA on Pascal's iPhone (for @nyari)

**Author:** @ari · 2026-07-09 · **Owner going forward:** @nyari

## Goal (unchanged, from Pascal)
Get the GAIA Tauri **iOS app running on the physical iPhone 13 mini** (NOT the
simulator) as a thin remote-control client for the Mac-hosted GAIA daemon. It
**must also work outside the home LAN** (cellular / anywhere), not just local
Wi‑Fi.

**Pascal has REJECTED Tailscale.** Pick a different outside-LAN transport and get
his sign-off before building it.

## Hard constraints
- The GAIA daemon is **live**, bound to `127.0.0.1:8787` (loopback only), and it
  **serves the active chat room. DO NOT kill or restart it.**
- The daemon has **no auth** on its HTTP surface. Any transport that exposes it
  publicly (ngrok, bare Cloudflare Tunnel, 0.0.0.0 + port-forward) exposes every
  room to whoever finds it. Whatever transport is chosen must give a **stable
  hostname** to bake into `GAIA_MOBILE_DAEMON_URL` and must pass **SSE +
  WebSocket** cleanly.

## Environment facts
- Mac LAN IP: `192.168.178.20`
- iPhone 13 mini (`iPhone14,4`), iOS 26.5, UDID
  `D23DA607-1877-58A8-B672-948DB9BF396E`, USB-connected, shows **"no DDI"**
  (developer disk image not yet mounted).
- Signing works now: personal team **`T2253T7WJE`**, cert *"Apple Development:
  pascaldisse@icloud.com (CAM4GHKEPK)"* valid. `developmentTeam` already set in
  `tauri.ios.conf.json`.
- Simulator (iPhone 17 Pro, iOS 26.3) is booted; app `com.gaia.daemon` builds,
  installs, and launches there fine.

## What I changed this session (all UNCOMMITTED, in working tree)
1. **`src-tauri/src/lib.rs` — the real viewport bug fix.** The main
   `WebviewWindowBuilder` applied `.inner_size(1180.0, 820.0)` +
   `.min_inner_size(720.0, 480.0)` unconditionally. On iOS that desktop size
   becomes the WKWebView **frame**, so the page laid out at **1180 CSS px**; with
   `dpr=3` the phone only shows the left ~third (measured live: `innerWidth=1180`,
   `html clientWidth=1180`, `pre` already `pre-wrap`). I gated that sizing behind
   `#[cfg(desktop)]` so mobile lets the webview fill the device screen.
   **NOT yet rebuilt / re-measured — verify this.**
2. **`web/index.html`** — viewport meta →
   `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover`.
   (Also removed a temporary on-screen diagnostic script I had added to measure.)
3. **`src-tauri/tauri.ios.conf.json`** — added `"developmentTeam": "T2253T7WJE"`.
4. **`scripts/lan-proxy.mjs`** — NEW. Raw-TCP bridge `0.0.0.0:8788 → 127.0.0.1:8787`
   so the phone can reach the loopback daemon **without restarting it**.
   **Currently RUNNING** (background, pid ~11510). Verified:
   `curl http://192.168.178.20:8788/api/app` → 200. **LAN-only** — does not solve
   the outside-LAN requirement.

(Pre-existing, from @jareth's earlier work: `scripts/gaia-mobile.mjs`,
`src-tauri/Info.ios.plist`, `tauri.ios.conf.json`, `src-tauri/MOBILE.md`,
`package.json` `mobile:ios:*` scripts, `build.rs`, `web/src/styles.css` mobile
`@media (max-width:760px),(pointer:coarse)` overlay layout, `web/src/main.js`
`isMobileViewport()` boot-collapse.)

## THE BLOCKER — device build fails
`tauri ios dev` (via `npm run mobile:ios:dev`) **hangs then errors**:
```
Warn  Waiting for your frontend dev server to start on http://192.168.178.20:8787/...
Error Could not connect to `http://192.168.178.20:8787/` after 180s.
```
Two problems:
- (a) It waits on **:8787** (loopback, unreachable from LAN) rather than the
  reachable **:8788** proxy — my `GAIA_PORT=8788` env didn't reach tauri's devUrl.
- (b) More fundamental: `tauri ios dev` **requires a live `devUrl` dev server**,
  but this thin-client design loads its frontend from the **daemon** via
  `GAIA_MOBILE_DAEMON_URL`. There is no separate dev server, so the wait can never
  succeed.

**Likely fix directions (your call, verify):**
- Point tauri's `devUrl` at the reachable daemon URL (check `tauri.conf.json` /
  `tauri.ios.conf.json` / `build.rs` / `gaia-mobile.mjs` for where `8787` /
  `devUrl` / `frontendDist` is set), **or**
- Switch the device path from the dev-server-watching `tauri ios dev` to
  `tauri ios build --debug` + `xcrun devicectl device install app` +
  `... device process launch`. This avoids the phantom-dev-server wait entirely
  and is probably the more robust path for a physical device.

## Still open besides the blocker
- **Outside-LAN transport: UNSOLVED, and NOT Tailscale.** Decide the approach
  *with Pascal* before implementing. Must satisfy the "no auth on daemon" +
  "stable hostname" + "SSE/WS passthrough" constraints above.
- **Viewport fix unverified** on device/sim — rebuild and confirm `innerWidth`
  is ~375 (device points) on the 13 mini, layout no longer clipped.
- **Device-side gates** almost certainly still pending and need **Pascal's hands
  on the phone**: enable **Developer Mode** (Settings ▸ Privacy & Security ▸
  Developer Mode), and **trust** the personal-team cert on first launch. Also the
  DDI may need mounting (recent Xcode/devicectl usually auto-mounts on first
  deploy).

## Key files
- `scripts/gaia-mobile.mjs` — mobile launcher (`GAIA_PORT`, `GAIA_MOBILE_HOST`,
  `--simulator`/`--device`, injects `GAIA_MOBILE_DAEMON_URL`).
- `scripts/lan-proxy.mjs` — LAN bridge (running).
- `src-tauri/src/lib.rs` — window builder (~line 599) + WKWebView media-capture hook.
- `src-tauri/tauri.conf.json`, `tauri.ios.conf.json`, `Info.ios.plist` — check
  where `devUrl` / the `8787` wait originates.
- `web/index.html` (viewport), `web/src/styles.css` (mobile CSS),
  `web/src/main.js` (mobile boot-collapse).
- `src-tauri/MOBILE.md` — @jareth's earlier notes.

## Suggested order for @nyari
1. Kill the phantom-dev-server blocker (devUrl fix **or** `ios build` + devicectl).
2. Rebuild; verify the `lib.rs` viewport fix (`innerWidth` ≈ 375, no clipping).
3. Settle the outside-LAN transport **with Pascal** (not Tailscale); get a stable
   hostname; bake into `GAIA_MOBILE_DAEMON_URL`.
4. Deploy to the device; walk Pascal through Developer Mode + cert trust.

**Do not restart the loopback `:8787` daemon. The `:8788` proxy is running and can
stay as the LAN path.**
