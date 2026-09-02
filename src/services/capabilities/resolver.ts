// Grant resolution — the ONLY place a capability set is produced. Mirrors the
// trust floor in harness/sandbox/spec.ts#resolveSandboxPolicy: untrusted is
// forced to the empty grant set and no workspace/agent config can widen it.
// Trusted grants are exactly the union of configured policy — nothing is
// granted merely by being trusted; capabilities stay fully data-driven, never
// inferred from harness/model/provider identity (AGENTS.md §RULE0).

import type { CapabilityGrantPolicy } from "./types.js";

const EMPTY_GRANTS: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * Resolve the granted capability set for one context already classified
 * trusted/untrusted by the caller (summons.ts#effectiveTrust or equivalent).
 *
 * - untrusted ⇒ EMPTY, always — same non-overridable floor as the sandbox
 *   tier; `policy` is not even read.
 * - trusted ⇒ union(policy.workspace, policy.agent); an agent-level entry
 *   never has to also appear at workspace level and vice versa.
 */
export function resolveCapabilityGrants(
  policy: CapabilityGrantPolicy | undefined,
  trusted: boolean,
): ReadonlySet<string> {
  if (!trusted) return EMPTY_GRANTS;
  const merged = new Set<string>([...(policy?.workspace ?? []), ...(policy?.agent ?? [])]);
  return Object.freeze(merged);
}
