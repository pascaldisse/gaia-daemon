import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MANIFEST_KEYS = new Set([
  "schema",
  "name",
  "version",
  "engine",
  "entrypoint",
  "permissions",
  "requiredCaps",
]);
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9][a-z0-9_-]*)*$/;

export const PLUGIN_MANIFEST_SCHEMA = 1;

export interface PluginManifest {
  readonly schema: typeof PLUGIN_MANIFEST_SCHEMA;
  readonly name: string;
  readonly version: string;
  readonly engine: string;
  readonly entrypoint: string;
  readonly permissions: readonly string[];
  readonly requiredCaps: readonly string[];
}

export interface ValidatedPluginManifest {
  readonly manifestPath: string;
  readonly packageRoot: string;
  readonly entrypointPath: string;
  readonly manifest: PluginManifest;
  readonly order: number;
}

export class PluginManifestError extends Error {
  readonly manifestPath: string;

  constructor(message: string, manifestPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginManifestError";
    this.manifestPath = manifestPath;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new PluginManifestError(`${key} must be a non-empty trimmed string`, path);
  }
  return value;
}

function identifierArray(record: Readonly<Record<string, unknown>>, key: string, path: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && IDENTIFIER.test(item))) {
    throw new PluginManifestError(`${key} must be an array of valid identifiers`, path);
  }
  if (new Set(value).size !== value.length) {
    throw new PluginManifestError(`${key} must not contain duplicates`, path);
  }
  return Object.freeze([...value]);
}

function assertContained(root: string, candidate: string, manifestPath: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new PluginManifestError("entrypoint must resolve to a file inside the plugin package", manifestPath);
  }
}

/** Validate manifest data before resolving or importing its entrypoint. */
export function validatePluginManifest(value: unknown, manifestPath: string): PluginManifest {
  if (!isRecord(value)) throw new PluginManifestError("manifest must be a JSON object", manifestPath);
  const unknown = Object.keys(value).filter((key) => !MANIFEST_KEYS.has(key));
  if (unknown.length > 0) throw new PluginManifestError(`unknown manifest fields: ${unknown.join(", ")}`, manifestPath);
  if (value.schema !== PLUGIN_MANIFEST_SCHEMA) {
    throw new PluginManifestError(`schema must be ${PLUGIN_MANIFEST_SCHEMA}`, manifestPath);
  }

  const name = stringField(value, "name", manifestPath);
  const version = stringField(value, "version", manifestPath);
  const engine = stringField(value, "engine", manifestPath);
  const entrypoint = stringField(value, "entrypoint", manifestPath);
  if (!PACKAGE_NAME.test(name)) throw new PluginManifestError("name is not a valid plugin package name", manifestPath);
  if (!SEMVER.test(version)) throw new PluginManifestError("version must be valid semver", manifestPath);
  if (engine.length > 128) throw new PluginManifestError("engine is too long", manifestPath);
  if (!entrypoint.startsWith("./") || isAbsolute(entrypoint) || entrypoint.includes("\0")) {
    throw new PluginManifestError("entrypoint must be a relative ./ path", manifestPath);
  }

  return Object.freeze({
    schema: PLUGIN_MANIFEST_SCHEMA,
    name,
    version,
    engine,
    entrypoint,
    permissions: identifierArray(value, "permissions", manifestPath),
    requiredCaps: identifierArray(value, "requiredCaps", manifestPath),
  });
}

/** Read and resolve one manifest without executing its plugin entrypoint. */
export async function readPluginManifest(manifestPath: string, order = 0): Promise<ValidatedPluginManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new PluginManifestError("manifest is not valid JSON", manifestPath, { cause: error });
  }
  const manifest = validatePluginManifest(value, manifestPath);
  const lexicalRoot = resolve(dirname(manifestPath));
  const lexicalEntrypoint = resolve(lexicalRoot, manifest.entrypoint);
  assertContained(lexicalRoot, lexicalEntrypoint, manifestPath);

  let packageRoot: string;
  let entrypointPath: string;
  try {
    packageRoot = await realpath(lexicalRoot);
    entrypointPath = await realpath(lexicalEntrypoint);
    if (!(await stat(entrypointPath)).isFile()) throw new Error("entrypoint is not a file");
  } catch (error) {
    throw new PluginManifestError("entrypoint must name an existing file", manifestPath, { cause: error });
  }
  assertContained(packageRoot, entrypointPath, manifestPath);
  return Object.freeze({ manifestPath: resolve(manifestPath), packageRoot, entrypointPath, manifest, order });
}

/** Validate every ordered manifest, including duplicate-name preflight, before any import. */
export async function readPluginManifests(manifestPaths: readonly string[]): Promise<readonly ValidatedPluginManifest[]> {
  const packages: ValidatedPluginManifest[] = [];
  const names = new Set<string>();
  for (let order = 0; order < manifestPaths.length; order += 1) {
    const path = manifestPaths[order];
    if (path === undefined) continue;
    const plugin = await readPluginManifest(path, order);
    if (names.has(plugin.manifest.name)) throw new PluginManifestError(`duplicate plugin name: ${plugin.manifest.name}`, plugin.manifestPath);
    names.add(plugin.manifest.name);
    packages.push(plugin);
  }
  return Object.freeze(packages);
}

/** Find package manifests in deterministic directory-name order; no package code is imported. */
export async function discoverPluginManifests(addonsRoot: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(addonsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return Object.freeze(entries.filter((entry) => entry.isDirectory()).map((entry) => join(addonsRoot, entry.name, "plugin.json")).sort((a, b) => a.localeCompare(b)));
}
