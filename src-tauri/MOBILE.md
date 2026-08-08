# GAIA mobile remote shell

Goal: keep the daemon and all harnesses running on the Mac, and use the phone as a thin remote-control client for the same web UI.

## One-time iOS setup

```sh
npm install
npm run mobile:ios:init
```

## Run on the iOS simulator

The simulator can attach to the existing Mac-local daemon on `127.0.0.1:8787`, so it does **not** require restarting GAIA with LAN binding:

```sh
npm run mobile:ios:sim
```

That expands to:

```sh
node scripts/gaia-mobile.mjs ios-dev --simulator --device "iPhone 17 Pro"
```

Current verified simulator on this Mac: `iPhone 17 Pro` with iOS `26.3`.

## Run on a physical iPhone

A real phone cannot reach the Mac's loopback address, so the daemon must listen on the LAN:

```sh
npm run stop
GAIA_HOST=0.0.0.0 npm run dev
npm run mobile:ios:dev
```

Or choose the Mac address/device explicitly:

```sh
node scripts/gaia-mobile.mjs ios-dev --host 192.168.x.y --device "<device name>"
```

What the script does in phone mode:

1. Picks a LAN IPv4 address for this Mac unless `--host` is provided.
2. Ensures the daemon is reachable at `http://<mac-ip>:8787/api/app`.
3. If no daemon is running, starts one with `GAIA_HOST=0.0.0.0 GAIA_PORT=8787 npm run dev`.
4. Compiles the iOS shell with `GAIA_MOBILE_DAEMON_URL=http://<mac-ip>:8787/`, so the app webview points at the Mac daemon instead of the phone's own localhost.
5. Runs `tauri ios dev --features webkit --host <mac-ip>`.

If the script says GAIA is already running but not LAN-reachable, restart it explicitly with the commands above, then run `npm run mobile:ios:dev` again.

## Device notes

- Physical devices require Apple signing. Set `APPLE_DEVELOPMENT_TEAM=<team-id>` or `bundle.iOS.developmentTeam` before device builds.
- The iOS Info.plist permits local-network HTTP because dev mode intentionally connects to the Mac daemon over LAN.

## Security note

`GAIA_HOST=0.0.0.0` exposes the daemon to the local network. Use it on trusted networks only until a pairing/auth layer is added.
