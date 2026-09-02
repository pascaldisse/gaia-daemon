import {
  discoverPluginManifests,
  readPluginManifests,
  revalidatePluginManifest,
  type PluginPlacement,
  type ValidatedPluginManifest,
} from "./manifest.js";
import { bundledDir, globalPaths } from "../../core/paths.js";

export type PluginImporter<T> = (entrypointPath: string, plugin: ValidatedPluginManifest) => Promise<T>;

export interface PluginDiscoveryPaths {
  commandPluginsDir(): string;
}
/** Bundled packages precede machine-local packages; both remain injectable for tests. */
export function pluginDiscoveryRoots(options: {
  readonly bundled?: string;
  readonly paths?: PluginDiscoveryPaths;
} = {}): readonly string[] {
  return Object.freeze([options.bundled ?? bundledDir("plugins"), (options.paths ?? globalPaths).commandPluginsDir()]);
}
export interface LoadedPlugin<T> {
  readonly manifest: ValidatedPluginManifest;
  readonly module: T;
}

/**
 * Manifest-first package load: discover and validate every package (including
 * the opposite placement) before this function calls the injected importer.
 */
export async function loadPlugins<T>(
  pluginsRoot: string | readonly string[],
  placement: PluginPlacement,
  importer: PluginImporter<T>,
): Promise<readonly LoadedPlugin<T>[]> {
  if (typeof importer !== "function") throw new TypeError("plugin importer must be a function");
  const roots = typeof pluginsRoot === "string" ? [pluginsRoot] : pluginsRoot;
  const inventories = await Promise.all(roots.map(async (root) =>
    readPluginManifests(await discoverPluginManifests(root), { pluginsRoot: root }),
  ));
  const inventory = inventories.flat();
  const ids = new Set<string>();
  for (const plugin of inventory) {
    if (ids.has(plugin.manifest.id)) throw new Error(`duplicate plugin id ${plugin.manifest.id}`);
    ids.add(plugin.manifest.id);
  }
  const selected = inventory.filter((plugin) => plugin.manifest.placement === placement);
  const current = await Promise.all(selected.map((plugin) => revalidatePluginManifest(plugin)));
  const loaded: LoadedPlugin<T>[] = [];
  for (const plugin of current) {
    loaded.push(Object.freeze({ manifest: plugin, module: await importer(plugin.entrypointPath, plugin) }));
  }
  return Object.freeze(loaded);
}
