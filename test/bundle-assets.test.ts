import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_ASSET_DIRS, BUNDLE_ASSET_EXCLUDES, BUNDLE_BINARY_ARTIFACTS, bundleSwapNames } from "../src/core/bundle-assets.js";

const repoRoot = join(import.meta.dirname, "..");

test("dev swap covers every snapshotted asset dir", () => {
  const names = bundleSwapNames(true);
  for (const dir of BUNDLE_ASSET_DIRS) assert.ok(names.includes(dir), `missing ${dir}`);
  for (const a of BUNDLE_BINARY_ARTIFACTS) assert.ok(!names.includes(a), `dev must not swap ${a}`);
});

test("packaged swap covers asset dirs + binary artifacts", () => {
  const names = bundleSwapNames(false);
  for (const n of [...BUNDLE_ASSET_DIRS, ...BUNDLE_BINARY_ARTIFACTS]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

test("design/ and addons/ are bundled and therefore swapped", () => {
  for (const asset of ["design", "addons"]) {
    assert.ok(BUNDLE_ASSET_DIRS.includes(asset));
    assert.ok(bundleSwapNames(false).includes(asset));
  }
});

test("browser-shared modules live under web/ so the static server and base-path mounts serve them", () => {
  for (const file of ["gaia-think.js", "tool-summary.js"]) {
    assert.ok(existsSync(join(repoRoot, "web", "shared", file)), `missing web/shared/${file}`);
  }
  const transcript = readFileSync(join(repoRoot, "web", "src", "transcript.js"), "utf8");
  assert.match(transcript, /from "\.\.\/shared\/tool-summary\.js"/);
  assert.match(transcript, /from "\.\.\/shared\/gaia-think\.js"/);
  assert.ok(!BUNDLE_ASSET_DIRS.includes("shared"));
});

test("compiled design assets omit source-only tests", () => {
  assert.deepEqual(BUNDLE_ASSET_EXCLUDES.design, ["test"]);
});

test("graphql.js is a packaged-only binary artifact, swapped alongside the binary but never in a from-source dev swap", () => {
  assert.ok(BUNDLE_BINARY_ARTIFACTS.includes("graphql.js"));
  assert.ok(!bundleSwapNames(true).includes("graphql.js"));
  assert.ok(bundleSwapNames(false).includes("graphql.js"));
});

test("build script pre-bundles server/graphql.ts into a standalone graphql.js asset (bun build, non-compile)", () => {
  const build = readFileSync(join(repoRoot, "scripts/build-daemon.mjs"), "utf8");
  assert.match(build, /\["build", "--target", "bun", "--format", "esm", join\(repoRoot, "src\/server\/graphql\.ts"\), "--outfile", join\(outDir, "graphql\.js"\)\]/);
});

test("cli.ts resolves the pre-bundled graphql.js asset when present, falling back to the relative source import from a checkout", () => {
  const cli = readFileSync(join(repoRoot, "src/cli.ts"), "utf8");
  assert.match(cli, /const graphqlAsset = graphqlAssetPath\(\);/);
  assert.match(cli, /graphqlAsset \? pathToFileURL\(graphqlAsset\)\.href : "\.\/server\/graphql\.js"/);
});

test("build script and reload swap read the same constant, no re-listed names", () => {
  const build = readFileSync(join(repoRoot, "scripts/build-daemon.mjs"), "utf8");
  assert.match(build, /import \{ BUNDLE_ASSET_DIRS, BUNDLE_ASSET_EXCLUDES \} from "\.\.\/src\/core\/bundle-assets\.ts"/);
  assert.match(build, /for \(const name of BUNDLE_ASSET_DIRS\)/);
  assert.match(build, /BUNDLE_ASSET_EXCLUDES\[name\]/);
  assert.match(build, /compileBinary\("telegram-bridge", join\(repoRoot, "scripts\/telegram-bridge\.mjs"\), "gaia-telegram-bridge"\)/);

  const http = readFileSync(join(repoRoot, "src/server/http.ts"), "utf8");
  assert.match(http, /const names = bundleSwapNames\(fromSource\)/);
  assert.ok(!/\["web", "setups"/.test(http), "http.ts must not re-list bundle asset names");
});
