# vendor/photon-node

Verbatim copy of `node_modules/@silvia-odwyer/photon-node` (photon_rs.js,
photon_rs.d.ts, photon_rs_bg.wasm, package.json, LICENSE.md) — same files, no
edits. photon_rs_bg.js omitted (browser/wasm-import twin, unused by
photon_rs.js's own require path).

Why here, not just node_modules → package.json:
photon_rs.js loads its wasm via `require('path').join(__dirname,
'photon_rs_bg.wasm')` at import time. Both `bun build --compile` AND plain
`bun build` (verified 2026-08-21) bake `__dirname` in as a LITERAL
build-machine string (e.g. `/Users/you/projects/gaia-daemon/node_modules/...`)
— dead on any other machine. Root cause of the 2026-08-21 total-outage
regression (every agent turn failed, not just image reads, because
harness/image-read.ts imported the package statically at module scope).

Fix: ship these files unbundled, snapshotted next to the binary like
web/setups/design/addons (core/bundle-assets.ts BUNDLE_ASSET_DIRS), and load
via a genuine runtime `import()` of the real on-disk path
(core/paths.ts photonNodeAssetDir, harness/image-read.ts loadPhoton) — a real
file loaded by Bun's normal module loader gets `__dirname` correct, no
bundler involved. Source/dev runs with no vendor/ snapshot fall back to the
bare `@silvia-odwyer/photon-node` package import (works fine unbundled).

Update procedure when bumping photon-node's version: re-copy the same file
list from the new node_modules/@silvia-odwyer/photon-node/.
