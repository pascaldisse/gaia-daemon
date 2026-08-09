import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("compiled design assets omit source-only tests", () => {
  assert.deepEqual(BUNDLE_ASSET_EXCLUDES.design, ["test"]);
});

test("build script and reload swap read the same constant, no re-listed names", () => {
  const build = readFileSync(join(repoRoot, "scripts/build-daemon.mjs"), "utf8");
  assert.match(build, /import \{ BUNDLE_ASSET_DIRS, BUNDLE_ASSET_EXCLUDES \} from "\.\.\/src\/core\/bundle-assets\.ts"/);
  assert.match(build, /for \(const name of BUNDLE_ASSET_DIRS\)/);
  assert.match(build, /BUNDLE_ASSET_EXCLUDES\[name\]/);

  const http = readFileSync(join(repoRoot, "src/server/http.ts"), "utf8");
  assert.match(http, /const names = bundleSwapNames\(fromSource\)/);
  assert.ok(!/\["web", "setups"/.test(http), "http.ts must not re-list bundle asset names");
});
