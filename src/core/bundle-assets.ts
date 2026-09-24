// Bundle runtime inventory → one source for build snapshot + /rebuild swap.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Asset directories snapshotted next to the binary, swapped on every rebuild.
 * vendor/ holds third-party packages that cannot be `bun build --compile`d
 * in-place (see vendor/photon-node/README-GAIA.md): their internal
 * `path.join(__dirname, ...)` asset loads get baked to the BUILD MACHINE'S
 * literal node_modules path by bun's compiler/bundler — verified true even
 * for plain `bun build` (non-compile), not just --compile — so they must
 * ship as real, unbundled files loaded via a genuine runtime `import()` of
 * their actual on-disk path (core/paths.ts photonNodeAssetDir +
 * harness/image-read.ts) instead of a bare package-specifier import.
 * plugins/ ships manifest command packages; bundled defaults load through the
 * daemon registry with zero setup, while the rest (e.g. rpg) are
 * reference examples a user may copy into ~/.gaia/plugins/ to opt in. */
export const BUNDLE_ASSET_DIRS = ["web", "setups", "design", "addons", "vendor", "plugins"] as const;

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
export const BUNDLE_BINARY_ARTIFACTS = ["gaia-daemon", "gaia-telegram-bridge", "gaia-source.json", "graphql.js", "package.json"] as const;

/** Linked dep whose runtime reads `<dirname(process.execPath)>/package.json`
 * inside a compiled binary (pi config.js getPackageDir → isBunBinary branch →
 * VERSION = pkg.version || "0.0.0"). Absent file → VERSION 0.0.0 → UA
 * `pi/0.0.0` → pi.dev catalog 404 (min-version gate). Build copies its real
 * manifest verbatim next to the binary → version derived, never hardcoded. */
export const BUNDLE_EXEC_MANIFEST_PACKAGE = "@earendil-works/pi-coding-agent";

/** Abs path of `pkg`'s own package.json as resolved from `fromDir` (node_modules
 * walk-up). package.json is not in the package's `exports` → resolve the entry,
 * then walk up to the manifest whose name matches. */
export function resolvePackageManifest(pkg: string, fromDir: string): string {
  let dir = dirname(Bun.resolveSync(pkg, fromDir));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const name = (JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown }).name;
      if (name === pkg) return candidate;
    }
    dir = dirname(dir);
  }
  throw new Error(`package.json for ${pkg} not found above ${fromDir}`);
}

/** From-source rebuild → assets only; packaged rebuild → assets + executable metadata. */
export function bundleSwapNames(fromSource: boolean): string[] {
  return fromSource
    ? [...BUNDLE_ASSET_DIRS]
    : [...BUNDLE_ASSET_DIRS, ...BUNDLE_BINARY_ARTIFACTS];
}
