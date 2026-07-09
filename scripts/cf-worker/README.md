# GAIA Cloudflare Workers front door

Stable public entry point for the GAIA remote stack. Fixes the problem where
`cloudflared`'s quick-tunnel hostname rotates on every restart (which used to
require rebuilding and reinstalling the iOS app).

## Chain

```
iOS app -> https://gaia.gaia-pd.workers.dev (stable, never changes)
        -> Worker (src/worker.js) reads KV "origin" for current tunnel host
        -> https://<random>.trycloudflare.com (rotates freely, harmless now)
        -> edge-proxy 127.0.0.1:8789 (launchd com.gaia.edge-proxy)
        -> daemon 127.0.0.1:8787 (launchd-independent, long-lived process)
```

## What the worker does (`src/worker.js`)

On every request: read KV key `origin` (namespace binding `GAIA_EDGE`,
cached in a module-level variable for 15s to cut down on KV reads), rewrite
the incoming request's path+query onto that origin, `fetch()` it with
`redirect: "manual"` (so the edge-proxy's `/auth` 302 + `Set-Cookie` reach
the client untouched instead of being followed by the Workers runtime), and
return the response verbatim. WebSocket upgrades and SSE both pass through
for free because we never buffer the body — we just return the raw `fetch()`
response.

If KV has no `origin` key yet, returns `503 no origin configured`.

## KV

- Namespace: `GAIA_EDGE`, id `1ed521327e914a49a905ed8aeb320bf9` (account
  `6914b9a9ff47eb9a093f4ce74854aed8`, workers.dev subdomain `gaia-pd`).
- Single key: `origin` -> the currently-live `https://*.trycloudflare.com`
  base URL. Updated automatically by `scripts/tunnel-up.mjs` (see below).
  Read/write manually with:
  ```
  npx wrangler kv key get  --namespace-id 1ed521327e914a49a905ed8aeb320bf9 --remote origin
  npx wrangler kv key put  --namespace-id 1ed521327e914a49a905ed8aeb320bf9 --remote origin "https://foo.trycloudflare.com"
  ```

## Keeping the tunnel hostname fresh: `scripts/tunnel-up.mjs`

Durable replacement for the old ad-hoc `nohup cloudflared ...`. Spawns
`cloudflared tunnel --url http://127.0.0.1:8789` (absolute path
`/opt/homebrew/bin/cloudflared`, since launchd agents don't get a shell
`PATH`), tees all output to `/tmp/gaia-cloudflared.log`, scans it for the
assigned `https://*.trycloudflare.com` hostname, and on each new hostname
runs `npx wrangler kv key put --namespace-id <id> --remote origin <url>`
(using absolute node/npx paths, again because of the minimal launchd PATH)
from the repo root. It stays running as cloudflared's parent and exits when
cloudflared exits, so a `KeepAlive` launchd wrapper restarts the pair
together.

`scripts/tunnel-up.sh` is a thin manual/foreground wrapper around the same
script (`cd repo-root && exec node scripts/tunnel-up.mjs`) for running it by
hand outside of launchd.

launchd agent: `~/Library/LaunchAgents/com.gaia.cloudflared.plist`
(`RunAtLoad` + `KeepAlive`, logs to `/tmp/gaia-cloudflared-agent.log`).
Bootstrap/manage it with:
```
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.gaia.cloudflared.plist
launchctl print gui/501/com.gaia.cloudflared
launchctl bootout gui/501/com.gaia.cloudflared
```

Rotation is now harmless: every time this tunnel restarts and gets a new
`trycloudflare.com` hostname, it just pushes the new hostname to KV within a
few seconds, and the worker picks it up (after its 15s cache expires) with
zero client-visible impact — the workers.dev URL baked into the app never
changes.

Note: there is a second, older ad-hoc `cloudflared` process (pid 18595 at
time of writing) that the currently-installed phone build still points at
directly. It is intentionally left running and untouched; once the phone is
reflashed with the new workers.dev-based URL it can be retired.

## Redeploying the worker

```
cd scripts/cf-worker
npx wrangler deploy
```
Config lives in `wrangler.jsonc` (worker name `gaia`, KV binding `GAIA_EDGE`
already wired to the namespace id above). Deploys to
`https://gaia.gaia-pd.workers.dev`.

## Follow-up

`docs/REMOTE-STACK.md` is owned by another concurrent worker in this repo
and was intentionally NOT touched here — it needs a follow-up merge to fold
in this workers.dev front door as the new first hop in the documented chain.
