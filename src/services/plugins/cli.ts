// `gaia plugin <search|info|install|remove|list|update|migrate>` -- pi-shaped
// package manager CLI (Pascal 09-05 doctrine: gaia plugin = pi package, no
// parallel gaia-only format). Delegates install/remove/update/list to pi's OWN
// package manager in-process (@earendil-works/pi-coding-agent DefaultPackageManager)
// -- zero shelling out to the `pi` binary. search/info read the GAIA Plugin
// Store registry (registry-client.ts, 24h cache). migrate turns an existing
// gaia-format plugin.json package into a pi package in place (migrate.ts).

import { resolve } from "node:path";
import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PackageManager } from "@earendil-works/pi-coding-agent";
import { migratePluginDir } from "./migrate.js";
import { DEFAULT_PLUGIN_REGISTRY_URL, lookupPluginRegistryEntry, searchPluginRegistry, type PluginRegistryEntry, type RegistryClientOptions } from "./registry-client.js";

const PLUGIN_USAGE = [
  "Usage:",
  "  gaia plugin search <query>                 search the GAIA Plugin Store registry",
  "  gaia plugin info <id|source>                show registry details for one entry",
  "  gaia plugin install <id|source> [--local]   install a pi package (registry id, or a raw npm:/git:/path source)",
  "  gaia plugin remove <id|source> [--local]    remove an installed pi package",
  "  gaia plugin update [id|source]              update one (or, if omitted, every) installed pi package",
  "  gaia plugin list                             list installed pi packages + locally-registered extension paths",
  "  gaia plugin migrate <dir>                    turn an existing gaia plugin.json package at <dir> into a pi package in place (idempotent)",
  "",
  "Env: GAIA_PLUGIN_REGISTRY overrides the registry URL (default " + DEFAULT_PLUGIN_REGISTRY_URL + ")",
].join("\n");

export interface PluginCliOptions {
  /** Working directory package-manager project-scope operations resolve
   * against; default process.cwd(). Never hardcoded. */
  readonly cwd?: string;
  /** pi's own global config dir (~/.pi/agent by default, PI_AGENT_DIR-
   * overridable inside pi itself); default getAgentDir(). Never hardcoded here. */
  readonly agentDir?: string;
  readonly registry?: RegistryClientOptions;
  /** Test-only injection point: bypass real pi settings/package-manager
   * construction entirely. The real CLI entry never sets this. */
  readonly packageManager?: PackageManager;
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

function formatEntry(entry: PluginRegistryEntry): string {
  const verified = entry.verified ? " [verified]" : "";
  return `${entry.id}${verified}\n  ${entry.name} -- ${entry.description}\n  source: ${entry.source}  version: ${entry.version}  tags: ${entry.tags.join(", ")}`;
}

function buildPackageManager(options: PluginCliOptions): { packageManager: PackageManager; agentDir: string; cwd: string } {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();
  if (options.packageManager) return { packageManager: options.packageManager, agentDir, cwd };
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  return { packageManager, agentDir, cwd };
}

/** Resolve a CLI-given identifier to an installable pi package source: a
 * registry id resolves through the store; anything else (npm:/git:/local
 * path, or an id the registry doesn't know) passes through verbatim -- pi's
 * own parseSource sorts out the source kind. */
async function resolveSource(idOrSource: string, registryOptions: RegistryClientOptions): Promise<string> {
  const entry = await lookupPluginRegistryEntry(idOrSource, registryOptions).catch(() => undefined);
  return entry?.source ?? idOrSource;
}

/** Which lanes (harnesses) will pick up a newly installed/updated package on
 * their next turn -- read uniformly off every registered HarnessSpec's own
 * `extensions.discover` flag (RULE #0: no harness id ever hardcoded here).
 * Lazy import: the full harness registry is heavier than the rest of this
 * lightweight CLI file, so it only loads for this one report line. */
async function discoveringLaneLabels(): Promise<readonly string[]> {
  await import("../../harness/index.js");
  const { harnessSpecs } = await import("../../harness/spec.js");
  return harnessSpecs()
    .filter((spec) => spec.extensions?.discover === true)
    .map((spec) => spec.ui.label);
}

function parseFlags(args: string[]): { positional: string[]; local: boolean } {
  const positional: string[] = [];
  let local = false;
  for (const arg of args) {
    if (arg === "--local") local = true;
    else positional.push(arg);
  }
  return { positional, local };
}

export async function runPluginCli(args: string[], options: PluginCliOptions = {}): Promise<number> {
  const [sub, ...rest] = args;
  const registryOptions = options.registry ?? {};

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(PLUGIN_USAGE);
    return sub ? 0 : 1;
  }

