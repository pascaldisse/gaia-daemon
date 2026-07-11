// Local command-plugin loader. A plugin is a single .mjs file dropped in
// ~/.gaia/plugins/ that owns one slash-command name — no repo change needed to
// add, remove, or edit one. Kept generic on purpose: nothing here knows about
// any specific plugin's behavior (see room-service.ts for the two call sites
// that consult the loaded map).

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface CommandPlugin {
  command: string;
  description?: string;
  run(
    args: string[],
    ctx: { homedir: string; roomId: string },
  ): { steer?: string; reply?: string } | Promise<{ steer?: string; reply?: string }>;
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
