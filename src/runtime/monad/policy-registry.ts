// One descriptor per routing policy. A policy is added by dropping in one
// `runtime/monad/policies/<x>.ts` that calls `registerRoutingPolicy(...)` at its
// bottom and adding one import to the barrel (`runtime/monad/index.ts`). Nothing
// else learns a policy id: the engine, the setup loader, and the config parsers
// iterate this registry generically — never `=== "trinity-head"` branches.
//
// This is the exact shape of harness-registry.ts, on purpose: routing policy is
// to the monad engine what a harness is to the runtime factory — a swappable
// backend selected by data.

import type { RoutingPolicySpec } from "./types.js";

const registry = new Map<string, RoutingPolicySpec>();

/** Self-registration entry point: each `policies/<x>.ts` calls this at its bottom. */
export function registerRoutingPolicy(spec: RoutingPolicySpec): void {
  registry.set(spec.id, spec);
}

export function routingPolicyIds(): string[] {
  return [...registry.keys()];
}

/** Strict lookup used by the engine: throws for an unknown policy. */
export function routingPolicySpecFor(id: string): RoutingPolicySpec {
  const spec = registry.get(id);
  if (!spec) throw new Error(`Unsupported routing policy: ${id}`);
  return spec;
}

/** The single policy parser: a value is a policy iff it is a registered id. */
export function parseRoutingPolicy(raw: unknown): string | undefined {
  return typeof raw === "string" && registry.has(raw) ? raw : undefined;
}
