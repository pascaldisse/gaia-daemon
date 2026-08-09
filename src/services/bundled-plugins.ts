import { bundledDir } from "../core/paths.js";
import {
  discoverPluginManifests,
  readPluginManifest,
  type ValidatedPluginManifest,
} from "./plugin-manifest.js";

/** The compiled install's add-on snapshot. Discovery never consults user paths. */
export function bundledAddonsRoot(): string {
  return bundledDir("addons");
}

/** Stable identifier for metadata only; this does not load a plugin. */
export function bundledPluginNamespace(name: string): string {
  return `bundled:${name}`;
}

export interface BundledPluginAvailable {
  readonly status: "available";
  readonly namespace: string;
  readonly plugin: ValidatedPluginManifest;
}

export interface BundledPluginInvalid {
  readonly status: "invalid";
  readonly manifestPath: string;
  readonly reason: string;
}

/** Manifest-only add-on inventory. Entrypoints are deliberately never imported. */
export async function listBundledPlugins(daemonVersion: string): Promise<readonly (BundledPluginAvailable | BundledPluginInvalid)[]> {
  const manifestPaths = await discoverPluginManifests(bundledAddonsRoot());
  return Object.freeze(await Promise.all(manifestPaths.map(async (manifestPath) => {
    try {
      const plugin = await readPluginManifest(manifestPath, { addonsRoot: bundledAddonsRoot(), daemonVersion });
      return Object.freeze({
        status: "available" as const,
        namespace: bundledPluginNamespace(plugin.manifest.name),
        plugin,
      });
    } catch (error) {
      return Object.freeze({
        status: "invalid" as const,
        manifestPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  })));
}
