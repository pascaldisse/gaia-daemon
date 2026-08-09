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

/** Metadata namespace; separate from legacy command and runner plugin key spaces. */
export function bundledPluginNamespace(name: string): string {
  return `bundled:${name}`;
}

export interface BundledPluginCompatible {
  /** Manifest compatibility only: code has not been imported or registered. */
  readonly status: "compatible";
  readonly namespace: string;
  readonly plugin: ValidatedPluginManifest;
}

export interface BundledPluginUnavailable {
  readonly status: "unavailable";
  readonly namespace: string;
  readonly reason: string;
  readonly plugin: ValidatedPluginManifest;
}

export interface BundledPluginInvalid {
  readonly status: "invalid";
  readonly manifestPath: string;
  readonly reason: string;
}

export type BundledPluginInventoryItem = BundledPluginCompatible | BundledPluginUnavailable | BundledPluginInvalid;

/** Manifest-only bundled inventory. Invalid packages are isolated; entrypoints are never imported. */
export async function listBundledPlugins(daemonVersion: string): Promise<readonly BundledPluginInventoryItem[]> {
  const addonsRoot = bundledAddonsRoot();
  const manifestPaths = await discoverPluginManifests(addonsRoot);
  return Object.freeze(await Promise.all(manifestPaths.map(async (manifestPath): Promise<BundledPluginInventoryItem> => {
    try {
      const plugin = await readPluginManifest(manifestPath, { addonsRoot, daemonVersion });
      const namespace = bundledPluginNamespace(plugin.manifest.name);
      if (!plugin.engineCompatibility.compatible) {
        return Object.freeze({
          status: "unavailable" as const,
          namespace,
          reason: plugin.engineCompatibility.reason ?? "incompatible daemon engine",
          plugin,
        });
      }
      return Object.freeze({ status: "compatible" as const, namespace, plugin });
    } catch (error) {
      return Object.freeze({
        status: "invalid" as const,
        manifestPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  })));
}
