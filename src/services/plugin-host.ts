import type { BundledPluginInventoryItem } from "./bundled-plugins.js";
import type { ValidatedPluginManifest } from "./plugin-manifest.js";

/**
 * Disconnected generic plugin lifecycle host.
 *
 * Nothing here is wired to the app, rooms, HTTP, or the legacy plugin loaders.
 * The host only turns a manifest inventory into a registered generation and
 * back again. It never imports anything by itself: every module arrives through
 * the injected importer, so callers own the module resolution policy.
 *
 * Declared permissions and requiredCaps are carried as data. The host grants no
 * authority; a future integration must authorize every operation separately.
 */

/** Module shape the host expects behind an entrypoint. */
export interface PluginModule {
  readonly register?: (context: PluginRegisterContext) => unknown | Promise<unknown>;
}

/** Everything a plugin learns at registration. Data only, never authority. */
export interface PluginRegisterContext {
  readonly name: string;
  readonly version: string;
  readonly namespace: string;
  readonly packageRoot: string;
  readonly entrypointPath: string;
  /** Declaration only: authorizing these is a caller's job, not the host's. */
  readonly permissions: readonly string[];
  /** Declaration only: the host never provisions capabilities. */
  readonly requiredCaps: readonly string[];
  readonly generation: number;
}

/** Injected module resolution. The host has no default dynamic import. */
export type PluginImporter = (entrypointPath: string, plugin: ValidatedPluginManifest) => Promise<unknown>;

export type PluginDispose = () => unknown | Promise<unknown>;

export interface RegisteredPlugin {
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly permissions: readonly string[];
  readonly requiredCaps: readonly string[];
}

export interface SkippedPlugin {
  readonly namespace?: string;
  readonly manifestPath?: string;
  readonly reason: string;
}

export interface PluginGeneration {
  readonly generation: number;
  readonly registered: readonly RegisteredPlugin[];
  readonly skipped: readonly SkippedPlugin[];
}

export interface PluginHostOptions {
  /** Required: the host performs zero module resolution of its own. */
  readonly importer: PluginImporter;
  /** Optional observability sink; failures inside it never affect lifecycle. */
  readonly onEvent?: (event: PluginHostEvent) => void;
}

export type PluginHostEvent =
  | { readonly kind: "skipped"; readonly generation: number; readonly reason: string; readonly namespace?: string }
  | { readonly kind: "registered"; readonly generation: number; readonly namespace: string }
  | { readonly kind: "disposed"; readonly generation: number; readonly namespace: string }
  | { readonly kind: "dispose-failed"; readonly generation: number; readonly namespace: string; readonly reason: string };

export class PluginHostError extends Error {
  readonly namespace?: string;

  constructor(message: string, namespace?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginHostError";
    this.namespace = namespace;
  }
}

interface LiveEntry {
  readonly summary: RegisteredPlugin;
  readonly dispose?: PluginDispose;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function disposeOf(result: unknown, namespace: string): PluginDispose | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "function") return result as PluginDispose;
  if (isRecord(result)) {
    const candidate = result.dispose;
    if (candidate === undefined) return undefined;
    if (typeof candidate !== "function") {
      throw new PluginHostError("dispose must be a function", namespace);
    }
    return candidate.bind(result) as PluginDispose;
  }
  throw new PluginHostError("register returned an unsupported value", namespace);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Generic lifecycle host over a manifest inventory.
 *
 * Registration is strictly sequential so plugins observe a deterministic order,
 * and a partial failure unwinds by disposing already-registered plugins in
 * reverse order, leaving the host empty rather than half-loaded.
 */
export class PluginHost {
  readonly #importer: PluginImporter;
  readonly #onEvent?: (event: PluginHostEvent) => void;
  #entries: readonly LiveEntry[] = Object.freeze([]);
  #current: PluginGeneration = Object.freeze({ generation: 0, registered: Object.freeze([]), skipped: Object.freeze([]) });
  #generation = 0;
  #leases = 0;
  #busy = false;

  constructor(options: PluginHostOptions) {
    if (typeof options.importer !== "function") {
      throw new PluginHostError("an importer must be injected");
    }
    this.#importer = options.importer;
    this.#onEvent = options.onEvent;
  }

  /** The active generation. Swapped atomically, never observed half-built. */
  get current(): PluginGeneration {
    return this.#current;
  }

  get activeTurnLeases(): number {
    return this.#leases;
  }

