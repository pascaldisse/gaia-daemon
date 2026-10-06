# Remote access stack (phone -> daemon)

## Chain

```
iOS Tauri shell (URL baked: src-tauri/mobile-daemon-url.txt)
  -> https://151.115.73.182/phone/   (Scaleway WAW, Caddy, /phone prefix stripped)
  -> reverse SSH  com.gaia.phone-bridge (launchd): -R 127.0.0.1:8790 -> Mac 127.0.0.1:8789
  -> edge-proxy  com.gaia.edge-proxy (launchd), scripts/edge-proxy.mjs, 127.0.0.1:8789
       auth: bearer/cookie token vs ~/.gaia/edge-token
  -> daemon 127.0.0.1:8787
```

Cloudflare retired 2026-10-06, never again (Pascal). No quick tunnel, no Worker, no KV, no cloudflared.

Daemon + phone-bridge = process-managed independently of this doc's edge-proxy agent.

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
- Purpose: the auth wall between phone-bridge and the daemon; enforces
  the token auth wall (`403` on `/api/app` without a valid token).
- Bootout: `launchctl bootout gui/$(id -u)/com.gaia.edge-proxy`
- Takeover of an ad-hoc `nohup` instance: kill the old pid first (verify its command
  line with `ps -p <pid> -o command=` before killing), then
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gaia.edge-proxy.plist`.
  Verify immediately with a local curl to `/api/app` (expect `403`) and the same path
  through https://151.115.73.182/phone/api/app (expect `403`). If either check fails:
  `launchctl bootout gui/$(id -u)/com.gaia.edge-proxy` and fall back to
  `nohup node scripts/edge-proxy.mjs > /tmp/gaia-edge-proxy.log 2>&1 &` while
  investigating.

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
