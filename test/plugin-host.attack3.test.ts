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

// ATTACK: shutdown awaits disposer work but does not own the lifecycle lock.
// A reload can therefore install a new generation while teardown still runs.
test("ATTACK: reload is refused until an in-progress shutdown has disposed the old generation", async () => {
  let unblockDispose: (() => void) | undefined;
  const disposalBlocked = new Promise<void>((resolve) => { unblockDispose = resolve; });
  const host = new PluginHost({
    importer: async () => ({
      register: () => ({ dispose: async () => { await disposalBlocked; } }),
    }),
  });

  await host.reload([compatible("alpha")]);
  const shuttingDown = host.shutdown();
  await Promise.resolve();

  try {
    await assert.rejects(host.reload([compatible("beta")]), PluginHostError);
  } finally {
    unblockDispose?.();
    await shuttingDown;
  }
  assert.deepEqual(host.current.registered, []);
});
