// Typed contribution ports. Manifest declarations bound the names a package may
// expose; invocation always crosses CapabilityBroker before plugin code runs.
import type { PluginContributionWireValue } from "../../harness/protocol.js";
import { CapabilityBroker } from "../capabilities/broker.js";
import type { CapabilityContext, CapabilityRequester } from "../capabilities/types.js";
import type { PluginContributions } from "./manifest.js";

export type PluginContributionKind = "command" | "tool" | "channel-bridge" | "provider";
export type PluginContributionValue = PluginContributionWireValue;

export interface PluginAgent { readonly id: string; readonly displayName: string; readonly icon: string; }
export interface PluginPanelField { readonly name: string; readonly label: string; readonly type: "text" | "select"; readonly value?: string; readonly options?: readonly { readonly value: string; readonly label: string }[]; }
export interface PluginPanel { readonly title: string; readonly description?: string; readonly forms?: readonly { readonly action: string; readonly label: string; readonly fields: readonly PluginPanelField[] }[]; readonly items?: readonly { readonly title: string; readonly detail?: string; readonly actions?: readonly { readonly action: string; readonly label: string; readonly args?: readonly string[]; readonly danger?: boolean }[] }[]; }
export interface PluginRenderCap { readonly maxLines: number; readonly note?: string; }
export interface PluginCommandContext { readonly homedir: string; readonly workspaceId: string; readonly roomId: string; readonly agentId: string; readonly workspaceRoot: string; readonly state?: Record<string, unknown>; readonly agents: readonly PluginAgent[]; readonly command?: string; }
export interface PluginCommandRequest { readonly args: readonly string[]; readonly pluginContext?: PluginCommandContext; }
export interface PluginCommandResult {
  reply?: string; steer?: string; activeAgent?: string; state?: Record<string, unknown>; rewriteAsMessage?: boolean; targets?: string[];
  panel?: (context: PluginCommandContext) => PluginPanel | undefined | Promise<PluginPanel | undefined>;
  prompt?: (context: PluginCommandContext & { readonly agentId: string }) => string | undefined | Promise<string | undefined>;
  renderCap?: (context: PluginCommandContext) => PluginRenderCap | undefined | Promise<PluginRenderCap | undefined>;
  turnStart?: (context: PluginCommandContext) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
}
export interface PluginToolRequest {
  readonly arguments: Readonly<Record<string, PluginContributionValue>>;
}
export interface PluginToolResult {
  readonly content: string;
  readonly isError?: boolean;
}
export interface PluginChannelBridgeRequest {
  readonly direction: "incoming" | "outgoing";
  readonly payload: PluginContributionValue;
}
export interface PluginChannelBridgeResult {
  readonly handled: boolean;
  readonly payload?: PluginContributionValue;
}
export interface PluginProviderRequest {
  readonly operation: string;
  readonly input: PluginContributionValue;
}
export interface PluginProviderResult {
  readonly output: PluginContributionValue;
}

export interface PluginCommandContribution {
  readonly name: string;
  readonly description: string;
  run(context: CapabilityContext, request: PluginCommandRequest): PluginCommandResult | Promise<PluginCommandResult>;
}
export interface PluginToolContribution {
  readonly name: string;
  readonly description: string;
  execute(context: CapabilityContext, request: PluginToolRequest): PluginToolResult | Promise<PluginToolResult>;
}
export interface PluginChannelBridgeContribution {
  readonly name: string;
  handle(context: CapabilityContext, request: PluginChannelBridgeRequest): PluginChannelBridgeResult | Promise<PluginChannelBridgeResult>;
}
export interface PluginProviderContribution {
  readonly name: string;
  provide(context: CapabilityContext, request: PluginProviderRequest): PluginProviderResult | Promise<PluginProviderResult>;
}

export interface PluginContributionRegistration {
  readonly commands?: readonly PluginCommandContribution[];
  readonly tools?: readonly PluginToolContribution[];
  readonly channels?: readonly PluginChannelBridgeContribution[];
  readonly providers?: readonly PluginProviderContribution[];
}

