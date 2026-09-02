// Capability broker — barrel. See resolver.ts (grant resolution, trust floor)
// and broker.ts (per-operation authorization); types.ts for shared shapes.

export { resolveCapabilityGrants } from "./resolver.js";
export { authorizeCapabilities, authorizePlugin, CapabilityBroker, CapabilityDeniedError } from "./broker.js";
export type { CapabilityBrokerOptions } from "./broker.js";
export type {
  CapabilityContext,
  CapabilityDecision,
  CapabilityGrantPolicy,
  CapabilityGrantSource,
  CapabilityRequester,
  CapabilityTrustSource,
} from "./types.js";
