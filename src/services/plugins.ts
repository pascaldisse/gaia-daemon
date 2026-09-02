// Local command-plugin loader. A plugin is a single .mjs file that owns one
// (or more — see `command` below) slash-command name(s). Two source
// directories are scanned, both optional: the install's own bundled
// defaults (plugins/defaults/*.mjs in a checkout, or the packaged install's
// snapshot next to the binary — see core/paths.ts bundledDir) load first, so
// a fresh install behaves identically with zero manual setup; ~/.gaia/plugins/
// (user-dropped, no repo change needed) loads after and may add MORE
// commands, but never overrides a bundled one of the same name (duplicate =
// skipped with a console.warn, same as any other collision). Kept generic on
// purpose: nothing here knows about any specific plugin's behavior (see
// room-service.ts for the call sites that consult the loaded map).

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundledDir, globalPaths } from "../core/paths.js";

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
 * shape as a transient, themed overlay dialog (never a persistent panel and
 * never an iframe: no plugin may embed a separate browser-owned experience
 * inside the room UI — forms/items are the only surface). A panel should be
 * present only while the plugin's own state says it is open (e.g. an explicit
 * "open" flag set by its command, cleared again once an action completes or a
 * conventional "close" action runs); the client has no independent open/close
 * flag of its own, so an always-returned panel would never go away. */
export interface PluginPanel {
  title: string;
  description?: string;
  forms?: Array<{ action: string; label: string; fields: PluginPanelField[] }>;
  items?: Array<{ title: string; detail?: string; actions?: Array<{ action: string; label: string; args?: string[]; danger?: boolean }> }>;
}

export interface PluginContext {
  homedir: string;
  roomId: string;
  workspaceRoot: string;
  state?: Record<string, unknown>;
  agents: PluginAgent[];
  /** The specific command name that triggered this `run()` call, when the
   * plugin owns more than one (see `CommandPlugin.command` below). Absent for
   * every OTHER hook (panel/prompt/renderCap/turnStart) — those run once per
   * plugin regardless of how many command names it owns, so there is no
   * single "invoking" command to report. */
  command?: string;
}

/** Generic display-time cap a plugin can impose on how an agent's OWN reply
 * renders, without ever touching the stored text (see CommandPlugin.renderCap
 * and RoomService#commitReply/#displayEvents). `note`, if given, is shown as
 * its own separate SYSTEM-authored chrome line alongside the (possibly
 * capped) reply — synthesized fresh at every display, never merged into the
 * agent's own message text. Nothing here may ever add words to what the
 * agent apparently said. */
export interface PluginRenderCap {
  /** Keep at most this many lines of the real reply, from the top. <= 0 shows
   * nothing (an empty display string) — the real words are trimmed away, not
   * replaced by fabricated text. */
  maxLines: number;
  /** Optional system-authored chrome line shown next to the (possibly
   * capped) reply — e.g. a persona-register reminder. Never part of the
   * agent's own message. */
  note?: string;
}

export interface PluginResult {
  steer?: string;
  reply?: string;
  /** Request a known workspace agent as the room's subsequent chat target. */
  activeAgent?: string;
  /** Opaque JSON object durably owned by this plugin under
   * RoomState.pluginState, keyed by `CommandPlugin.id` (see pluginStateKey). */
  state?: Record<string, unknown>;
  /** Generic message-intercept-to-real-turn hook: deliver the ORIGINAL raw
   * command text as a normal message turn — through the FULL busy/queue/
   * steer-by-default pipeline, exactly like a plain "@agent ..." message —
   * instead of the early-return steer/reply handling below. Lets a plugin
   * mutate its own state synchronously (via `state` above) and still have
   * the room's agent generate the actual reply as a REAL turn, never a
   * synthesized string speaking for it. `targets` pins who the turn
   * addresses (defaults to the room's default target when omitted). */
  rewriteAsMessage?: boolean;
  targets?: string[];
}