export class PluginContributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginContributionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isContributionName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
function isWireValue(value: unknown, seen = new Set<object>()): value is PluginContributionValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((item) => isWireValue(item, seen));
    seen.delete(value);
    return valid;
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => isWireValue(item, seen));
  seen.delete(value);
  return valid;
}
function isCommand(value: unknown): value is PluginCommandContribution {
  return isRecord(value) && isContributionName(value.name) && typeof value.description === "string" && typeof value.run === "function";
}
function isTool(value: unknown): value is PluginToolContribution {
  return isRecord(value) && isContributionName(value.name) && typeof value.description === "string" && typeof value.execute === "function";
}
function isChannel(value: unknown): value is PluginChannelBridgeContribution {
  return isRecord(value) && isContributionName(value.name) && typeof value.handle === "function";
}
function isProvider(value: unknown): value is PluginProviderContribution {
  return isRecord(value) && isContributionName(value.name) && typeof value.provide === "function";
}
function declaredFor(kind: PluginContributionKind, declared: PluginContributions): readonly string[] {
  return kind === "command" ? declared.commands
    : kind === "tool" ? declared.tools
      : kind === "channel-bridge" ? declared.channels
        : declared.providers;
}
function validateList<T extends { readonly name: string }>(
  value: unknown,
  key: keyof PluginContributionRegistration,
  kind: PluginContributionKind,
  declared: PluginContributions,
  guard: (item: unknown) => item is T,
): readonly T[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new PluginContributionError(`${key} must be an array of valid ${kind} contributions`);
  const entries: T[] = [];
  for (const item of value) {
    if (!guard(item)) throw new PluginContributionError(`${key} must be an array of valid ${kind} contributions`);
    entries.push(item);
  }
  const names = entries.map((item) => item.name);
  if (new Set(names).size !== names.length) throw new PluginContributionError(`${key} must not contain duplicate contribution names`);
  const allowed = new Set(declaredFor(kind, declared));
  if (names.some((name) => !allowed.has(name))) throw new PluginContributionError(`${key} contains a contribution not declared in plugin.json`);
  return Object.freeze(entries);
}

/** Validate module output before it enters the staged registry generation. */
export function validatePluginContributions(
  value: unknown,
  declared: PluginContributions,
): PluginContributionRegistration {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new PluginContributionError("contributions must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "commands" && key !== "tools" && key !== "channels" && key !== "providers")) {
    throw new PluginContributionError("contributions contains an unknown port");
  }
  return Object.freeze({
    ...(value.commands === undefined ? {} : { commands: validateList(value.commands, "commands", "command", declared, isCommand) }),
    ...(value.tools === undefined ? {} : { tools: validateList(value.tools, "tools", "tool", declared, isTool) }),
    ...(value.channels === undefined ? {} : { channels: validateList(value.channels, "channels", "channel-bridge", declared, isChannel) }),
    ...(value.providers === undefined ? {} : { providers: validateList(value.providers, "providers", "provider", declared, isProvider) }),
  });
}

