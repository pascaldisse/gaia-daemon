// Capability invocation broker — the only place a plugin's declared
// requiredCaps (plugins/manifest.ts, surfaced by the canonical registry) is checked against what a {roomId, agentId} context is
// actually granted. A plugin registration carries no authority of its own:
// requiredCaps is a NEED, never a GRANT, and this module never accepts a
// grant set from the plugin side — only from an injected CapabilityGrantSource
// / CapabilityTrustSource the host wires (daemon/services layer), per
// AGENTS.md §A12 "plugin declarations never self-authorize".

import { resolveCapabilityGrants } from "./resolver.js";
import type {
  CapabilityContext,
  CapabilityDecision,
  CapabilityGrantSource,
  CapabilityRequester,
  CapabilityTrustSource,
} from "./types.js";

export class CapabilityDeniedError extends Error {
  readonly namespace: string;
  readonly context: CapabilityContext;
  readonly missing: readonly string[];
  constructor(namespace: string, context: CapabilityContext, missing: readonly string[]) {
    super(
      `plugin "${namespace}" denied: missing capability grant(s) ${missing.join(", ")} `
        + `for room=${context.roomId} agent=${context.agentId}`,
    );
    this.name = "CapabilityDeniedError";
    this.namespace = namespace;
    this.context = context;
    this.missing = missing;
  }
}

/** Pure check: does `grants` cover every entry of `requiredCaps`? Exported
 * standalone so callers that already hold a resolved grant set (e.g. a
 * request-scoped cache) don't need a full CapabilityBroker. */
export function authorizeCapabilities(
  requiredCaps: readonly string[],
  grants: ReadonlySet<string>,
): CapabilityDecision {
  const missing = requiredCaps.filter((cap) => !grants.has(cap));
  return Object.freeze({ allowed: missing.length === 0, missing: Object.freeze(missing) });
}

/** Authorize one registered plugin's requiredCaps against an already-resolved
 * grant set. Throws CapabilityDeniedError on denial — a call site cannot
 * silently continue past a false-y decision object. */
export function authorizePlugin(
  plugin: CapabilityRequester,
  context: CapabilityContext,
  grants: ReadonlySet<string>,
): void {
  const decision = authorizeCapabilities(plugin.requiredCaps, grants);
  if (!decision.allowed) throw new CapabilityDeniedError(plugin.namespace, context, decision.missing);
}

export interface CapabilityBrokerOptions {
  /** Host-side grant policy lookup; never the plugin itself. */
  readonly grantSource: CapabilityGrantSource;
  /** Host-side trust lookup (summons.ts#effectiveTrust or equivalent). */
  readonly trustSource: CapabilityTrustSource;
}

/**
 * One authorization gate per (grantSource, trustSource) pair, reused across
 * every plugin operation in the daemon. Construction takes injected sources
 * only — the broker never reads plugin state, config files, or trust bits
 * itself, so its authorization path can never share a failure mode with the
 * plugin registration path it is gating (AGENTS.md §verify — independent
 * check).
 */
export class CapabilityBroker {
  readonly #grantSource: CapabilityGrantSource;
  readonly #trustSource: CapabilityTrustSource;

  constructor(options: CapabilityBrokerOptions) {
    if (typeof options.grantSource !== "function") throw new TypeError("grantSource must be a function");
    if (typeof options.trustSource !== "function") throw new TypeError("trustSource must be a function");
    this.#grantSource = options.grantSource;
    this.#trustSource = options.trustSource;
  }

  /** Resolved grant set for one context, without checking any plugin against
   * it. Exposed for callers that need to inspect grants directly (e.g. a
   * capability-aware UI listing), never for a plugin to read its own grants
   * and decide for itself. */
  grantsFor(context: CapabilityContext): ReadonlySet<string> {
    const trusted = this.#trustSource(context);
    // Untrusted floor: grantSource is not even consulted, so a malformed or
    // unavailable policy source can never accidentally widen it.
    if (!trusted) return resolveCapabilityGrants(undefined, false);
    return resolveCapabilityGrants(this.#grantSource(context), true);
  }

  /** Decide, without throwing. */
  decide(plugin: CapabilityRequester, context: CapabilityContext): CapabilityDecision {
    return authorizeCapabilities(plugin.requiredCaps, this.grantsFor(context));
  }

  /** Authorize, throwing CapabilityDeniedError on denial. This is the call
   * every plugin operation invocation must go through before the plugin's own
   * code runs — the plugin never sees this decision beforehand and cannot
   * influence it. */
  authorize(plugin: CapabilityRequester, context: CapabilityContext): void {
    const decision = this.decide(plugin, context);
    if (!decision.allowed) throw new CapabilityDeniedError(plugin.namespace, context, decision.missing);
  }
}
