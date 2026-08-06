// Single source of truth for what a compiled gaia bundle contains.
//
// Two consumers must agree or a /rebuild silently destroys part of the
// install: scripts/build-daemon.mjs SNAPSHOTS these names into the staging
// dir, and src/server/http.ts SWAPS them from staging into the app bundle.
// Historically the lists drifted (build snapshotted design/, the swap did
// not) — the atomic swap then left design/ pointing at nothing and packaged
// installs came up blank. Both sides import from here; never re-list names.

/** Asset directories snapshotted next to the binary, swapped on every reload. */
export const BUNDLE_ASSET_DIRS = ["web", "setups", "design"] as const;

/** Artifacts that only exist in a packaged (compiled) install. */
export const BUNDLE_BINARY_ARTIFACTS = ["gaia-daemon", "gaia-source.json"] as const;

/**
 * Names to atomically swap from staging into the install on /rebuild.
 * From-source (dev) runs have no compiled binary to replace — assets only.
 */
export function bundleSwapNames(fromSource: boolean): string[] {
  return fromSource
    ? [...BUNDLE_ASSET_DIRS]
    : [...BUNDLE_ASSET_DIRS, ...BUNDLE_BINARY_ARTIFACTS];
}