function isPanelHook(value: unknown): value is NonNullable<PluginCommandResult["panel"]> { return typeof value === "function"; }
function isPromptHook(value: unknown): value is NonNullable<PluginCommandResult["prompt"]> { return typeof value === "function"; }
function isRenderCapHook(value: unknown): value is NonNullable<PluginCommandResult["renderCap"]> { return typeof value === "function"; }
function isTurnStartHook(value: unknown): value is NonNullable<PluginCommandResult["turnStart"]> { return typeof value === "function"; }
function validateCommandResult(value: unknown): PluginCommandResult {
  if (!isRecord(value) || (value.reply !== undefined && typeof value.reply !== "string") || (value.steer !== undefined && typeof value.steer !== "string") || (value.activeAgent !== undefined && typeof value.activeAgent !== "string") || (value.state !== undefined && !isRecord(value.state)) || (value.rewriteAsMessage !== undefined && typeof value.rewriteAsMessage !== "boolean") || (value.targets !== undefined && (!Array.isArray(value.targets) || value.targets.some((target) => typeof target !== "string"))) || (value.panel !== undefined && typeof value.panel !== "function") || (value.prompt !== undefined && typeof value.prompt !== "function") || (value.renderCap !== undefined && typeof value.renderCap !== "function") || (value.turnStart !== undefined && typeof value.turnStart !== "function")) {
    throw new PluginContributionError("command contribution returned an invalid result");
  }
  const result: PluginCommandResult = {};
if (typeof value.reply === "string") result.reply = value.reply;
if (typeof value.steer === "string") result.steer = value.steer;
if (typeof value.activeAgent === "string") result.activeAgent = value.activeAgent;
if (isRecord(value.state)) result.state = value.state;
if (typeof value.rewriteAsMessage === "boolean") result.rewriteAsMessage = value.rewriteAsMessage;
if (Array.isArray(value.targets)) result.targets = [...value.targets];
if (isPanelHook(value.panel)) result.panel = value.panel;
if (isPromptHook(value.prompt)) result.prompt = value.prompt;
if (isRenderCapHook(value.renderCap)) result.renderCap = value.renderCap;
if (isTurnStartHook(value.turnStart)) result.turnStart = value.turnStart;
return Object.freeze(result);
}
function validateToolResult(value: unknown): PluginToolResult {
  if (!isRecord(value) || typeof value.content !== "string" || (value.isError !== undefined && typeof value.isError !== "boolean")) {
    throw new PluginContributionError("tool contribution returned an invalid result");
  }
  return Object.freeze({ content: value.content, ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}) });
}
function validateChannelResult(value: unknown): PluginChannelBridgeResult {
  if (!isRecord(value) || typeof value.handled !== "boolean" || (value.payload !== undefined && !isWireValue(value.payload))) {
    throw new PluginContributionError("channel contribution returned an invalid result");
  }
  return Object.freeze({ handled: value.handled, ...(value.payload === undefined ? {} : { payload: value.payload }) });
}
function validateProviderResult(value: unknown): PluginProviderResult {
  if (!isRecord(value) || !Object.hasOwn(value, "output") || !isWireValue(value.output)) {
    throw new PluginContributionError("provider contribution returned an invalid result");
  }
  return Object.freeze({ output: value.output });
}
function contribution<T extends { readonly name: string }>(
  pluginId: string,
  name: string,
  values: readonly T[] | undefined,
  kind: PluginContributionKind,
): T {
  const found = values?.find((value) => value.name === name);
  if (!found) throw new PluginContributionError(`plugin ${pluginId} has no ${kind} contribution named ${name}`);
  return found;
}
function authorize(broker: CapabilityBroker | undefined, plugin: CapabilityRequester, context: CapabilityContext): void {
  if (!broker) throw new PluginContributionError("plugin contribution invocation requires a capability broker");
  broker.authorize(plugin, context);
}

export async function invokePluginCommand(broker: CapabilityBroker | undefined, plugin: CapabilityRequester, contributions: PluginContributionRegistration, name: string, context: CapabilityContext, request: PluginCommandRequest): Promise<PluginCommandResult> {
  authorize(broker, plugin, context);
  return validateCommandResult(await contribution(plugin.namespace, name, contributions.commands, "command").run(context, request));
}
export async function invokePluginTool(broker: CapabilityBroker | undefined, plugin: CapabilityRequester, contributions: PluginContributionRegistration, name: string, context: CapabilityContext, request: PluginToolRequest): Promise<PluginToolResult> {
  authorize(broker, plugin, context);
  return validateToolResult(await contribution(plugin.namespace, name, contributions.tools, "tool").execute(context, request));
}
export async function invokePluginChannelBridge(broker: CapabilityBroker | undefined, plugin: CapabilityRequester, contributions: PluginContributionRegistration, name: string, context: CapabilityContext, request: PluginChannelBridgeRequest): Promise<PluginChannelBridgeResult> {
  authorize(broker, plugin, context);
  return validateChannelResult(await contribution(plugin.namespace, name, contributions.channels, "channel-bridge").handle(context, request));
}
export async function invokePluginProvider(broker: CapabilityBroker | undefined, plugin: CapabilityRequester, contributions: PluginContributionRegistration, name: string, context: CapabilityContext, request: PluginProviderRequest): Promise<PluginProviderResult> {
  authorize(broker, plugin, context);
  return validateProviderResult(await contribution(plugin.namespace, name, contributions.providers, "provider").provide(context, request));
}
