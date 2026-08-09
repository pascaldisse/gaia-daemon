import assert from "node:assert/strict";
import test from "node:test";
import { PluginHost, PluginHostError } from "../src/services/plugin-host.js";
import type { BundledPluginInventoryItem } from "../src/services/bundled-plugins.js";
import type { ValidatedPluginManifest } from "../src/services/plugin-manifest.js";

function compatible(name: string): BundledPluginInventoryItem {
  const packageRoot = `/bundle/addons/${name}`;
  const plugin: ValidatedPluginManifest = {
    manifestPath: `${packageRoot}/plugin.json`,
    packageRoot,
    entrypointPath: `${packageRoot}/index.mjs`,
    manifest: {
      schema: 1,
      name,
      version: "1.0.0",
      engine: "gaia-daemon@^1.0.0",
      entrypoint: "index.mjs",
      permissions: [],
      requiredCaps: [],
    },
    engineCompatibility: { compatible: true },
    order: 0,
  };
  return { status: "compatible", namespace: `bundled:${name}`, plugin };
}

// ATTACK 1: shutdown claims to close the host permanently, but leases can still
// be acquired afterwards. A closed host must not hand out turn leases over a
// generation it has already torn down.
test("ATTACK: acquireTurnLease is refused after shutdown", async () => {
  const host = new PluginHost({ importer: async () => ({ register: () => ({}) }) });
  await host.reload([compatible("alpha")]);
  await host.shutdown();
  assert.throws(() => host.acquireTurnLease(), PluginHostError);
});

// ATTACK 2: shutdown must be terminal AND idempotent. A lease taken after close
// makes a second shutdown throw, so teardown is neither.
test("ATTACK: shutdown stays idempotent after a post-close lease", async () => {
  const host = new PluginHost({ importer: async () => ({ register: () => ({}) }) });
  await host.reload([compatible("alpha")]);
  await host.shutdown();
  try {
    host.acquireTurnLease();
  } catch {
    // refusal is the desired behaviour; nothing to hold
  }
  await host.shutdown();
  assert.equal(host.activeTurnLeases, 0);
});
