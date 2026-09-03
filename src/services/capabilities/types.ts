// Capability broker — shared shapes. See resolver.ts / broker.ts for the two
// halves: resolving WHAT a {roomId, agentId} context is granted (data-driven,
// trust-floored) and AUTHORIZING one plugin's declared requirement against it.
// Never merge these: a plugin's manifest states a NEED (plugins/manifest.ts),
// never a GRANT — grants come only from the host-side policy this module
// resolves.

/** One authorization's identity — every capability decision is scoped to
 * exactly this triple, never ambient / process-global. `workspaceId` is
 * required (not derivable from `roomId` alone: a daemon serves many
 * workspaces, and room ids are workspace-scoped, not globally unique) — a
 * real host-side source (daemon.ts's grantSource/trustSource) resolves
 * workspace + agent config from it. */
export interface CapabilityContext {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly agentId: string;
}

/** Host-side, data-only capability policy. Both fields are plain declared
 * lists (workspace config, agent config) — never code, never a plugin's own
 * output. `agent` and `workspace` are unioned by the resolver, not one
 * overriding the other: neither tier can everything the other doesn't. */
export interface CapabilityGrantPolicy {
  readonly workspace?: readonly string[];
  readonly agent?: readonly string[];
}

/** Result of checking one plugin's requiredCaps against a resolved grant set. */
export interface CapabilityDecision {
  readonly allowed: boolean;
  /** requiredCaps entries not present in the grant set; empty when allowed. */
  readonly missing: readonly string[];
}

/** Minimal shape the broker needs from a registered plugin — declarations
 * only (plugins/registry.ts#RegisteredPlugin), never the plugin's own services. */
export interface CapabilityRequester {
  readonly namespace: string;
  readonly requiredCaps: readonly string[];
}

/** Resolves the data-only grant policy for one context. Implementations read
 * workspace/agent config; they must never consult the plugin being
 * authorized (that would be self-authorization). */
export type CapabilityGrantSource = (context: CapabilityContext) => CapabilityGrantPolicy | undefined;

/** Resolves the effective trust bit for one context (mirrors
 * summons.ts#effectiveTrust — agent bit AND inherited untrusted tier). */
export type CapabilityTrustSource = (context: CapabilityContext) => boolean;
