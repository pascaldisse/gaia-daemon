import {
  loadPlugins,
  type LoadedPlugin,
  type PluginImporter,
} from "./loader.js";
import type {
  PluginContributions,
  PluginManifest,
  PluginPlacement,
} from "./manifest.js";
import type { CapabilityBroker } from "../capabilities/broker.js";
import type { CapabilityContext } from "../capabilities/types.js";
import {
  invokePluginChannelBridge,
  invokePluginCommand,
  invokePluginProvider,
  invokePluginTool,
  validatePluginContributions,
  type PluginChannelBridgeRequest,
  type PluginChannelBridgeResult,
  type PluginCommandRequest,
  type PluginCommandResult,
  type PluginContributionRegistration,
  type PluginProviderRequest,
  type PluginProviderResult,
  type PluginToolRequest,
  type PluginToolResult,
} from "./contracts.js";

export interface PluginRegisterContext {
  readonly manifest: PluginManifest;
  readonly packageRoot: string;
  readonly generation: number;
}

export interface PluginRegistration {
  readonly contributions?: PluginContributionRegistration;
  readonly dispose?: () => void | Promise<void>;
}

export type PluginRegister = (context: PluginRegisterContext) => void | PluginRegistration | Promise<void | PluginRegistration>;

export interface RegisteredPlugin {
  readonly id: string;
  readonly version: string;
  readonly placement: PluginPlacement;
  readonly requiredCaps: readonly string[];
  readonly contributes: PluginContributions;
}

export interface PluginGeneration {
  readonly generation: number;
  readonly plugins: readonly RegisteredPlugin[];
}

export type PluginStageResult =
  | { readonly status: "staged"; readonly generation: PluginGeneration }
  | { readonly status: "failed"; readonly reason: string };

export type PluginRegistryEvent =
  | { readonly kind: "staged"; readonly generation: number }
  | { readonly kind: "stage-failed"; readonly generation: number; readonly reason: string }
  | { readonly kind: "swapped"; readonly generation: number; readonly previousGeneration: number }
  | { readonly kind: "disposed"; readonly generation: number; readonly pluginId: string }
  | { readonly kind: "dispose-failed"; readonly generation: number; readonly pluginId: string; readonly reason: string };

export type PluginModuleLoader = (
  pluginsRoot: string,
  placement: PluginPlacement,
  importer: PluginImporter<unknown>,
) => Promise<readonly LoadedPlugin<unknown>[]>;

export interface PluginTurnBoundary {
  beginTurn(): { end(): void };
  applyTurnBoundary(): Promise<boolean>;
}

export interface PluginRegistryOptions {
  readonly pluginsRoot: string;
  readonly placement: PluginPlacement;
  readonly importer: PluginImporter<unknown>;
  /** Required before any contribution invocation; absent registries remain
   * metadata/lifecycle-only and fail closed at the invocation port. */
  readonly capabilityBroker?: CapabilityBroker;
  readonly loader?: PluginModuleLoader;
  readonly onEvent?: (event: PluginRegistryEvent) => void;
}

export class PluginRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginRegistryError";
  }
}

interface LivePlugin {
  readonly summary: RegisteredPlugin;
  readonly contributions: PluginContributionRegistration;
  readonly dispose?: () => void | Promise<void>;
}

interface Candidate {
  readonly generation: PluginGeneration;
  readonly entries: readonly LivePlugin[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerOf(moduleNamespace: unknown): PluginRegister {
  if (!isRecord(moduleNamespace)) throw new PluginRegistryError("entrypoint did not export a module object");
  const defaultExport = moduleNamespace.default;
  if (typeof defaultExport === "function") return defaultExport as PluginRegister;
  if (isRecord(defaultExport) && typeof defaultExport.register === "function") return defaultExport.register as PluginRegister;
  if (typeof moduleNamespace.register === "function") return moduleNamespace.register as PluginRegister;
  throw new PluginRegistryError("entrypoint must export a register function");
}

function registrationOf(value: void | PluginRegistration): PluginRegistration {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value) || (value.dispose !== undefined && typeof value.dispose !== "function")) {
    throw new PluginRegistryError("register must return void or an object with an optional dispose function");
  }
  return value as PluginRegistration;
}

/**
 * Staged manifest-plugin generations. Loading/registering builds an isolated
 * candidate; only `applyTurnBoundary` replaces the active snapshot, after the
 * final RoomService lease ends. The legacy command/runner loaders stay outside
 * this registry.
 */