export interface CommandPlugin {
  /** One command name, or several aliases/verbs this SAME plugin owns (e.g. a
   * persona-register plugin with a master toggle plus a handful of discipline
   * verbs). Every name maps to this one plugin object; `ctx.command` in
   * `run()` tells you which one fired. */
  command: string | readonly string[];
  /** Key RoomState.pluginState is namespaced under and panel/prompt/renderCap/
   * turnStart are deduplicated by, for a plugin owning several command names
   * (see pluginStateKey). Defaults to the first `command` name. */
  id?: string;
  description?: string;
  run(args: string[], ctx: PluginContext): PluginResult | Promise<PluginResult>;
  /** Optional room-local declarative panel, projected through snapshots. */
  panel?(ctx: PluginContext): PluginPanel | Promise<PluginPanel | undefined>;
  /** Optional per-turn context. Called uniformly for every harness and agent. */
  prompt?(ctx: PluginContext & { agentId: string }): string | Promise<string | undefined>;
  /** Optional display-time cap resolved ONCE per commit turn, from live
   * plugin state — never recomputed later. See PluginRenderCap. */
  renderCap?(ctx: PluginContext): PluginRenderCap | undefined | Promise<PluginRenderCap | undefined>;
  /** Optional per-turn-start hook: called once per target right before its
   * turn runs, with the plugin's CURRENT state. A returned object REPLACES
   * the plugin's persisted state (e.g. to expire a transient flag); returning
   * undefined leaves it untouched. Never blocks or mutates the turn itself. */
  turnStart?(ctx: PluginContext): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
}

/** RoomState.pluginState / panel-prompt-renderCap-turnStart dedup key for a
 * plugin that may own several command names — `id` when given, else the
 * first (or only) `command` name. Exported so room-service.ts uses the exact
 * same key everywhere a plugin's own state is read or written. */
export function pluginStateKey(plugin: Pick<CommandPlugin, "command" | "id">): string {
  return plugin.id ?? (typeof plugin.command === "string" ? plugin.command : plugin.command[0]);
}

function pluginCommandNames(plugin: CommandPlugin): string[] {
  return typeof plugin.command === "string" ? [plugin.command] : [...plugin.command];
}

/** Bundled defaults directory: shipped inside the install itself (checkout:
 * <repo>/plugins/defaults; packaged: snapshotted next to the binary — see
 * core/paths.ts bundledDir + core/bundle-assets.ts BUNDLE_ASSET_DIRS). Empty
 * by default; a plugin dropped here is active for every install with zero
 * manual setup, unlike ~/.gaia/plugins/ (user-local, opt-in). */
export function bundledCommandPluginsDir(): string {
  return bundledDir("plugins", "defaults");
}

function userCommandPluginsDir(): string {
  return globalPaths.commandPluginsDir();
}

/** Scans the bundled-defaults dir then ~/.gaia/plugins/*.mjs and
 * dynamic-imports each one's default export as a CommandPlugin, keyed by
 * every name in its `.command`. Never throws: a missing dir yields nothing
 * from that source, and a bad/duplicate module is skipped with a
 * console.warn rather than taking the whole load down. A name already
 * claimed (by an earlier directory, or an earlier file in the same one)
 * makes the WHOLE plugin skip — never a partial registration. */
export async function loadCommandPlugins(): Promise<Map<string, CommandPlugin>> {
  const plugins = new Map<string, CommandPlugin>();
  for (const dir of [bundledCommandPluginsDir(), userCommandPluginsDir()]) {
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((file) => file.endsWith(".mjs"))
        .sort();
    } catch {
      continue; // this source has no plugins dir — nothing to load from it
    }
    for (const file of files) {
      const path = join(dir, file);
      try {
        const mod = await import(pathToFileURL(path).href);
        const candidate = mod?.default;
        const commandOk =
          typeof candidate?.command === "string" ||
          (Array.isArray(candidate?.command) && candidate.command.length > 0 && candidate.command.every((c: unknown) => typeof c === "string" && c));
        if (!candidate || !commandOk || typeof candidate.run !== "function") {
          console.warn(`[plugins] skipped ${file}: invalid plugin (needs a default export with string|string[] .command and function .run)`);
          continue;
        }
        const plugin = candidate as CommandPlugin;
        const names = pluginCommandNames(plugin);
        const dupes = names.filter((name) => plugins.has(name));
        if (dupes.length > 0) {
          console.warn(`[plugins] skipped ${file}: duplicate command(s) "${dupes.join(", ")}"`);
          continue;
        }
        for (const name of names) plugins.set(name, plugin);
      } catch (error) {
        console.warn(`[plugins] skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return plugins;
}