  try {
    if (sub === "search") {
      const query = rest.join(" ").trim();
      if (!query) return fail("Usage: gaia plugin search <query>");
      const results = await searchPluginRegistry(query, registryOptions);
      if (results.length === 0) {
        console.log(`No matches for "${query}".`);
        return 0;
      }
      for (const entry of results) console.log(formatEntry(entry));
      return 0;
    }

    if (sub === "info") {
      const id = rest[0];
      if (!id) return fail("Usage: gaia plugin info <id|source>");
      const entry = await lookupPluginRegistryEntry(id, registryOptions);
      if (!entry) return fail(`gaia plugin info: no registry entry for "${id}"`);
      console.log(JSON.stringify(entry, null, 2));
      return 0;
    }

    if (sub === "install" || sub === "remove") {
      const { positional, local } = parseFlags(rest);
      const idOrSource = positional[0];
      if (!idOrSource) return fail(`Usage: gaia plugin ${sub} <id|source> [--local]`);
      const source = await resolveSource(idOrSource, registryOptions);
      const { packageManager } = buildPackageManager(options);
      if (sub === "install") {
        await packageManager.installAndPersist(source, { local });
        console.log(`Installed ${source}${local ? " (project scope)" : " (user scope)"}.`);
        const lanes = await discoveringLaneLabels();
        console.log(lanes.length > 0 ? `Picked up on next turn by: ${lanes.join(", ")}.` : "No registered harness currently discovers extensions -- installed for manual/other use.");
      } else {
        const removed = await packageManager.removeAndPersist(source, { local });
        console.log(removed ? `Removed ${source}.` : `${source} was not configured; nothing to remove.`);
      }
      return 0;
    }

    if (sub === "update") {
      const idOrSource = rest[0];
      const { packageManager } = buildPackageManager(options);
      if (idOrSource) {
        const source = await resolveSource(idOrSource, registryOptions);
        await packageManager.update(source);
        console.log(`Updated ${source}.`);
      } else {
        await packageManager.update();
        console.log("Updated every configured pi package.");
      }
      return 0;
    }

    if (sub === "list") {
      const { packageManager, cwd, agentDir } = buildPackageManager(options);
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const configured = packageManager.listConfiguredPackages();
      if (configured.length === 0) console.log("No configured pi packages.");
      for (const pkg of configured) console.log(`${pkg.source}  [${pkg.scope}]${pkg.filtered ? " (filtered)" : ""}${pkg.installedPath ? `  ${pkg.installedPath}` : ""}`);
      const localExtensions = [
        ...(settingsManager.getGlobalSettings().extensions ?? []).map((path) => `${path}  [user, local]`),
        ...(settingsManager.getProjectSettings().extensions ?? []).map((path) => `${path}  [project, local]`),
      ];
      for (const line of localExtensions) console.log(line);
      return 0;
    }

    if (sub === "migrate") {
      const dirArg = rest[0];
      if (!dirArg) return fail("Usage: gaia plugin migrate <dir>");
      const dir = resolve(options.cwd ?? process.cwd(), dirArg);
      const result = await migratePluginDir(dir);
      if (result.status === "skipped") {
        console.log(`${dir}: skipped -- ${result.reason}`);
        return 0;
      }
      console.log(`${dir}: ${result.status} (plugin ${result.pluginId}) -> ${result.packageJsonPath}, ${result.entryPath}`);
      console.log(`  moved to pi (deprecated gaia format): ${(result.movedToPi ?? []).length > 0 ? (result.movedToPi ?? []).join(", ") : "none"}`);
      console.log(`  stayed daemon-side (channel-bridge, no pi equivalent): ${(result.stayedDaemon ?? []).length > 0 ? (result.stayedDaemon ?? []).join(", ") : "none"}`);
      return 0;
    }

    console.log(PLUGIN_USAGE);
    return fail(`gaia plugin: unknown subcommand "${sub}"`);
  } catch (error) {
    return fail(`gaia plugin: ${error instanceof Error ? error.message : String(error)}`);
  }
}
