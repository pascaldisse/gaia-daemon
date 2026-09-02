// Command-plugin compatibility surface. New daemon command packages live in
// ~/.gaia/plugins/<package>/plugin.json; legacy loose ~/.mjs files remain for
// one compatibility release only. Bundled defaults retain their established
// package-free shape until they receive their own manifest packages.

import type { CapabilityContext } from "./capabilities/types.js";
import type { PluginCommandRequest, PluginCommandResult } from "./plugins/contracts.js";
import type { RegisteredPluginCommand } from "./plugins/registry.js";

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
    plugins.set(command.name, {
      command: command.name,
      id: command.pluginId,
      description: command.description,
      run: (args, context) => registry.invokeCommand(
        command.pluginId,
        command.name,
        { roomId: context.roomId, agentId: context.agentId },
        { args },
      ),
    });
  }
  return plugins;
}
