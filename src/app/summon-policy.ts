import type { AgentDefinition } from "../agents/types.js";

/**
 * Is this agent trusted? Trust is a per-agent flag (default true). An untrusted
 * agent (`trust: false`) is the cheap/erratic tier — it gets scoped tasks and a
 * room it can't trash: forced into a sandbox (see resolveSandboxPolicy) and
 * never allowed to summon more workers. Both follow from this one bit.
 */
export function isTrusted(agent: AgentDefinition): boolean {
  return agent.trust !== false;
}

/**
 * May `agent` create summons while running AS a summon (in a nested child room)?
 * Default-deny: a summoned worker can't fan out its own swarm unless it opts in
 * with `allowNestedSummon: true` — and an untrusted agent is refused regardless,
 * so the floor can't be configured away.
 */
export function mayNestSummon(agent: AgentDefinition): boolean {
  if (!isTrusted(agent)) return false;
  return agent.allowNestedSummon === true;
}

/**
 * Whether this turn's bridge token may create summons. Top-level turns always
 * may; a nested (summoned) turn may only if its agent clears mayNestSummon.
 */
export function allowSummonForTurn(agent: AgentDefinition, isSummon: boolean): boolean {
  return isSummon ? mayNestSummon(agent) : true;
}
