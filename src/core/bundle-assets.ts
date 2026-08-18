// Bundle runtime inventory → one source for build snapshot + /rebuild swap.

/** Asset directories snapshotted next to the binary, swapped on every rebuild. */
export const BUNDLE_ASSET_DIRS = ["web", "setups", "design", "addons"] as const;

/** Source-only content removed from compiled asset snapshots. */
export const BUNDLE_ASSET_EXCLUDES: Readonly<Partial<Record<(typeof BUNDLE_ASSET_DIRS)[number], readonly string[]>>> = {
  design: ["test"],
};

/** Artifacts that only exist in a packaged (compiled) install. */
export const BUNDLE_BINARY_ARTIFACTS = ["gaia-daemon", "gaia-telegram-bridge", "gaia-source.json"] as const;

/** From-source rebuild → assets only; packaged rebuild → assets + executable metadata. */
export function bundleSwapNames(fromSource: boolean): string[] {
  return fromSource
    ? [...BUNDLE_ASSET_DIRS]
    : [...BUNDLE_ASSET_DIRS, ...BUNDLE_BINARY_ARTIFACTS];
}
