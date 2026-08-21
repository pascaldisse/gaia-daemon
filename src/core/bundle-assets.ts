// Bundle runtime inventory → one source for build snapshot + /rebuild swap.

/** Asset directories snapshotted next to the binary, swapped on every rebuild. */
export const BUNDLE_ASSET_DIRS = ["web", "setups", "design", "addons"] as const;

/** Source-only content removed from compiled asset snapshots. */
export const BUNDLE_ASSET_EXCLUDES: Readonly<Partial<Record<(typeof BUNDLE_ASSET_DIRS)[number], readonly string[]>>> = {
  design: ["test"],
};

/** Artifacts that only exist in a packaged (compiled) install. graphql.js is
 * server/graphql.ts pre-bundled (bun build, non-compile — see
 * scripts/build-daemon.mjs "graphql-bundle" step) into a single self-contained
 * ESM file next to the gaia-daemon binary: cli.ts's dynamic import of
 * graphql.ts is deliberately non-literal (tsconfig.json's exclude comment) so
 * `bun build --compile` never bundles it into gaia-daemon itself, which means
 * a compiled binary must load it from a real file on disk instead
 * (core/paths.ts graphqlAssetPath). A from-source run has no such file and
 * falls back to importing graphql.ts directly — see cli.ts. */
export const BUNDLE_BINARY_ARTIFACTS = ["gaia-daemon", "gaia-telegram-bridge", "gaia-source.json", "graphql.js"] as const;

/** From-source rebuild → assets only; packaged rebuild → assets + executable metadata. */
export function bundleSwapNames(fromSource: boolean): string[] {
  return fromSource
    ? [...BUNDLE_ASSET_DIRS]
    : [...BUNDLE_ASSET_DIRS, ...BUNDLE_BINARY_ARTIFACTS];
}
