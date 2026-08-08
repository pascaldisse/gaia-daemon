// Bundle runtime inventory → one source for build snapshot + /rebuild swap.

/** Asset directories snapshotted next to the binary, swapped on every rebuild. */
export const BUNDLE_ASSET_DIRS = ["web", "setups", "design"] as const;

/** Artifacts that only exist in a packaged (compiled) install. */
export const BUNDLE_BINARY_ARTIFACTS = ["gaia-daemon", "gaia-source.json"] as const;

/** From-source rebuild → assets only; packaged rebuild → assets + executable metadata. */
export function bundleSwapNames(fromSource: boolean): string[] {
  return fromSource
    ? [...BUNDLE_ASSET_DIRS]
    : [...BUNDLE_ASSET_DIRS, ...BUNDLE_BINARY_ARTIFACTS];
}
