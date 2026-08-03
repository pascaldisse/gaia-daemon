// Local command-plugin loader. A plugin is a single .mjs file dropped in
// ~/.gaia/plugins/ that owns one slash-command name — no repo change needed to
// add, remove, or edit one. Kept generic on purpose: nothing here knows about
// any specific plugin's behavior (see room-service.ts for the two call sites
// that consult the loaded map).

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

/** Declarative, data-only plugin panel. The web client renders this generic
 * shape; plugins never inject browser code into the daemon UI. */
export interface PluginPanel {
  title: string;
  description?: string;
  /** A same-origin, plugin-owned experience. The daemon only supplies the
   * generic iframe host; the embedded application owns every visual control. */
  embed?: { src: string; title?: string };
  forms?: Array<{ action: string; label: string; fields: PluginPanelField[] }>;
  items?: Array<{ title: string; detail?: string; actions?: Array<{ action: string; label: string; args?: string[]; danger?: boolean }> }>;
}

export interface PluginContext {
  homedir: string;
  roomId: string;
  workspaceRoot: string;
  state?: Record<string, unknown>;
  agents: PluginAgent[];
}

export interface PluginResult {
  steer?: string;
  reply?: string;
  /** Opaque JSON object durably owned by this plugin under RoomState.pluginState. */
  state?: Record<string, unknown>;
}

export interface CommandPlugin {
  command: string;
  description?: string;
  run(args: string[], ctx: PluginContext): PluginResult | Promise<PluginResult>;
  /** Optional room-local declarative panel, projected through snapshots. */
  panel?(ctx: PluginContext): PluginPanel | Promise<PluginPanel | undefined>;
  /** Optional per-turn context. Called uniformly for every harness and agent. */
  prompt?(ctx: PluginContext & { agentId: string }): string | Promise<string | undefined>;
}

/** Scans ~/.gaia/plugins/*.mjs and dynamic-imports each one's default export as
 * a CommandPlugin, keyed by its .command name. Never throws: a missing plugins
 * dir yields an empty map, and a bad/duplicate module is skipped with a
 * console.warn rather than taking the whole load down. */
export async function loadCommandPlugins(): Promise<Map<string, CommandPlugin>> {
  const plugins = new Map<string, CommandPlugin>();
  const dir = join(homedir(), ".gaia", "plugins");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith(".mjs"))
      .sort();
  } catch {
    return plugins; // no ~/.gaia/plugins dir — nothing to load
  }
  for (const file of files) {
    const path = join(dir, file);
    try {
      const mod = await import(pathToFileURL(path).href);
      const candidate = mod?.default;
      if (!candidate || typeof candidate.command !== "string" || typeof candidate.run !== "function") {
        console.warn(`[plugins] skipped ${file}: invalid plugin (needs a default export with string .command and function .run)`);
        continue;
      }
      const plugin = candidate as CommandPlugin;
      if (plugins.has(plugin.command)) {
        console.warn(`[plugins] skipped ${file}: duplicate command "${plugin.command}"`);
        continue;
      }
      plugins.set(plugin.command, plugin);
    } catch (error) {
      console.warn(`[plugins] skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return plugins;
}
