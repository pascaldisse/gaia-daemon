import { pathToFileURL } from "node:url";
import {
  discoverPluginManifests,
  PLUGIN_MODULE_IMPORT_DEFAULTS,
  readPluginManifests,
  revalidatePluginManifest,
  type PluginPlacement,
  type ValidatedPluginManifest,
} from "./manifest.js";
import { bundledDir, globalPaths } from "../../core/paths.js";

interface InMemoryPluginBuildConfig extends Bun.BuildConfig {
  readonly write: false;
}
type InMemoryPluginBuilder = (config: InMemoryPluginBuildConfig) => Promise<Bun.BuildOutput>;
const buildPluginModule: InMemoryPluginBuilder = Bun.build;

export type PluginImporter<T> = (entrypointPath: string, plugin: ValidatedPluginManifest) => Promise<T>;
/** Registry-provided content identity check; skips module import for a carry-forward. */
export type PluginModuleReuse = (plugin: ValidatedPluginManifest) => boolean;
/** Shared URL construction for source and bundled packages. */
export function pluginModuleUrl(plugin: ValidatedPluginManifest): string {
  const url = pathToFileURL(plugin.entrypointPath);
  url.searchParams.set(PLUGIN_MODULE_IMPORT_DEFAULTS.generationQueryKey, plugin.entrypointDigest);
  return url.href;
}
/** Shared dynamic importer: content fingerprint is the ESM module identity.
 * Bun canonicalizes file URLs before its ESM cache and ignores search params;
 * compile one in-memory ESM payload so its Blob URL carries the same identity. */
export async function importPluginModule(plugin: ValidatedPluginManifest): Promise<unknown> {
  const build = await buildPluginModule({
    entrypoints: [plugin.entrypointPath],
    format: "esm",
    target: "bun",
    write: false,
  });
  if (!build.success) throw new Error(`could not compile plugin ${plugin.manifest.id}: ${build.logs.map((log) => log.message).join("; ")}`);
  const output = build.outputs[0];
  if (!output) throw new Error(`could not compile plugin ${plugin.manifest.id}: no module output`);
  const source = `${await output.text()}\n// ${pluginModuleUrl(plugin)}`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Doctrine ruling (Pascal 09-05, docs/PLUGIN-ADVERSARY-0905.md axis 7+1): pi
// package is THE plugin format; this gaia manifest format is deprecated for
// command/tool/provider contributions (channel-bridge stays first-class, no
// pi analogue — see contracts.ts). One-line warning per load, never fatal:
// existing manifest plugins keep working until "gaia plugin migrate" moves
// them and the kinds are removed (docs/PLUGIN-FORMAT.md timeline).
function warnDeprecatedContributionKinds(plugin: ValidatedPluginManifest): void {
  const deprecated: string[] = [];
  if (plugin.manifest.contributes.commands.length > 0) deprecated.push("commands");
  if (plugin.manifest.contributes.tools.length > 0) deprecated.push("tools");
  if (plugin.manifest.contributes.providers.length > 0) deprecated.push("providers");
  if (deprecated.length === 0) return;
  console.warn(
    `[plugins] ${plugin.manifest.id}: ${deprecated.join("/")} contribution${deprecated.length > 1 ? "s" : ""} use the DEPRECATED gaia manifest format — migrate to a pi package (\`gaia plugin migrate ${plugin.packageRoot}\`). See docs/PLUGIN-FORMAT.md.`,
  );
}

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
  reuse?: PluginModuleReuse,
): Promise<readonly LoadedPlugin<T | undefined>[]> {
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
  const loaded: LoadedPlugin<T | undefined>[] = [];
  for (const plugin of current) {
    warnDeprecatedContributionKinds(plugin);
    loaded.push(Object.freeze({
      manifest: plugin,
      module: reuse?.(plugin) ? undefined : await importer(plugin.entrypointPath, plugin),
    }));
  }
  return Object.freeze(loaded);
}
