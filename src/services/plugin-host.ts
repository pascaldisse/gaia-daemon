import {
  bundledPluginNamespace,
  type BundledPluginCompatible,
  type BundledPluginInventoryItem,
} from "./bundled-plugins.js";
import {
  revalidatePluginManifest,
  type PluginManifest,
  type ValidatedPluginManifest,
} from "./plugin-manifest.js";

/** Registration remains disconnected from app/room/HTTP and legacy loaders. */
export interface PluginRegisterContext {
  readonly manifest: PluginManifest;
  readonly namespace: string;
  readonly packageRoot: string;
  readonly generation: number;
}

export interface PluginRegistration {
  readonly status: "available" | "unavailable";
  readonly unavailableReason?: string;
  readonly services?: Readonly<Record<string, unknown>>;
  readonly dispose?: () => void | Promise<void>;
}

export type PluginRegister = (context: PluginRegisterContext) => PluginRegistration | Promise<PluginRegistration>;

export interface PluginModule {
  readonly default?: PluginRegister | { readonly register?: PluginRegister };
  readonly register?: PluginRegister;
}

/** Required injection: the host performs zero module resolution by itself. */
export type PluginImporter = (entrypointPath: string, plugin: ValidatedPluginManifest) => Promise<unknown>;
export type PluginRevalidator = (plugin: ValidatedPluginManifest) => Promise<ValidatedPluginManifest>;

export interface RegisteredPlugin {
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly status: "available" | "unavailable";
  readonly unavailableReason?: string;
  /** Declarations only; neither field grants authority. */
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
  readonly importer: PluginImporter;
  /** Default = full manifest/path re-read immediately before importer call. */
  readonly revalidate?: PluginRevalidator;
  /** Observability only; sink failures never affect lifecycle. */
  readonly onEvent?: (event: PluginHostEvent) => void;
}

export type PluginHostEvent =
  | { readonly kind: "skipped"; readonly generation: number; readonly reason: string; readonly namespace?: string }
  | { readonly kind: "registered"; readonly generation: number; readonly namespace: string; readonly status: "available" | "unavailable" }
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
  readonly services: Readonly<Record<string, unknown>>;
  readonly dispose?: () => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function moduleRegister(moduleNamespace: unknown, namespace: string): PluginRegister {
  if (!isRecord(moduleNamespace)) throw new PluginHostError("entrypoint did not export a module object", namespace);
  const candidate = (moduleNamespace as PluginModule).default ?? moduleNamespace;
  if (typeof candidate === "function") return candidate as PluginRegister;
  if (isRecord(candidate) && typeof candidate.register === "function") return candidate.register as PluginRegister;
  if (typeof (moduleNamespace as PluginModule).register === "function") return (moduleNamespace as PluginModule).register as PluginRegister;
  throw new PluginHostError("entrypoint must export a register function", namespace);
}

function registrationValue(value: unknown, namespace: string): PluginRegistration {
  if (!isRecord(value) || (value.status !== "available" && value.status !== "unavailable")) {
    throw new PluginHostError("register must return an available or unavailable registration", namespace);
  }
  if (value.status === "unavailable" && (typeof value.unavailableReason !== "string" || value.unavailableReason.trim().length === 0)) {
    throw new PluginHostError("unavailable registration requires a reason", namespace);
  }
  if (value.status === "available" && value.unavailableReason !== undefined) {
    throw new PluginHostError("available registration cannot include an unavailable reason", namespace);
  }
  if (value.services !== undefined && !isRecord(value.services)) throw new PluginHostError("services must be an object", namespace);
  if (value.dispose !== undefined && typeof value.dispose !== "function") throw new PluginHostError("dispose must be a function", namespace);
  return value as unknown as PluginRegistration;
}

const MAX_GENERATION_ID = Number.MAX_SAFE_INTEGER;

/** Sequential registration + atomic quiet-boundary generation swaps. */
export class PluginHost {
  readonly #importer: PluginImporter;
  readonly #revalidate: PluginRevalidator;
  readonly #onEvent?: (event: PluginHostEvent) => void;
  #entries: readonly LiveEntry[] = Object.freeze([]);
  #current: PluginGeneration = Object.freeze({ generation: 0, registered: Object.freeze([]), skipped: Object.freeze([]) });
  #generation = 0;
  #leases = 0;
  #busy = false;
  #closed = false;
  #shutdownPromise: Promise<void> | undefined;

  constructor(options: PluginHostOptions) {
    if (typeof options.importer !== "function") throw new PluginHostError("an importer must be injected");
    if (options.revalidate !== undefined && typeof options.revalidate !== "function") throw new PluginHostError("revalidate must be a function");
    this.#importer = options.importer;
    this.#revalidate = options.revalidate ?? revalidatePluginManifest;
    this.#onEvent = options.onEvent;
  }

  get current(): PluginGeneration {
    return this.#current;
  }

  get activeTurnLeases(): number {
    return this.#leases;
  }

  acquireTurnLease(): () => void {
    if (this.#closed) throw new PluginHostError("turn leases are refused after shutdown");
    this.#leases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#leases -= 1;
    };
  }

