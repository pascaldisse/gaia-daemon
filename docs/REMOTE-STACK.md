# Remote access stack (phone -> daemon)

## Chain

```
Phone (installed GAIA iOS app)
  -> Cloudflare quick tunnel (public trycloudflare.com hostname)
  -> cloudflared tunnel --url http://127.0.0.1:8789   (manual process, NOT launchd)
  -> edge-proxy: node scripts/edge-proxy.mjs, listens 127.0.0.1:8789
       auth: bearer/cookie token, checked against ~/.gaia/edge-token
  -> daemon: 127.0.0.1:8787   (src/cli.ts via tsx, NEVER managed by this stack's launchd)
```

The daemon (127.0.0.1:8787) and cloudflared are process-managed independently of
this doc's launchd agents. Nothing here touches either.

## Keep-awake: daemon-managed, not launchd

"Keep laptop awake while GAIA runs" is a **daemon setting**, not a launchd agent —
Global Settings ▸ General in the web client (checkbox only shown on macOS). It
persists to `~/.gaia/app.json` (`keepAwake`, default `true`) and is applied by
`src/services/keep-awake.ts` / `Daemon.setKeepAwake` (`src/daemon.ts`): while on,
the daemon keeps a single `caffeinate -s -i -m -w <daemon pid>` child alive
(`-w` makes it self-exit if the daemon dies hard); applied on daemon boot and on
every setting change; killed on graceful shutdown. Toggle it via the web UI, or by
hand: `POST /api/app/keep-awake` with `{"enabled": true|false}`.

This supersedes the older `com.gaia.keepawake` launchd agent. **The daemon
auto-removes it on first boot with this code**: `migrateLegacyLaunchdAgent()`
runs `launchctl bootout gui/$(id -u)/com.gaia.keepawake` and deletes
`~/Library/LaunchAgents/com.gaia.keepawake.plist` if either is still present —
one-time, best-effort, and scoped to exactly that label/file (never touches
`com.gaia.edge-proxy`). After that first restart there is nothing left to
manage by hand for keep-awake.

## launchd agents

One agent remains under `~/Library/LaunchAgents/`, `gui/$(id -u)` domain.

### `com.gaia.edge-proxy`

- Runs the real node binary (`command -v node`, resolved, not an nvm shim) with
  `scripts/edge-proxy.mjs`, `WorkingDirectory` = repo root.
- `RunAtLoad` + `KeepAlive`: restarts edge-proxy if it crashes or the machine reboots.
- Logs (append): `/tmp/gaia-edge-proxy.log`.
- Purpose: the only network-facing hop between cloudflared and the daemon; enforces
  the token auth wall (`403` on `/api/app` without a valid token).
- Bootout: `launchctl bootout gui/$(id -u)/com.gaia.edge-proxy`
- Takeover of an ad-hoc `nohup` instance: kill the old pid first (verify its command
  line with `ps -p <pid> -o command=` before killing), then
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gaia.edge-proxy.plist`.
  Verify immediately with a local curl to `/api/app` (expect `403`) and the same path
  through the public trycloudflare hostname (expect `403`). If either check fails:
  `launchctl bootout gui/$(id -u)/com.gaia.edge-proxy` and fall back to
  `nohup node scripts/edge-proxy.mjs > /tmp/gaia-edge-proxy.log 2>&1 &` while
  investigating.

## Why cloudflared stays manual

cloudflared is intentionally **not** a launchd agent. A Cloudflare *quick tunnel*
(`cloudflared tunnel --url ...` with no named tunnel/domain) gets a **new random
`trycloudflare.com` hostname every time the process restarts**. The installed iOS
app has that hostname baked into `src-tauri/mobile-daemon-url.txt` / the build.
An unexpected launchd-triggered restart would silently rotate the hostname and
brick the phone app with no obvious symptom besides "can't connect."

Manual restart command (only run this deliberately):

```
cloudflared tunnel --url http://127.0.0.1:8789
```

Consequence of restarting: the public hostname changes. After restarting you must:
1. Update `src-tauri/mobile-daemon-url.txt` with the new hostname.
2. Rebuild and reinstall the iOS app so the new URL is baked into the binary.

**Permanent fix**: once a real domain is available, switch to a *named* Cloudflare
tunnel (`cloudflared tunnel create` + DNS route). Named tunnels have a stable
hostname across restarts and reboots, and can then safely become a launchd agent
like `com.gaia.edge-proxy`.

## Sleep / power story

- The daemon-managed keep-awake setting (above) prevents idle *system* sleep via
  `caffeinate -s -i -m -w <pid>`, which is normally sufficient — but `-s` (prevent
  sleep while on AC) only helps when the Mac is plugged in.
- **Lid-closed-on-battery** is a separate case caffeinate can't override: if you need
  the machine to stay up on battery with the lid closed, that requires
  `sudo pmset disablesleep 1` (persists across reboots until turned back off with
  `sudo pmset disablesleep 0`; drains battery — use deliberately, not by default).
- **Remote wake if it does sleep**: the FritzBox router supports Wake-on-LAN. The
  MyFRITZ app/portal can send a WoL magic packet to this Mac's configured MAC
  address remotely, which is the fallback path to bring the machine back without
  physical access.
