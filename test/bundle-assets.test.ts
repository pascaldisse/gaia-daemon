import test from "node:test";
import assert from "node:assert/strict";
import { BUNDLE_ASSET_DIRS, BUNDLE_BINARY_ARTIFACTS, bundleSwapNames } from "../src/core/bundle-assets.js";

test("/rebuild swaps every runtime directory that the build snapshots", () => {
  assert.deepEqual(BUNDLE_ASSET_DIRS, ["web", "setups", "design"]);
  assert.deepEqual(bundleSwapNames(true), [...BUNDLE_ASSET_DIRS]);
  assert.deepEqual(bundleSwapNames(false), [...BUNDLE_ASSET_DIRS, ...BUNDLE_BINARY_ARTIFACTS]);
});
