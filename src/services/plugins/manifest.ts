import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MANIFEST_KEYS = new Set(["id", "version", "engine", "placement", "process", "requiredCaps", "contributes"]);
const CONTRIBUTION_KEYS = new Set(["commands", "tools", "channels", "providers"]);
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DECLARATION = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
/** One module identity policy: content changes receive distinct ESM URLs. */
export const PLUGIN_MODULE_IMPORT_DEFAULTS = Object.freeze({
  fingerprintAlgorithm: "sha256",
  generationQueryKey: "gaia-gen",
});

export type PluginPlacement = "daemon" | "runner";
export type PluginContributions = Readonly<Record<"commands" | "tools" | "channels" | "providers", readonly string[]>>;

/** Declarative package metadata. requiredCaps is not an authority grant. */
export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly engine: string;
  readonly placement: PluginPlacement;
  /** Standalone packages are launched outside the daemon process. */
  readonly process?: "standalone";
  readonly requiredCaps: readonly string[];
  readonly contributes: PluginContributions;
}

/** A package whose manifest and conventional index.mjs stayed inside pluginsRoot. */
export interface ValidatedPluginManifest {
  readonly manifestPath: string;
  readonly packageRoot: string;
  readonly pluginsRoot: string;
  readonly entrypointPath: string;
  /** Hash of entrypoint + raw manifest bytes; module identity for a reload generation. */
  readonly entrypointDigest: string;
  readonly manifest: PluginManifest;
  readonly order: number;
}

export interface PluginManifestReadOptions {
  readonly pluginsRoot: string;
  readonly order?: number;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function contained(root: string, candidate: string, manifestPath: string, label: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new PluginManifestError(`${label} must resolve inside its declared root`, manifestPath);
  }
}

function stringField(value: Readonly<Record<string, unknown>>, key: string, manifestPath: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0 || field.trim() !== field) {
    throw new PluginManifestError(`${key} must be a non-empty trimmed string`, manifestPath);
  }
  return field;
}

function declarations(value: unknown, manifestPath: string, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && DECLARATION.test(item))) {
    throw new PluginManifestError(`${label} must be an array of portable identifiers`, manifestPath);
  }
  if (new Set(value).size !== value.length) throw new PluginManifestError(`${label} must not contain duplicates`, manifestPath);
  return Object.freeze([...value]);
}

function entrypointDigest(entrypointBytes: Uint8Array, manifestBytes: Uint8Array): string {
  return createHash(PLUGIN_MODULE_IMPORT_DEFAULTS.fingerprintAlgorithm)
    .update("gaia-plugin-entrypoint\0")
    .update(manifestBytes)
    .update("\0")
    .update(entrypointBytes)
    .digest("hex");
}

/** Validate data only: this function never resolves or imports package code. */
export function validatePluginManifest(value: unknown, manifestPath: string): PluginManifest {
  if (!isPlainRecord(value)) throw new PluginManifestError("manifest must be a plain JSON object", manifestPath);
  const unknown = Object.keys(value).filter((key) => !MANIFEST_KEYS.has(key));
  if (unknown.length > 0) throw new PluginManifestError(`unknown manifest fields: ${unknown.join(", ")}`, manifestPath);

  const id = stringField(value, "id", manifestPath);
  const version = stringField(value, "version", manifestPath);
  const engine = stringField(value, "engine", manifestPath);
  if (!PLUGIN_ID.test(id)) throw new PluginManifestError("id must be a portable plugin identifier", manifestPath);
  if (!SEMVER.test(version)) throw new PluginManifestError("version must be valid SemVer 2.0", manifestPath);
  if (engine.length > 128) throw new PluginManifestError("engine must be at most 128 characters", manifestPath);
  if (value.placement !== "daemon" && value.placement !== "runner") {
    throw new PluginManifestError("placement must be daemon or runner", manifestPath);
  }
  if (value.process !== undefined && value.process !== "standalone") {
    throw new PluginManifestError("process must be standalone when declared", manifestPath);
  }
  if (!Object.hasOwn(value, "requiredCaps")) throw new PluginManifestError("requiredCaps is required", manifestPath);
  const requiredCaps = declarations(value.requiredCaps, manifestPath, "requiredCaps");
  if (!isPlainRecord(value.contributes)) throw new PluginManifestError("contributes must be a plain JSON object", manifestPath);
  const contributionUnknown = Object.keys(value.contributes).filter((key) => !CONTRIBUTION_KEYS.has(key));
  if (contributionUnknown.length > 0) throw new PluginManifestError(`unknown contributes fields: ${contributionUnknown.join(", ")}`, manifestPath);
  const contributes = Object.freeze({
    commands: declarations(value.contributes.commands, manifestPath, "contributes.commands"),
    tools: declarations(value.contributes.tools, manifestPath, "contributes.tools"),
    channels: declarations(value.contributes.channels, manifestPath, "contributes.channels"),
    providers: declarations(value.contributes.providers, manifestPath, "contributes.providers"),
  });
  return Object.freeze({ id, version, engine, placement: value.placement, ...(value.process === "standalone" ? { process: "standalone" as const } : {}), requiredCaps, contributes });
}

