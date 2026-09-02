// Command-plugin compatibility surface. New daemon command packages live in
// ~/.gaia/plugins/<package>/plugin.json; legacy loose ~/.mjs files remain for
// one compatibility release only. Bundled defaults retain their established
// package-free shape until they receive their own manifest packages.

import { readdirSync } from "node:fs";
import { join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { bundledDir, globalPaths } from "../core/paths.js";
import { CapabilityBroker } from "./capabilities/broker.js";
import { PluginRegistry } from "./plugins/registry.js";
import type { PluginManifest } from "./plugins/manifest.js";

export interface PluginAgent {
  id: string;
  displayName: string;
  icon: string;
}

export interface PluginPanelField {
  name: string;
  label: string;
  type: "text" | "select";
  value?: string;
  options?: Array<{ value: string; label: string }>;
}

/** Declarative only: plugins never own browser surfaces. */
export interface PluginPanel {
  title: string;
  description?: string;
  forms?: Array<{ action: string; label: string; fields: PluginPanelField[] }>;
  items?: Array<{ title: string; detail?: string; actions?: Array<{ action: string; label: string; args?: string[]; danger?: boolean }> }>;
}

export interface PluginContext {
  homedir: string;
  roomId: string;
  /** Capability decisions stay bound to the room's resolved target agent. */
  agentId: string;
  workspaceRoot: string;
  state?: Record<string, unknown>;
  agents: PluginAgent[];
  command?: string;
}

export interface PluginRenderCap {
  maxLines: number;
  note?: string;
}

export interface PluginResult {
  steer?: string;
  reply?: string;
  activeAgent?: string;
  state?: Record<string, unknown>;
  rewriteAsMessage?: boolean;
  targets?: string[];
}

export interface CommandPlugin {
  command: string | readonly string[];
  id?: string;
  description?: string;
  run(args: string[], ctx: PluginContext): PluginResult | Promise<PluginResult>;
  panel?(ctx: PluginContext): PluginPanel | Promise<PluginPanel | undefined>;
  prompt?(ctx: PluginContext & { agentId: string }): string | Promise<string | undefined>;
  renderCap?(ctx: PluginContext): PluginRenderCap | undefined | Promise<PluginRenderCap | undefined>;
  turnStart?(ctx: PluginContext): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
}

/** Shared room-state namespace for aliases. */
export function pluginStateKey(plugin: Pick<CommandPlugin, "command" | "id">): string {
  return plugin.id ?? (typeof plugin.command === "string" ? plugin.command : plugin.command[0]);
}

function pluginCommandNames(plugin: CommandPlugin): string[] {
  return typeof plugin.command === "string" ? [plugin.command] : [...plugin.command];
}

/** Bundled defaults preserve the prior package-free install behavior. */
export function bundledCommandPluginsDir(): string {
  return bundledDir("plugins", "defaults");
}

function userCommandPluginsDir(): string {
  return globalPaths.commandPluginsDir();
}

function commandPlugin(candidate: unknown): candidate is CommandPlugin {
  if (!candidate || typeof candidate !== "object") return false;
  const value = candidate as { command?: unknown; run?: unknown };
  const commands = value.command;
  return (typeof commands === "string" || (Array.isArray(commands) && commands.length > 0 && commands.every((name) => typeof name === "string" && name)))
    && typeof value.run === "function";
}

function legacyId(file: string): string {
  const stem = parse(file).name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `legacy.${stem || "command"}`;
}

/** Explicit compatibility metadata; loose modules never bypass a manifest-shaped identity. */
export function synthesizeLegacyCommandPluginManifest(file: string): PluginManifest {
  return Object.freeze({
    id: legacyId(file),
    version: "0.0.0-legacy",
    engine: "gaia-daemon@legacy",
    placement: "daemon",
    requiredCaps: Object.freeze([]),
    contributes: Object.freeze({ commands: Object.freeze([]), tools: Object.freeze([]), channels: Object.freeze([]), providers: Object.freeze([]) }),
  });
}

export interface CommandPluginLoaderOptions {
  readonly bundledDir?: string;
  readonly userDir?: string;
  readonly warn?: (message: string) => void;
}

function addPlugin(plugins: Map<string, CommandPlugin>, plugin: CommandPlugin, source: string, warn: (message: string) => void): void {
  const names = pluginCommandNames(plugin);
  const duplicates = names.filter((name) => plugins.has(name));
  if (duplicates.length > 0) {
    warn(`[plugins] skipped ${source}: duplicate command(s) "${duplicates.join(", ")}"`);
    return;
  }
  for (const name of names) plugins.set(name, plugin);
}

async function loadLoosePlugins(dir: string, plugins: Map<string, CommandPlugin>, warn: (message: string) => void, legacy: boolean): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".mjs")).sort();
  } catch {
    return;
  }
  for (const file of files) {
    try {
      if (legacy) {
        const manifest = synthesizeLegacyCommandPluginManifest(file);
        warn(`[plugins] deprecated legacy ${file}; synthesized ${manifest.id} manifest for this compatibility release — move it to <package>/plugin.json before the next release`);
      }
      const candidate = (await import(pathToFileURL(join(dir, file)).href)).default;
      if (!commandPlugin(candidate)) {
        warn(`[plugins] skipped ${file}: invalid plugin (needs a default export with string|string[] .command and function .run)`);
        continue;
      }
      addPlugin(plugins, candidate, file, warn);
    } catch (error) {
      warn(`[plugins] skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function loadManifestPlugins(dir: string, plugins: Map<string, CommandPlugin>, warn: (message: string) => void): Promise<void> {
  // A conservative broker makes the migration safe before workspace capability
  // policy is wired: cap-free commands work; declared capabilities fail closed.
  const registry = new PluginRegistry({
    pluginsRoot: dir,
    placement: "daemon",
    capabilityBroker: new CapabilityBroker({ grantSource: () => undefined, trustSource: () => false }),
    importer: (entrypoint) => import(pathToFileURL(entrypoint).href),
  });
  const staged = await registry.stageReload();
  if (staged.status === "failed") {
    warn(`[plugins] manifest inventory skipped: ${staged.reason}`);
    return;
  }
  await registry.applyTurnBoundary();
  for (const command of registry.commandContributions()) {
    addPlugin(plugins, {
      command: command.name,
      id: command.pluginId,
      description: command.description,
      run: async (args, context) => registry.invokeCommand(command.pluginId, command.name, {
        roomId: context.roomId,
        agentId: context.agentId,
      }, { args }),
    }, `${command.pluginId}/${command.name}`, warn);
  }
}

/**
 * Manifest packages preflight as one inventory before any package import. Then
 * bundled defaults load first and compatibility loose user files last, exactly
 * preserving their old collision behavior while making manifest packages the
 * preferred user extension path.
 */
export async function loadCommandPlugins(options: CommandPluginLoaderOptions = {}): Promise<Map<string, CommandPlugin>> {
  const plugins = new Map<string, CommandPlugin>();
  const warn = options.warn ?? console.warn;
  const bundledDir = options.bundledDir ?? bundledCommandPluginsDir();
  const userDir = options.userDir ?? userCommandPluginsDir();
  await loadLoosePlugins(bundledDir, plugins, warn, false);
  await loadManifestPlugins(userDir, plugins, warn);
  await loadLoosePlugins(userDir, plugins, warn, true);
  return plugins;
}
