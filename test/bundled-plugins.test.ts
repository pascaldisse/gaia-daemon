import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { bundledDir } from "../src/core/paths.js";
import { pluginDiscoveryRoots } from "../src/services/plugins/loader.js";
import { discoverPluginManifests, readPluginManifests } from "../src/services/plugins/manifest.js";

test("every bundled plugin package has a valid manifest before registry import", async () => {
  const roots = [bundledDir("plugins"), bundledDir("addons")];
  const inventories = await Promise.all(roots.map(async (pluginsRoot) =>
    readPluginManifests(await discoverPluginManifests(pluginsRoot), { pluginsRoot }),
  ));
  assert.deepEqual(inventories[0]?.map((plugin) => plugin.manifest.id), ["gaia.defaults", "gaia.fugu", "gaia.rpg-engine", "gaia.rpg"]);
  assert.equal(inventories[1]?.[0]?.manifest.process, "standalone");
});

test("bundled and global discovery roots are injectable", () => {
  const paths = { commandPluginsDir: () => "/global/plugins" };
  assert.deepEqual(pluginDiscoveryRoots({ bundled: "/bundle/plugins", paths }), ["/bundle/plugins", "/global/plugins"]);
  assert.equal(join("plugins", "defaults", "plugin.json"), "plugins/defaults/plugin.json");
});