/** Read a direct-child package and confine its conventional index.mjs before import. */
export async function readPluginManifest(manifestPath: string, options: PluginManifestReadOptions): Promise<ValidatedPluginManifest> {
  const lexicalRoot = resolve(options.pluginsRoot);
  const lexicalManifest = resolve(manifestPath);
  const lexicalPackage = dirname(lexicalManifest);
  if (basename(lexicalManifest) !== "plugin.json" || dirname(lexicalPackage) !== lexicalRoot) {
    throw new PluginManifestError("plugin.json must be in a direct child of the plugins root", manifestPath);
  }

  let pluginsRoot: string;
  let canonicalManifest: string;
  try {
    pluginsRoot = await realpath(lexicalRoot);
    canonicalManifest = await realpath(lexicalManifest);
  } catch (error) {
    throw new PluginManifestError("could not resolve plugin package", manifestPath, { cause: error });
  }
  const packageRoot = dirname(canonicalManifest);
  contained(pluginsRoot, packageRoot, manifestPath, "plugin package");
  if (dirname(packageRoot) !== pluginsRoot || basename(packageRoot) !== basename(lexicalPackage) || canonicalManifest !== join(packageRoot, "plugin.json")) {
    throw new PluginManifestError("plugin package path, case, or manifest symlink is invalid", manifestPath);
  }

  let parsed: unknown;
  let manifestBytes: Uint8Array;
  try {
    const handle = await open(canonicalManifest, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new PluginManifestError("plugin.json must be a regular file", manifestPath);
      manifestBytes = await handle.readFile();
      parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof PluginManifestError) throw error;
    throw new PluginManifestError("plugin.json is not valid JSON", manifestPath, { cause: error });
  }
  const manifest = validatePluginManifest(parsed, manifestPath);

  const lexicalEntrypoint = join(lexicalPackage, "index.mjs");
  let entrypointPath: string;
  let entrypointBytes: Uint8Array;
  try {
    entrypointPath = await realpath(lexicalEntrypoint);
    if (!(await stat(entrypointPath)).isFile()) throw new Error("entrypoint is not a file");
    entrypointBytes = await readFile(entrypointPath);
  } catch (error) {
    throw new PluginManifestError("plugin package must contain index.mjs", manifestPath, { cause: error });
  }
  contained(packageRoot, entrypointPath, manifestPath, "entrypoint");
  return Object.freeze({
    manifestPath: canonicalManifest,
    packageRoot,
    pluginsRoot,
    entrypointPath,
    entrypointDigest: entrypointDigest(entrypointBytes, manifestBytes),
    manifest,
    order: options.order ?? 0,
  });
}

/** Complete inventory preflight. Duplicate IDs reject before a loader can import code. */
export async function readPluginManifests(manifestPaths: readonly string[], options: Omit<PluginManifestReadOptions, "order">): Promise<readonly ValidatedPluginManifest[]> {
  const plugins = await Promise.all(manifestPaths.map((path, order) => readPluginManifest(path, { ...options, order })));
  const ids = new Map<string, string>();
  for (const plugin of plugins) {
    const previous = ids.get(plugin.manifest.id);
    if (previous) throw new PluginManifestError(`duplicate plugin id ${plugin.manifest.id}: ${previous} and ${plugin.manifestPath}`, plugin.manifestPath);
    ids.set(plugin.manifest.id, plugin.manifestPath);
  }
  return Object.freeze(plugins);
}

/** Re-read immediately before import so a package swap cannot turn validation into a stale grant. */
export async function revalidatePluginManifest(previous: ValidatedPluginManifest): Promise<ValidatedPluginManifest> {
  const current = await readPluginManifest(previous.manifestPath, { pluginsRoot: previous.pluginsRoot, order: previous.order });
  if (current.packageRoot !== previous.packageRoot || current.entrypointPath !== previous.entrypointPath || current.entrypointDigest !== previous.entrypointDigest || JSON.stringify(current.manifest) !== JSON.stringify(previous.manifest)) {
    throw new PluginManifestError("plugin package changed after inventory validation", previous.manifestPath);
  }
  return current;
}

/** Direct children only; lexical sort makes a valid import order deterministic. */
export async function discoverPluginManifests(pluginsRoot: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(pluginsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(pluginsRoot, entry.name, "plugin.json"))
    .sort();
  // A root can also contain non-package support directories (notably the
  // legacy runner folder). Every manifest that exists remains in the complete
  // validate-before-import inventory; a directory without one is not a package.
  const present = await Promise.all(candidates.map(async (path) => {
    try {
      await stat(path);
      return path;
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }));
  return Object.freeze(present.filter((path): path is string => path !== undefined));
}
