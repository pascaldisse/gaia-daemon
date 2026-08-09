import { Buffer } from "node:buffer";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
const ENGINE_PREFIX = "gaia-daemon@";
const IDENTIFIER = /^[0-9A-Za-z-]+$/;
const NUMERIC_IDENTIFIER = /^\d+$/;
const VERSION_NUMBER = /^(?:0|[1-9]\d*)$/;
const ENTRYPOINT_EXTENSIONS = new Set([".js", ".mjs", ".ts"]);
const RESERVED_PLUGIN_NAMES = new Set(["builtin", "core", "system"]);
const KNOWN_PERMISSIONS = new Set(["network.http", "plugin.state", "process.wrap", "room.message"]);
const KNOWN_CAPABILITIES = new Set(["room.message", "shell.exec"]);

export const PLUGIN_MANIFEST_SCHEMA = 1;
export const DEFAULT_MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
export const DEFAULT_MAX_PLUGIN_MANIFEST_DEPTH = 16;

export interface PluginManifest {
  readonly schema: typeof PLUGIN_MANIFEST_SCHEMA;
  readonly name: string;
  readonly version: string;
  readonly engine: string;
  readonly entrypoint: string;
  /** Declarations only. They never grant OS access, trust, or sandbox changes. */
  readonly permissions: readonly string[];
  /** Declarations only. A future host must still authorize every operation. */
  readonly requiredCaps: readonly string[];
}

export interface PluginEngineCompatibility {
  readonly compatible: boolean;
  readonly reason?: string;
}

export interface ValidatedPluginManifest {
  readonly manifestPath: string;
  readonly packageRoot: string;
  /** Canonical candidate path only; the loader must revalidate immediately before import. */
  readonly entrypointPath: string;
  readonly manifest: PluginManifest;
  readonly engineCompatibility: PluginEngineCompatibility;
  readonly order: number;
}

export interface PluginManifestReadOptions {
  /** Every package must be exactly one directory below this root. */
  readonly addonsRoot: string;
  readonly daemonVersion: string;
  readonly order?: number;
  /** Callers may tighten, never raise, the fail-closed limits. */
  readonly maxManifestBytes?: number;
  readonly maxManifestDepth?: number;
}

export class PluginManifestError extends Error {
  readonly manifestPath: string;

  constructor(message: string, manifestPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginManifestError";
    this.manifestPath = manifestPath;
  }
}

interface SemVer {
  /** Decimal strings: SemVer numeric identifiers are intentionally unbounded. */
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: readonly string[];
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

function declaredIdentifiers(
  record: Readonly<Record<string, unknown>>,
  key: string,
  allowed: ReadonlySet<string>,
  path: string,
): readonly string[] {
  const value = key in record ? record[key] : [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && allowed.has(item))) {
    throw new PluginManifestError(`${key} contains an unknown or reserved identifier`, path);
  }
  if (new Set(value).size !== value.length) throw new PluginManifestError(`${key} must not contain duplicates`, path);
  return Object.freeze([...value]);
}

function parseSemVer(value: string): SemVer | undefined {
  const plus = value.split("+");
  if (plus.length > 2) return undefined;
  const [versionAndPrerelease, build] = plus;
  if (versionAndPrerelease === undefined || (build !== undefined && !validIdentifiers(build, false))) return undefined;
  const dash = versionAndPrerelease.indexOf("-");
  const core = dash === -1 ? versionAndPrerelease : versionAndPrerelease.slice(0, dash);
  const prereleaseSource = dash === -1 ? undefined : versionAndPrerelease.slice(dash + 1);
  const parts = core.split(".");
  if (parts.length !== 3 || !parts.every((part) => VERSION_NUMBER.test(part))) return undefined;
  if (prereleaseSource !== undefined && !validIdentifiers(prereleaseSource, true)) return undefined;
  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return Object.freeze({ major, minor, patch, prerelease: Object.freeze(prereleaseSource?.split(".") ?? []) });
}

function validIdentifiers(source: string, forbidNumericLeadingZero: boolean): boolean {
  const identifiers = source.split(".");
  return identifiers.length > 0 && identifiers.every((identifier) =>
    identifier.length > 0
    && IDENTIFIER.test(identifier)
    && (!forbidNumericLeadingZero || !NUMERIC_IDENTIFIER.test(identifier) || VERSION_NUMBER.test(identifier)),
  );
}

function compareDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function incrementDecimal(value: string): string {
  const digits = value.split("");
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = digits[index];
    if (digit === undefined) continue;
    if (digit !== "9") {
      digits[index] = String(Number(digit) + 1);
      return digits.join("");
    }
    digits[index] = "0";
  }
  return `1${digits.join("")}`;
}

