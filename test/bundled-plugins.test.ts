import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { CapabilityBroker } from "../src/services/capabilities/broker.js";
import { PluginRegistry } from "../src/services/plugins/registry.js";
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


test("bundled daemon packages stage through the injected registry", async () => {
  const registry = new PluginRegistry({
    pluginsRoot: bundledDir("plugins"),
    placement: "daemon",
    importer: (entrypoint) => import(pathToFileURL(entrypoint).href),
    capabilityBroker: new CapabilityBroker({ grantSource: () => undefined, trustSource: () => false }),
  });
  const staged = await registry.stageReload();
  assert.equal(staged.status, "staged");
  if (staged.status === "staged") assert.deepEqual(staged.generation.plugins.map((plugin) => plugin.id), ["gaia.defaults", "gaia.rpg"]);
});
test("every bundled manifest declares callable command contributions", async () => {
  const roots = [
    { root: bundledDir("plugins"), placement: "daemon" as const },
    { root: bundledDir("plugins"), placement: "runner" as const },
    { root: bundledDir("addons"), placement: "daemon" as const },
  ];
  for (const { root, placement } of roots) {
    const registry = new PluginRegistry({
      pluginsRoot: root,
      placement,
      importer: (entrypoint) => import(pathToFileURL(entrypoint).href),
      capabilityBroker: new CapabilityBroker({ grantSource: () => undefined, trustSource: () => false }),
    });
    const staged = await registry.stageReload();
    assert.equal(staged.status, "staged");
    if (staged.status !== "staged") continue;
    assert.ok(staged.generation.plugins.length > 0);
    assert.ok(staged.generation.plugins.every((plugin) => plugin.contributes.commands.length > 0));
    assert.equal(await registry.applyTurnBoundary(), true);
    for (const command of registry.commandContributions()) {
      const result = await registry.invokeCommand(command.pluginId, command.name, { workspaceId: "workspace", roomId: "room", agentId: "agent" }, {
        args: [],
        pluginContext: { homedir: "/home/test", workspaceId: "workspace", roomId: "room", agentId: "agent", workspaceRoot: "/workspace", agents: [], command: command.name },
      });
      assert.equal(typeof result, "object");
    }
  }
});