  /** Hold while a turn runs: reload is refused until every lease is released. */
  acquireTurnLease(): () => void {
    this.#leases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#leases -= 1;
    };
  }

  /**
   * Build a new generation and swap it in.
   *
   * Only inventory entries the manifest layer already marked compatible are
   * eligible: unavailable or invalid packages are recorded as skipped and their
   * code is never imported, so an incompatible engine cannot execute anything.
   */
  async reload(inventory: readonly BundledPluginInventoryItem[]): Promise<PluginGeneration> {
    if (this.#busy) throw new PluginHostError("a reload is already in progress");
    if (this.#leases !== 0) throw new PluginHostError("reload requires zero active turn leases");
    this.#busy = true;
    try {
      const generation = this.#generation + 1;
      const skipped: SkippedPlugin[] = [];
      const eligible: BundledPluginInventoryItem[] = [];
      for (const item of inventory) {
        if (item.status === "compatible") {
          eligible.push(item);
          continue;
        }
        const entry: SkippedPlugin = item.status === "invalid"
          ? { manifestPath: item.manifestPath, reason: item.reason }
          : { namespace: item.namespace, reason: item.reason };
        skipped.push(Object.freeze(entry));
        this.#emit({ kind: "skipped", generation, reason: entry.reason, namespace: entry.namespace });
      }

      const built: LiveEntry[] = [];
      try {
        for (const item of eligible) {
          if (item.status !== "compatible") continue;
          built.push(await this.#register(item.namespace, item.plugin, generation));
        }
      } catch (error) {
        await this.#disposeAll(built, generation);
        throw error instanceof PluginHostError ? error : new PluginHostError(reason(error), undefined, { cause: error });
      }

      const previous = this.#entries;
      const next: PluginGeneration = Object.freeze({
        generation,
        registered: Object.freeze(built.map((entry) => entry.summary)),
        skipped: Object.freeze(skipped),
      });
      this.#entries = Object.freeze([...built]);
      this.#current = next;
      this.#generation = generation;
      await this.#disposeAll(previous, generation - 1);
      return next;
    } finally {
      this.#busy = false;
    }
  }

  /** Dispose everything in reverse registration order and empty the host. */
  async shutdown(): Promise<void> {
    if (this.#busy) throw new PluginHostError("a reload is already in progress");
    const previous = this.#entries;
    const generation = this.#generation;
    this.#entries = Object.freeze([]);
    this.#current = Object.freeze({ generation, registered: Object.freeze([]), skipped: this.#current.skipped });
    await this.#disposeAll(previous, generation);
  }

  async #register(namespace: string, plugin: ValidatedPluginManifest, generation: number): Promise<LiveEntry> {
    let module: unknown;
    try {
      module = await this.#importer(plugin.entrypointPath, plugin);
    } catch (error) {
      throw new PluginHostError(`import failed: ${reason(error)}`, namespace, { cause: error });
    }
    if (!isRecord(module)) throw new PluginHostError("entrypoint did not export a module object", namespace);
    const register = (module as PluginModule).register;
    if (register !== undefined && typeof register !== "function") {
      throw new PluginHostError("register must be a function", namespace);
    }

    const context: PluginRegisterContext = Object.freeze({
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      namespace,
      packageRoot: plugin.packageRoot,
      entrypointPath: plugin.entrypointPath,
      permissions: plugin.manifest.permissions,
      requiredCaps: plugin.manifest.requiredCaps,
      generation,
    });

    let result: unknown;
    if (register) {
      try {
        result = await register.call(module, context);
      } catch (error) {
        throw new PluginHostError(`register failed: ${reason(error)}`, namespace, { cause: error });
      }
    }

    const summary: RegisteredPlugin = Object.freeze({
      namespace,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      permissions: plugin.manifest.permissions,
      requiredCaps: plugin.manifest.requiredCaps,
    });
    this.#emit({ kind: "registered", generation, namespace });
    return { summary, dispose: disposeOf(result, namespace) };
  }

  async #disposeAll(entries: readonly LiveEntry[], generation: number): Promise<void> {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      const namespace = entry.summary.namespace;
      if (!entry.dispose) continue;
      try {
        await entry.dispose();
        this.#emit({ kind: "disposed", generation, namespace });
      } catch (error) {
        this.#emit({ kind: "dispose-failed", generation, namespace, reason: reason(error) });
      }
    }
  }

  #emit(event: PluginHostEvent): void {
    if (!this.#onEvent) return;
    try {
      this.#onEvent(event);
    } catch {
      // Observability must never change lifecycle behaviour.
    }
  }
}