function sameCore(left: SemVer, right: SemVer): boolean {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const comparison = compareDecimal(left[key], right[key]);
    if (comparison !== 0) return comparison;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = NUMERIC_IDENTIFIER.test(a);
    const bNumeric = NUMERIC_IDENTIFIER.test(b);
    if (aNumeric && bNumeric) return compareDecimal(a, b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function upperBoundFor(operator: "^" | "~", target: SemVer): SemVer {
  if (operator === "~") return { major: target.major, minor: incrementDecimal(target.minor), patch: "0", prerelease: [] };
  if (target.major !== "0") return { major: incrementDecimal(target.major), minor: "0", patch: "0", prerelease: [] };
  if (target.minor !== "0") return { major: "0", minor: incrementDecimal(target.minor), patch: "0", prerelease: [] };
  return { major: "0", minor: "0", patch: incrementDecimal(target.patch), prerelease: [] };
}

/** Evaluate the deliberately small, explicit engine grammar: *, exact, comparator, ^, or ~ plus SemVer. */
export function evaluatePluginEngine(engine: string, daemonVersion: string): PluginEngineCompatibility {
  const daemon = parseSemVer(daemonVersion);
  if (!daemon) throw new PluginManifestError("daemon version is not valid SemVer", "<daemon>");
  if (!engine.startsWith(ENGINE_PREFIX)) return { compatible: false, reason: `engine must start with ${ENGINE_PREFIX}` };
  const range = engine.slice(ENGINE_PREFIX.length);
  if (range === "*") {
    return daemon.prerelease.length === 0
      ? { compatible: true }
      : { compatible: false, reason: `engine wildcard excludes daemon prerelease ${daemonVersion}` };
  }
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(range);
  const operator = match?.[1] ?? "=";
  const target = match?.[2] === undefined ? undefined : parseSemVer(match[2]);
  if (!target) return { compatible: false, reason: "engine range is not supported SemVer" };
  // SemVer ranges exclude prereleases unless the comparator itself names a
  // prerelease with the same major/minor/patch tuple.
  if (daemon.prerelease.length > 0 && (target.prerelease.length === 0 || !sameCore(daemon, target))) {
    return { compatible: false, reason: `requires ${engine}; daemon prerelease ${daemonVersion} is excluded` };
  }
  const compared = compareSemVer(daemon, target);
  const compatible = operator === ">=" ? compared >= 0
    : operator === "<=" ? compared <= 0
      : operator === ">" ? compared > 0
        : operator === "<" ? compared < 0
          : operator === "^" || operator === "~"
            ? compared >= 0 && compareSemVer(daemon, upperBoundFor(operator, target)) < 0
            : compared === 0;
  return compatible ? { compatible: true } : { compatible: false, reason: `requires ${engine}; daemon is ${daemonVersion}` };
}

function assertEntrypointSyntax(entrypoint: string, manifestPath: string): void {
  if (!entrypoint.startsWith("./") || isAbsolute(entrypoint) || entrypoint.includes("\0") || entrypoint.includes("\\")) {
    throw new PluginManifestError("entrypoint must be a portable relative ./ path", manifestPath);
  }
  const segments = entrypoint.slice(2).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || !/^[0-9A-Za-z._-]+$/.test(segment))) {
    throw new PluginManifestError("entrypoint contains a forbidden path segment", manifestPath);
  }
  if (!ENTRYPOINT_EXTENSIONS.has(extname(entrypoint))) {
    throw new PluginManifestError("entrypoint extension must be .js, .mjs, or .ts", manifestPath);
  }
}

function assertContained(root: string, candidate: string, manifestPath: string, label: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new PluginManifestError(`${label} must resolve inside its declared root`, manifestPath);
  }
}

function assertDepth(value: unknown, maximum: number, manifestPath: string): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (current.depth > maximum) throw new PluginManifestError("manifest exceeds maximum JSON depth", manifestPath);
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

async function readBoundedManifest(path: string, maximum: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new PluginManifestError("plugin.json must be a regular file", path);
    // Never call readFile after a size check: a concurrent append could make
    // that allocation unbounded. This buffer is the allocation ceiling even
    // when the inode changes size between stat and read.
    const buffer = Buffer.allocUnsafe(maximum + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximum) throw new PluginManifestError("plugin.json exceeds maximum byte size", path);
    return buffer.toString("utf8", 0, offset);
  } finally {
    await handle.close();
  }
}

/** Parse a manifest. Declarations are vocabulary, never authority grants. */
export function validatePluginManifest(value: unknown, manifestPath: string): PluginManifest {
  if (!isRecord(value)) throw new PluginManifestError("manifest must be a JSON object", manifestPath);
  const unknown = Object.keys(value).filter((key) => !MANIFEST_KEYS.has(key));
  if (unknown.length > 0) throw new PluginManifestError(`unknown manifest fields: ${unknown.join(", ")}`, manifestPath);
  if (value.schema !== PLUGIN_MANIFEST_SCHEMA) throw new PluginManifestError(`schema must be ${PLUGIN_MANIFEST_SCHEMA}`, manifestPath);

  const name = stringField(value, "name", manifestPath);
  const version = stringField(value, "version", manifestPath);
  const engine = stringField(value, "engine", manifestPath);
  const entrypoint = stringField(value, "entrypoint", manifestPath);
  if (!PACKAGE_NAME.test(name) || RESERVED_PLUGIN_NAMES.has(name)) throw new PluginManifestError("name is invalid or reserved", manifestPath);
  if (!parseSemVer(version)) throw new PluginManifestError("version must be valid SemVer 2.0", manifestPath);
  if (engine.length > 128 || !engine.startsWith(ENGINE_PREFIX) || evaluatePluginEngine(engine, "0.0.0").reason === "engine range is not supported SemVer") {
    throw new PluginManifestError("engine must use a supported gaia-daemon@ SemVer range", manifestPath);
  }
  assertEntrypointSyntax(entrypoint, manifestPath);

  return Object.freeze({
    schema: PLUGIN_MANIFEST_SCHEMA,
    name,
    version,
    engine,
    entrypoint,
    permissions: declaredIdentifiers(value, "permissions", KNOWN_PERMISSIONS, manifestPath),
    requiredCaps: declaredIdentifiers(value, "requiredCaps", KNOWN_CAPABILITIES, manifestPath),
  });
}

