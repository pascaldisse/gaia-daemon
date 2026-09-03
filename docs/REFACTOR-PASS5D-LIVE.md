# W3 pass 5d compiled live · 2026-09-03

- base → `5991ecd`; branch → `live/pass5d`; port → `18787`.
- compiled binary → `.gaia/livetest-dist/gaia-daemon`; build → rc `0`; 79,363,682 bytes.
- run root → `.gaia/live-test-runs/pass5d-20260903024120`; isolated `GAIA_HOME` + initialized `.gaia/livews/.gaia/config.json`; daemon cwd → livews.
- command route → same already-open `default` room throughout; truth → transcript + daemon/marker files.

## Static pre-check

- `import.meta` hit → `plugins/rpg-engine/server/index.js:36`, `import.meta.url` → filesystem-derived `ROOT_DIR`.
  - bundled package is runner-placement; its manifest entrypoint `plugins/rpg-engine/index.mjs` does not import that server file → **no P1 ticket** for daemon Blob-module loading.
- bare imports → `plugins/defaults/dog-mode.mjs:28` `node:fs`; `plugins/defaults/dog-mode.mjs:29` `node:path`.
  - compiled `/dog on` returned durable plugin reply → Bun.build externalization path exercised.

## Case 3 · staged manifest boundary

### Bundled loader / compiled binary

**PASS.** Boot log → generation 1 staged/swapped `gaia.defaults,gaia.rpg,acme.probe`. Same-room `/dog on` → transcript `kind:"plugin-reply"`, `collar clicks shut`. Bundled daemon plugin path therefore loaded through `importPluginModule` in compiled binary.

### Version-bumped fixture → v1 to v2

**PASS.** Held `/probe inflight` → v1 entered generation 1. Replaced both manifest (`1.0.0 → 2.0.0`) + entrypoint; only `POST /api/plugins/reload` → `status:"staged"`. Released held turn → v1 reply generation 1. Same open room `/probe next` → `V2 reply generation=2 args=next`. Lifecycle → stage 2 → swap 2 → dispose v1 exactly once.

### Code-only fixture → v2 to v2B

**PASS.** Held v2 `/probe inflight`; changed entrypoint while manifest remained `2.0.0`; only reload POST. Released → v2 reply generation 2. Same room next → `V2B reply generation=3 args=next`. Lifecycle → stage 3 → swap 3 → dispose v2 exactly once.

### Unchanged reload / carry-forward

**PASS.** Reload with no file changes → generation 4 stage/swap. `manifest-before-nochange.log` byte-identical to `manifest-after-nochange.log` → no module import/dispose. No dispose generation 3 in lifecycle log.

## Evidence

- transcript → `case3-transcript.jsonl`; HTTP responses → `dog.{http,json}`, `probe-*`, `reload-*`.
- module execution/disposal → `manifest-executions.log`; no-change independent byte comparison → `manifest-{before,after}-nochange.log`.
- lifecycle → `daemon.log`, `daemon-lifecycle-final.log`; consolidated assertions → `case3-assertions.txt`.
- build + static results → `build.log`, `binary-size.txt`, `static-precheck.txt`.

## Tickets

- none.

## Cleanup

- daemon stopped; `livetest-dist`, `livehome`, `livews` removed.
- final listener/process scans → `lsof-after-final.txt`, `orphan-sweep-final.txt`.
