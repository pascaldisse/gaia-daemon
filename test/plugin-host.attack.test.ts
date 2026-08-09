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

test("ATTACK: a lease acquired during asynchronous reload prevents its generation swap", async () => {
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let blockBeta = false;
  const host = new PluginHost({
    importer: async (entrypointPath) => {
      if (blockBeta && entrypointPath.includes("beta")) await blocked;
      return {};
    },
  });

  await host.reload([compatible("alpha")]);
  blockBeta = true;
  const reloading = host.reload([compatible("beta")]);
  await Promise.resolve();
  const release = host.acquireTurnLease();
  unblock?.();

  await assert.rejects(reloading, PluginHostError);
  assert.deepEqual(host.current.registered.map((entry) => entry.namespace), ["bundled:alpha"]);
  release();
});