/** Read one direct child package without executing code. */
export async function readPluginManifest(manifestPath: string, options: PluginManifestReadOptions): Promise<ValidatedPluginManifest> {
  const lexicalRoot = resolve(options.addonsRoot);
  const lexicalManifest = resolve(manifestPath);
  const lexicalPackage = dirname(lexicalManifest);
  if (basename(lexicalManifest) !== "plugin.json" || dirname(lexicalPackage) !== lexicalRoot) {
    throw new PluginManifestError("plugin.json must be in a direct child of the add-ons root", manifestPath);
  }

  let canonicalRoot: string;
  let canonicalManifest: string;
  try {
    canonicalRoot = await realpath(lexicalRoot);
    canonicalManifest = await realpath(lexicalManifest);
  } catch (error) {
    throw new PluginManifestError("could not resolve plugin package", manifestPath, { cause: error });
  }
  const packageRoot = dirname(canonicalManifest);
  assertContained(canonicalRoot, packageRoot, manifestPath, "plugin package");
  if (dirname(packageRoot) !== canonicalRoot || basename(packageRoot) !== basename(lexicalPackage) || canonicalManifest !== join(packageRoot, "plugin.json")) {
    throw new PluginManifestError("plugin package path, case, or manifest symlink is invalid", manifestPath);
  }

  const maxBytes = options.maxManifestBytes ?? DEFAULT_MAX_PLUGIN_MANIFEST_BYTES;
  const maxDepth = options.maxManifestDepth ?? DEFAULT_MAX_PLUGIN_MANIFEST_DEPTH;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_PLUGIN_MANIFEST_BYTES
    || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > DEFAULT_MAX_PLUGIN_MANIFEST_DEPTH) {
    throw new PluginManifestError("manifest limits may only tighten safe defaults", manifestPath);
  }

  let value: unknown;
  try {
    value = JSON.parse(await readBoundedManifest(canonicalManifest, maxBytes)) as unknown;
  } catch (error) {
    if (error instanceof PluginManifestError) throw error;
    throw new PluginManifestError("plugin.json is not valid JSON", manifestPath, { cause: error });
  }
  assertDepth(value, maxDepth, manifestPath);
  const manifest = validatePluginManifest(value, manifestPath);
  const lexicalEntrypoint = resolve(lexicalPackage, manifest.entrypoint);
  assertContained(lexicalPackage, lexicalEntrypoint, manifestPath, "entrypoint");

  let entrypointPath: string;
  try {
    entrypointPath = await realpath(lexicalEntrypoint);
    if (!(await stat(entrypointPath)).isFile()) throw new Error("entrypoint is not a file");
  } catch (error) {
    throw new PluginManifestError("entrypoint must name an existing file", manifestPath, { cause: error });
  }
  assertContained(packageRoot, entrypointPath, manifestPath, "entrypoint");
  if (extname(entrypointPath) !== extname(manifest.entrypoint)) {
    throw new PluginManifestError("entrypoint symlink changes the declared extension", manifestPath);
  }

  return Object.freeze({
    manifestPath: canonicalManifest,
    packageRoot,
    entrypointPath,
    manifest,
    engineCompatibility: Object.freeze(evaluatePluginEngine(manifest.engine, options.daemonVersion)),
    order: options.order ?? 0,
  });
}

/** Validate the complete set before any future loader imports an entrypoint. */
export async function readPluginManifests(
  manifestPaths: readonly string[],
  options: Omit<PluginManifestReadOptions, "order">,
): Promise<readonly ValidatedPluginManifest[]> {
  const packages = await Promise.all(manifestPaths.map((path, order) => readPluginManifest(path, { ...options, order })));
  const names = new Map<string, string>();
  for (const plugin of packages) {
    const previous = names.get(plugin.manifest.name);
    if (previous) {
      throw new PluginManifestError(`duplicate plugin name ${plugin.manifest.name}: ${previous} and ${plugin.manifestPath}`, plugin.manifestPath);
    }
    names.set(plugin.manifest.name, plugin.manifestPath);
  }
  return Object.freeze(packages);
}

/** Discover direct child packages in deterministic UTF-8 byte order. */
export async function discoverPluginManifests(addonsRoot: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(addonsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return Object.freeze(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map((name) => join(addonsRoot, name, "plugin.json")));
}