export class PluginRegistry implements PluginTurnBoundary {
  readonly #pluginsRoot: string;
  readonly #placement: PluginPlacement;
  readonly #importer: PluginImporter<unknown>;
  readonly #capabilityBroker: CapabilityBroker | undefined;
  readonly #loader: PluginModuleLoader;
  readonly #onEvent?: (event: PluginRegistryEvent) => void;
  #active: Candidate = Object.freeze({
    generation: Object.freeze({ generation: 0, plugins: Object.freeze([]) }),
    entries: Object.freeze([]),
  });
  #staged: Candidate | undefined;
  #leases = 0;
  #generation = 0;
  #staging = false;
  #closed = false;

  constructor(options: PluginRegistryOptions) {
    if (typeof options.pluginsRoot !== "string" || options.pluginsRoot.length === 0) throw new PluginRegistryError("pluginsRoot is required");
    if (options.placement !== "daemon" && options.placement !== "runner") throw new PluginRegistryError("placement must be daemon or runner");
    if (typeof options.importer !== "function") throw new PluginRegistryError("an importer must be injected");
    if (options.loader !== undefined && typeof options.loader !== "function") throw new PluginRegistryError("loader must be a function");
    this.#pluginsRoot = options.pluginsRoot;
    this.#placement = options.placement;
    this.#importer = options.importer;
    this.#capabilityBroker = options.capabilityBroker;
    this.#loader = options.loader ?? loadPlugins;
    this.#onEvent = options.onEvent;
  }

  get current(): PluginGeneration {
    return this.#active.generation;
  }

  get staged(): PluginGeneration | undefined {
    return this.#staged?.generation;
  }

  get activeTurnLeases(): number {
    return this.#leases;
  }

  beginTurn(): PluginTurnLease {
    if (this.#closed) throw new PluginRegistryError("turn leases are refused after shutdown");
    this.#leases += 1;
    return new PluginTurnLease(this.#active.generation, () => this.#endTurn());
  }

  /** Build a replacement without changing the active generation. */
  async stageReload(): Promise<PluginStageResult> {
    if (this.#closed) throw new PluginRegistryError("reload is refused after shutdown");
    if (this.#staging) throw new PluginRegistryError("a plugin generation is already staging");
    if (this.#staged) throw new PluginRegistryError("a staged plugin generation is awaiting a turn boundary");
    this.#staging = true;
    const generation = ++this.#generation;
    const entries: LivePlugin[] = [];
    try {
      const loaded = await this.#loader(this.#pluginsRoot, this.#placement, this.#importer);
      for (const plugin of loaded) entries.push(await this.#register(plugin, generation));
      const candidate: Candidate = Object.freeze({
        generation: Object.freeze({
          generation,
          plugins: Object.freeze(entries.map((entry) => entry.summary)),
        }),
        entries: Object.freeze(entries),
      });
      this.#staged = candidate;
      this.#emit({ kind: "staged", generation });
      return Object.freeze({ status: "staged", generation: candidate.generation });
    } catch (error) {
      await this.#dispose(entries, generation);
      const reason = errorReason(error);
      this.#emit({ kind: "stage-failed", generation, reason });
      return Object.freeze({ status: "failed", reason });
    } finally {
      this.#staging = false;
    }
  }

  /** Swap only while no RoomService turn owns the old snapshot. */
  async applyTurnBoundary(): Promise<boolean> {
    if (this.#leases !== 0 || !this.#staged) return false;
    const previous = this.#active;
    const next = this.#staged;
    this.#active = next;
    this.#staged = undefined;
    this.#emit({ kind: "swapped", generation: next.generation.generation, previousGeneration: previous.generation.generation });
    await this.#dispose(previous.entries, previous.generation.generation);
    return true;
  }

  /** Typed command invocation, capability-gated for this room/agent pair. */
  async invokeCommand(pluginId: string, name: string, context: CapabilityContext, request: PluginCommandRequest): Promise<PluginCommandResult> {
    return this.#invoke(pluginId, (plugin) => invokePluginCommand(this.#capabilityBroker, this.#requester(plugin), plugin.contributions, name, context, request));
  }
  /** Typed Gaia-tool invocation, capability-gated for this room/agent pair. */
  async invokeTool(pluginId: string, name: string, context: CapabilityContext, request: PluginToolRequest): Promise<PluginToolResult> {
    return this.#invoke(pluginId, (plugin) => invokePluginTool(this.#capabilityBroker, this.#requester(plugin), plugin.contributions, name, context, request));
  }
  /** Typed channel-bridge invocation, capability-gated for this room/agent pair. */
  async invokeChannelBridge(pluginId: string, name: string, context: CapabilityContext, request: PluginChannelBridgeRequest): Promise<PluginChannelBridgeResult> {
    return this.#invoke(pluginId, (plugin) => invokePluginChannelBridge(this.#capabilityBroker, this.#requester(plugin), plugin.contributions, name, context, request));
  }
  /** Typed provider invocation, capability-gated for this room/agent pair. */
  async invokeProvider(pluginId: string, name: string, context: CapabilityContext, request: PluginProviderRequest): Promise<PluginProviderResult> {
    return this.#invoke(pluginId, (plugin) => invokePluginProvider(this.#capabilityBroker, this.#requester(plugin), plugin.contributions, name, context, request));
  }
  async shutdown(): Promise<void> {
    if (this.#closed) return;
    if (this.#leases !== 0) throw new PluginRegistryError("shutdown requires zero active turn leases");
    this.#closed = true;
    const staged = this.#staged;
    this.#staged = undefined;
    if (staged) await this.#dispose(staged.entries, staged.generation.generation);
    const active = this.#active;
    this.#active = Object.freeze({
      generation: Object.freeze({ generation: active.generation.generation, plugins: Object.freeze([]) }),
      entries: Object.freeze([]),
    });
    await this.#dispose(active.entries, active.generation.generation);
  }

  #endTurn(): void {
    if (this.#leases === 0) throw new PluginRegistryError("turn lease was not active");
    this.#leases -= 1;
  }

  async #register(loaded: LoadedPlugin<unknown>, generation: number): Promise<LivePlugin> {
    const register = registerOf(loaded.module);
    const context: PluginRegisterContext = Object.freeze({
      manifest: loaded.manifest.manifest,
      packageRoot: loaded.manifest.packageRoot,
      generation,
    });
    const registration = registrationOf(await register.call(loaded.module, context));
    const contributions = validatePluginContributions(registration.contributions, loaded.manifest.manifest.contributes);
    return Object.freeze({
      summary: Object.freeze({
        id: loaded.manifest.manifest.id,
        version: loaded.manifest.manifest.version,
        placement: loaded.manifest.manifest.placement,
        requiredCaps: loaded.manifest.manifest.requiredCaps,
        contributes: loaded.manifest.manifest.contributes,
      }),
      contributions,
      ...(registration.dispose ? { dispose: registration.dispose } : {}),
    });
  }

  async #invoke<T>(pluginId: string, invoke: (plugin: LivePlugin) => Promise<T>): Promise<T> {
    // Contributions may await; hold the same generation lease for their full
    // lifetime so a boundary swap cannot dispose code while it is executing.
    const lease = this.beginTurn();
    try {
      return await invoke(this.#contributionPlugin(pluginId));
    } finally {
      lease.end();
    }
  }
  #contributionPlugin(pluginId: string): LivePlugin {
    const plugin = this.#active.entries.find((entry) => entry.summary.id === pluginId);
    if (!plugin) throw new PluginRegistryError(`plugin ${pluginId} is not active`);
    return plugin;
  }
  #requester(plugin: LivePlugin): { readonly namespace: string; readonly requiredCaps: readonly string[] } {
    return { namespace: plugin.summary.id, requiredCaps: plugin.summary.requiredCaps };
  }
  async #dispose(entries: readonly LivePlugin[], generation: number): Promise<void> {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry?.dispose) continue;
      try {
        await entry.dispose();
        this.#emit({ kind: "disposed", generation, pluginId: entry.summary.id });
      } catch (error) {
        this.#emit({ kind: "dispose-failed", generation, pluginId: entry.summary.id, reason: errorReason(error) });
      }
    }
  }

  #emit(event: PluginRegistryEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // Observability cannot change generation lifecycle.
    }
  }
}

export class PluginTurnLease {
  readonly generation: PluginGeneration;
  readonly #onEnd: () => void;
  #ended = false;

  constructor(generation: PluginGeneration, onEnd: () => void) {
    this.generation = generation;
    this.#onEnd = onEnd;
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#onEnd();
  }
}