  async reload(inventory: readonly BundledPluginInventoryItem[]): Promise<PluginGeneration> {
    if (this.#closed) throw new PluginHostError("reload is refused after shutdown");
    if (this.#busy) throw new PluginHostError("a lifecycle operation is already in progress");
    if (this.#leases !== 0) throw new PluginHostError("reload requires zero active turn leases");
    if (this.#generation >= MAX_GENERATION_ID) throw new PluginHostError("generation id space exhausted; create a new plugin host");
    this.#busy = true;
    try {
      this.#generation += 1; // attempts that execute plugin code never reuse an id
      const generation = this.#generation;
      const previousGeneration = this.#current.generation;
      const skipped: SkippedPlugin[] = [];
      const eligible: BundledPluginCompatible[] = [];
      const namespaces = new Map<string, string>();
      for (const item of inventory) {
        if (item.status !== "compatible") {
          const entry: SkippedPlugin = item.status === "invalid"
            ? { manifestPath: item.manifestPath, reason: item.reason }
            : { namespace: item.namespace, reason: item.reason };
          skipped.push(Object.freeze(entry));
          this.#emit({ kind: "skipped", generation, reason: entry.reason, namespace: entry.namespace });
          continue;
        }
        const expected = bundledPluginNamespace(item.plugin.manifest.name);
        if (item.namespace !== expected) throw new PluginHostError(`non-canonical plugin namespace; expected ${expected}`, item.namespace);
        const previousPath = namespaces.get(item.namespace);
        if (previousPath) {
          throw new PluginHostError(`duplicate plugin namespace: ${previousPath} and ${item.plugin.manifestPath}`, item.namespace);
        }
        namespaces.set(item.namespace, item.plugin.manifestPath);
        eligible.push(item);
      }

      const built: LiveEntry[] = [];
      try {
        for (const item of eligible) built.push(await this.#register(item, generation));
      } catch (error) {
        await this.#disposeAll(built, generation);
        throw error instanceof PluginHostError ? error : new PluginHostError(errorReason(error), undefined, { cause: error });
      }

      // Import/register can yield; recheck immediately before the synchronous swap.
      if (this.#leases !== 0) {
        await this.#disposeAll(built, generation);
        throw new PluginHostError("reload requires zero active turn leases");
      }

      const previous = this.#entries;
      const next: PluginGeneration = Object.freeze({
        generation,
        registered: Object.freeze(built.map((entry) => entry.summary)),
        skipped: Object.freeze(skipped),
      });
      this.#entries = Object.freeze([...built]);
      this.#current = next;
      await this.#disposeAll(previous, previousGeneration);
      return next;
    } finally {
      this.#busy = false;
    }
  }

  /** Refuse active leases; concurrent successful callers await one teardown. */
  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    if (this.#busy) return Promise.reject(new PluginHostError("a lifecycle operation is already in progress"));
    if (this.#leases !== 0) return Promise.reject(new PluginHostError("shutdown requires zero active turn leases"));
    this.#busy = true;
    this.#closed = true;
    this.#shutdownPromise = this.#performShutdown();
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<void> {
    try {
      const previous = this.#entries;
      const generation = this.#current.generation;
      this.#entries = Object.freeze([]);
      this.#current = Object.freeze({ generation, registered: Object.freeze([]), skipped: Object.freeze([]) });
      await this.#disposeAll(previous, generation);
    } finally {
      this.#busy = false;
    }
  }

  async #register(item: BundledPluginCompatible, generation: number): Promise<LiveEntry> {
    const namespace = item.namespace;
    let plugin: ValidatedPluginManifest;
    let moduleNamespace: unknown;
    try {
      plugin = await this.#revalidate(item.plugin);
      if (!plugin.engineCompatibility.compatible) throw new Error(plugin.engineCompatibility.reason ?? "engine became incompatible");
      moduleNamespace = await this.#importer(plugin.entrypointPath, plugin);
    } catch (error) {
      throw new PluginHostError(`import preflight failed: ${errorReason(error)}`, namespace, { cause: error });
    }
    const register = moduleRegister(moduleNamespace, namespace);
    const context: PluginRegisterContext = Object.freeze({
      manifest: plugin.manifest,
      namespace,
      packageRoot: plugin.packageRoot,
      generation,
    });

    let raw: unknown;
    try {
      raw = await register.call(moduleNamespace, context);
      const registration = registrationValue(raw, namespace);
      const summary: RegisteredPlugin = Object.freeze({
        namespace,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        status: registration.status,
        ...(registration.unavailableReason ? { unavailableReason: registration.unavailableReason } : {}),
        permissions: plugin.manifest.permissions,
        requiredCaps: plugin.manifest.requiredCaps,
      });
      this.#emit({ kind: "registered", generation, namespace, status: registration.status });
      return {
        summary,
        services: Object.freeze({ ...(registration.services ?? {}) }),
        ...(registration.dispose ? { dispose: registration.dispose } : {}),
      };
    } catch (error) {
      // A malformed registration may still expose a valid cleanup function.
      if (isRecord(raw) && typeof raw.dispose === "function") {
        try { await raw.dispose(); } catch { /* original registration failure remains authoritative */ }
      }
      throw error instanceof PluginHostError
        ? error
        : new PluginHostError(`register failed: ${errorReason(error)}`, namespace, { cause: error });
    }
  }

  async #disposeAll(entries: readonly LiveEntry[], generation: number): Promise<void> {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry?.dispose) continue;
      const namespace = entry.summary.namespace;
      try {
        await entry.dispose();
        this.#emit({ kind: "disposed", generation, namespace });
      } catch (error) {
        this.#emit({ kind: "dispose-failed", generation, namespace, reason: errorReason(error) });
      }
    }
  }

  #emit(event: PluginHostEvent): void {
    if (!this.#onEvent) return;
    try { this.#onEvent(event); } catch { /* observability never changes lifecycle */ }
  }
}
