import {
  discoverPluginManifests,
  readPluginManifests,
  revalidatePluginManifest,
  type PluginPlacement,
  type ValidatedPluginManifest,
} from "./manifest.js";

export type PluginImporter<T> = (entrypointPath: string, plugin: ValidatedPluginManifest) => Promise<T>;

export interface LoadedPlugin<T> {
  readonly manifest: ValidatedPluginManifest;
  readonly module: T;
}

/**
 * Manifest-first package load: discover and validate every package (including
 * the opposite placement) before this function calls the injected importer.
 */
export async function loadPlugins<T>(
  pluginsRoot: string,
  placement: PluginPlacement,
  importer: PluginImporter<T>,
): Promise<readonly LoadedPlugin<T>[]> {
  if (typeof importer !== "function") throw new TypeError("plugin importer must be a function");
  const manifestPaths = await discoverPluginManifests(pluginsRoot);
  const inventory = await readPluginManifests(manifestPaths, { pluginsRoot });
  const selected = inventory.filter((plugin) => plugin.manifest.placement === placement);
  const current = await Promise.all(selected.map((plugin) => revalidatePluginManifest(plugin)));
  const loaded: LoadedPlugin<T>[] = [];
  for (const plugin of current) {
    loaded.push(Object.freeze({ manifest: plugin, module: await importer(plugin.entrypointPath, plugin) }));
  }
  return Object.freeze(loaded);
}
