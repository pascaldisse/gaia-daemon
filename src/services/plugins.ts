// Command-plugin compatibility surface. Commands enter only through daemon-owned
// manifest registries; this adapter binds their typed result to room hooks.

import type { CapabilityContext } from "./capabilities/types.js";
import type { PluginCommandRequest, PluginCommandResult } from "./plugins/contracts.js";
import type { RegisteredPluginCommand } from "./plugins/registry.js";

import type { PluginCommandContext, PluginPanel, PluginRenderCap } from "./plugins/contracts.js";
import type { PluginDenial } from "../core/types.js";
export type { PluginPanel };
export type PluginContext = PluginCommandContext;
export interface PluginResult {
steer?: string;
reply?: string;
activeAgent?: string;
state?: Record<string, unknown>;
rewriteAsMessage?: boolean;
targets?: string[];
panel?: (ctx: PluginContext) => PluginPanel | undefined | Promise<PluginPanel | undefined>;
prompt?: (ctx: PluginContext & { agentId: string }) => string | undefined | Promise<string | undefined>;
renderCap?: (ctx: PluginContext) => PluginRenderCap | undefined | Promise<PluginRenderCap | undefined>;
turnStart?: (ctx: PluginContext) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
/** Set only when this result came from a CapabilityDeniedError catch
 * (ADV-021) — the broker rejected the invocation before the plugin's own
 * contribution code ran. `reply` above still carries a human-readable line;
 * this field is the durable, structured provenance the caller (RoomQueue)
 * persists as `EventDetails.pluginDenial` on a `capability-denied` event. */
denial?: PluginDenial;
}
export interface CommandPlugin {
command: string | readonly string[];
id?: string;
description?: string;
run(args: string[], ctx: PluginContext): PluginResult | Promise<PluginResult>;
panel?: PluginResult["panel"];
prompt?: PluginResult["prompt"];
renderCap?: PluginResult["renderCap"];
turnStart?: PluginResult["turnStart"];
}
/** Shared room-state namespace for aliases. */
export function pluginStateKey(plugin: Pick<CommandPlugin, "command" | "id">): string {
  return plugin.id ?? (typeof plugin.command === "string" ? plugin.command : plugin.command[0]);
}

/** Registry command surface injected by the daemon composition root. */
export interface CommandPluginRegistry {
  commandContributions(): readonly RegisteredPluginCommand[];
  invokeCommand(pluginId: string, name: string, context: CapabilityContext, request: PluginCommandRequest): Promise<PluginCommandResult>;
}

/**
 * Adapts the daemon-owned manifest registry to RoomService's legacy command
 * shape. This module owns no lifecycle or authorization state: every command
 * invocation is delegated back to the one injected registry.
 */
export async function loadCommandPlugins(registry: CommandPluginRegistry): Promise<Map<string, CommandPlugin>> {
  const plugins = new Map<string, CommandPlugin>();
  for (const command of registry.commandContributions()) {
    const plugin: CommandPlugin = {
      command: command.name,
      id: command.pluginId,
      description: command.description,
      run: async (args, context) => {
        const result = await registry.invokeCommand(command.pluginId, command.name, { workspaceId: context.workspaceId, roomId: context.roomId, agentId: context.agentId }, { args, pluginContext: context });
        plugin.panel = result.panel;
        plugin.prompt = result.prompt;
        plugin.renderCap = result.renderCap;
        plugin.turnStart = result.turnStart;
        return result;
      },
    };
    plugins.set(command.name, plugin);
  }
  return plugins;
}
