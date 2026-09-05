# Release 0904

## Trunk content

- `01b1c26` → `fix/voice-stall` · mid-stream TTS failure cleanup + client late-audio stall recovery
- `d60a4df` → `fix/open-0827` · explicit clean-compaction runtime/command restoration
- `4438532` → `feat/recall-filter` · excluded auto-recall hits
- `33e5e49` → `feat/auto-compact` · threshold/cooldown automatic native compaction + `/autocompact`
- `a472024` → `feat/archtree-add-root` · live Archtree root addition
- `f849e58` → `fix/native-weblinks-terra` · native plain-click HTTP(S) message links

Conflict ledger → `33e5e49`: `commands.ts` + `room-service.ts` retain `dsc-compact` and `autocompact`; one type/parser/registration per command. Other merges → clean.

## Gate record

- `git submodule update --init` → pass
- `bun install --frozen-lockfile` → pass
- specified focused suite → `186 pass · 0 fail`
- `test/room-service.test.ts` → `105 pass · 1 fail`; tolerated baseline-identical timeout: `a stalled turn with no partial reply requeues ONCE (stallRetried), then fails normally on a second stall`
- main-only comparison @ `267c61c` → same room-service timeout; `101 pass · 1 fail`
- `bun run check` → rc 2; main-only comparison @ `267c61c` identical 9 pre-existing Bun/bun-types diagnostics: `plugins/loader.ts` Bun namespace/build config + `web-fetch.ts` bun-types/HTMLRewriter implicit-any diagnostics

## Staged artifact

- root → `~/projects/gaia-daemon-wt/trunk/dist-staging/`
- self-contained app → `GAIA-webkit.app`
- compiled runtime → `dist/`
- app `Contents/MacOS/` → `gaia-shell`, `gaia-daemon`, `gaia-telegram-bridge`, `graphql.js`, `web/`, runtime assets
- `Info.plist` → `CFBundleShortVersionString=0.1.0`; `CFBundleVersion=0.1.0`
- daemon source manifest → `f849e58165aba42e38cd002c42deccf5e9ce4de5`; `dirty=false`
- build verification → `codesign --verify --deep --strict` pass; `dist/web/`, compiled daemon, bridge, GraphQL asset present

## Pascal-run install swap

Quit the running GAIA app first. Then run exactly:

```bash
set -euo pipefail
STAGE="$HOME/projects/gaia-daemon-wt/trunk/dist-staging/GAIA-webkit.app"
DEST="/Applications/gaia-daemon.app"
NEW="/Applications/gaia-daemon.app.0904-new"
BACKUP="/Applications/gaia-daemon.app.0904-backup"
test -d "$STAGE"
test -d "$DEST"
test ! -e "$NEW"
test ! -e "$BACKUP"
ditto "$STAGE" "$NEW"
codesign --verify --deep --strict "$NEW"
mv "$DEST" "$BACKUP"
mv "$NEW" "$DEST"
codesign --verify --deep --strict "$DEST"
open "$DEST"
```

Rollback → quit GAIA; `mv /Applications/gaia-daemon.app /Applications/gaia-daemon.app.0904-failed && mv /Applications/gaia-daemon.app.0904-backup /Applications/gaia-daemon.app`.

## Unverified

- staged app launch/live daemon flow → intentionally not run; preserving the live `/Applications/gaia-daemon.app` and pid set.
