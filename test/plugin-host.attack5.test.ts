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

test("ATTACK: shutdown closes before an async disposer yields and a lease-rejected shutdown remains retryable", async () => {
  const disposals: string[] = [];
  let unblockDispose: (() => void) | undefined;
  const disposalBlocked = new Promise<void>((resolve) => { unblockDispose = resolve; });
  const host = new PluginHost({
    importer: async (_path, manifest) => ({
      register: () => ({
        dispose: async () => {
          disposals.push(`start:${manifest.manifest.name}`);
          if (manifest.manifest.name === "beta") await disposalBlocked;
          disposals.push(`done:${manifest.manifest.name}`);
        },
      }),
    }),
  });

  await host.reload([compatible("alpha"), compatible("beta")]);
  const release = host.acquireTurnLease();
  await assert.rejects(host.shutdown(), PluginHostError);
  release();

  const shuttingDown = host.shutdown();
  await Promise.resolve();
  assert.throws(() => host.acquireTurnLease(), PluginHostError);
  await assert.rejects(host.reload([compatible("gamma")]), PluginHostError);

  unblockDispose?.();
  await shuttingDown;
  assert.deepEqual(disposals, ["start:beta", "done:beta", "start:alpha", "done:alpha"]);
  assert.deepEqual(host.current.registered, []);
});
