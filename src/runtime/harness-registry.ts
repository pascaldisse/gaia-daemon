// One descriptor per harness. A harness is added by dropping in one
// `runtime/<x>.ts` module that calls `registerHarness(...)` at its bottom and
// adding one import line to the barrel (`runtime/index.ts`). Nothing else in the
// codebase learns the harness id: the factory, the settings UI, the config
// parsers, and the capability lookups all iterate this registry generically.
//
// Differences between harnesses live as *data on the spec* (capabilities + ui),
// read uniformly — never as `=== "claude"` branches scattered across modules.

import type { HarnessHost } from "../app/harness-bridge.js";
import type { HarnessCapabilities } from "./capabilities.js";
import type { AgentRuntime, BaseRuntimeOptions } from "./types.js";

/**
 * Everything a runtime needs to be constructed, regardless of harness. A spec's
 * `create` picks the fields it cares about (Pi ignores `harnessHost`, the
 * subprocess harnesses use it) — so the factory hands every harness the same
 * context and never branches.
 */
export interface RuntimeCreateContext extends BaseRuntimeOptions {
  /** Daemon bridge for subprocess harnesses' memory/recall/summon CLI. */
  harnessHost?: HarnessHost;
}

/** Settings-UI metadata for a harness. Field *visibility* is NOT here — it is
 *  derived from `capabilities` (see settings-hints.ts) so the UI never
 *  re-encodes a backend truth. */
export interface HarnessUi {
  label: string;
  description: string;
  /** If set, the model provider is locked to this value; the UI hides the provider selector. */
  lockedProvider?: string;
  /** If set, model name options are filtered to these provider ids. */
  modelProviderIds?: string[];
  /**
   * If set, the model name selector offers exactly these values instead of the
   * Pi model catalog. Used by harnesses whose `--model` takes its own aliases —
   * e.g. Claude Code accepts "opus"/"sonnet"/"haiku".
   */
  modelNameOptions?: string[];
}

/** What a harness needs to route its LLM egress through the daemon's loopback proxy. */
export interface CredentialProxyContext {
  /** The loopback proxy mount the harness's LLM calls should hit. */
  proxyUrl: string;
  /** The per-turn token the harness presents instead of the real key. */
  token: string;
  /** A per-room writable scratch dir the harness may relocate its cred store into. */
  scratchDir: string;
}

/** How a harness routes its egress through the proxy + which extra paths to deny-read. */
export interface CredentialProxyWiring {
  /** Env vars to set on the runner so this harness's LLM calls reach the proxy with the token. */
  env?: Record<string, string>;
  /** Extra paths to deny-read in the sandbox (e.g. this harness's real cred store). */
  denyRead?: string[];
}

export interface HarnessSpec {
  id: string;
  capabilities: HarnessCapabilities;
  ui: HarnessUi;
  /** Build the runtime for this harness from the uniform construction context. */
  create(ctx: RuntimeCreateContext): AgentRuntime;
  /**
   * Credential-proxy wiring for this harness, as DATA on the spec. When the proxy
   * is enabled `RunnerHost` calls this and applies the result UNIFORMLY for every
   * harness — it never branches on the harness id. Absent ⇒ this harness needs no
   * extra wiring (it has no API key to hide, e.g. an OAuth-only mode). See AGENTS.md
   * §RULE #0: the shared layer must not special-case a harness.
   */
  credentialProxy?(ctx: CredentialProxyContext): CredentialProxyWiring;
}

const registry = new Map<string, HarnessSpec>();

/** Self-registration entry point: each `runtime/<x>.ts` calls this at its bottom. */
export function registerHarness(spec: HarnessSpec): void {
  registry.set(spec.id, spec);
}

export function harnessSpecs(): HarnessSpec[] {
  return [...registry.values()];
}

/** Safe lookup: undefined for an unknown harness. */
export function findHarness(id: string): HarnessSpec | undefined {
  return registry.get(id);
}

/** Strict lookup used by the factory: throws for an unknown harness. */
export function harnessSpecFor(id: string): HarnessSpec {
  const spec = registry.get(id);
  if (!spec) throw new Error(`Unsupported harness: ${id}`);
  return spec;
}

/** Capabilities for a harness id, falling back to Pi's for an unknown harness. */
export function capabilitiesFor(id: string): HarnessCapabilities {
  const spec = registry.get(id) ?? registry.get("pi");
  if (!spec) throw new Error("No harnesses registered");
  return spec.capabilities;
}

/** The single harness parser: a value is a harness iff it is a registered id. */
export function parseHarness(raw: unknown): string | undefined {
  return typeof raw === "string" && registry.has(raw) ? raw : undefined;
}
