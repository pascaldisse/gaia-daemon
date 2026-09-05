// `gaia plugin search|info` — reads the GAIA Plugin Store registry
// (registry/index.json shape, see ~/projects/gaia-plugins). Never hardcoded:
// URL is a param (default GAIA_PLUGIN_REGISTRY env, else the live store); the
// cache dir is a param (default globalPaths.pluginRegistryCacheDir()).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../core/env.js";
import { globalPaths } from "../../core/paths.js";

export const DEFAULT_PLUGIN_REGISTRY_URL = "https://paloptic.com/gaia-plugins/registry/index.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = "index.json";
const CACHE_META_FILE = "fetched-at";

export interface PluginRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly version: string;
  readonly tags: readonly string[];
  readonly author: string;
  readonly homepage: string;
  readonly verified: boolean;
  readonly added: string;
}

export interface RegistryClientOptions {
  readonly registryUrl?: string;
  readonly cacheDir?: string;
  /** Force a network refetch, bypassing a fresh cache. */
  readonly noCache?: boolean;
}

function registryUrlFrom(options: RegistryClientOptions): string {
  return options.registryUrl ?? env("GAIA_PLUGIN_REGISTRY") ?? DEFAULT_PLUGIN_REGISTRY_URL;
}

function cacheDirFrom(options: RegistryClientOptions): string {
  return options.cacheDir ?? globalPaths.pluginRegistryCacheDir();
}

function isEntry(value: unknown): value is PluginRegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.name === "string" && typeof record.source === "string" && typeof record.version === "string";
}

async function readCache(cacheDir: string): Promise<readonly PluginRegistryEntry[] | undefined> {
  try {
    const fetchedAtRaw = await readFile(join(cacheDir, CACHE_META_FILE), "utf8");
    const fetchedAt = Number.parseInt(fetchedAtRaw, 10);
    if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > CACHE_TTL_MS) return undefined;
    const raw = await readFile(join(cacheDir, CACHE_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isEntry)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeCache(cacheDir: string, entries: readonly PluginRegistryEntry[]): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, CACHE_FILE), JSON.stringify(entries), "utf8");
  await writeFile(join(cacheDir, CACHE_META_FILE), String(Date.now()), "utf8");
}

/** Fetch the registry (24h cache under cacheDir, param — never hardcoded). */
export async function fetchPluginRegistry(options: RegistryClientOptions = {}): Promise<readonly PluginRegistryEntry[]> {
  const cacheDir = cacheDirFrom(options);
  if (!options.noCache) {
    const cached = await readCache(cacheDir);
    if (cached) return cached;
  }
  const url = registryUrlFrom(options);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`gaia plugin: registry fetch failed (${response.status} ${response.statusText}) from ${url}`);
  const parsed: unknown = await response.json();
  if (!Array.isArray(parsed) || !parsed.every(isEntry)) throw new Error(`gaia plugin: registry at ${url} is not a valid entry list`);
  await writeCache(cacheDir, parsed);
  return parsed;
}

function matchesQuery(entry: PluginRegistryEntry, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    entry.id.toLowerCase().includes(needle) ||
    entry.name.toLowerCase().includes(needle) ||
    entry.description.toLowerCase().includes(needle) ||
    entry.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}

export async function searchPluginRegistry(query: string, options: RegistryClientOptions = {}): Promise<readonly PluginRegistryEntry[]> {
  const entries = await fetchPluginRegistry(options);
  if (!query.trim()) return entries;
  return entries.filter((entry) => matchesQuery(entry, query));
}

export async function lookupPluginRegistryEntry(idOrSource: string, options: RegistryClientOptions = {}): Promise<PluginRegistryEntry | undefined> {
  const entries = await fetchPluginRegistry(options);
  return entries.find((entry) => entry.id === idOrSource || entry.source === idOrSource);
}
