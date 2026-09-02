// Real daemon-boot CapabilityGrantSource/CapabilityTrustSource — the two
// functions daemon.ts injects into the CapabilityBroker it wires into
// PluginRegistry (services/plugins/registry.ts). Pure over an already-loaded
// Workspace (no I/O here: the daemon resolves the live Workspace for a
// context's {workspaceId, roomId} synchronously off its own resident
// RoomService cache before calling these — see daemon.ts's
// #liveWorkspaceFor). No workspace resolvable (e.g. an authorization check
// for a context whose room isn't presently live) fails CLOSED: undefined
// policy / untrusted, exactly like an unknown agent — never inferred open.
//
// Two tiers, matching CapabilityGrantPolicy (types.ts) exactly:
//   - workspace tier = .gaia/config.json `plugins.grants[agentId]` (default
//     {}, i.e. no entry — the room operator's per-agent grant);
//   - agent tier     = agent.json `capabilities` (default [] — the agent's
//     own declared capability list).
// The resolver (resolver.ts) unions them ONLY when trustSource says trusted;
// this module never applies that floor itself — it hands the broker raw
// policy/trust data, exactly once, from exactly one real place each.
import { isTrusted } from "../summons.js";
import type { AgentDef, Workspace } from "../../core/types.js";
import type { CapabilityGrantPolicy } from "./types.js";

function agentFor(workspace: Workspace | undefined, agentId: string): AgentDef | undefined {
  return workspace?.agents[agentId];
}

/**
 * Workspace-tier + agent-tier grant lists for one agent in one workspace.
 * Returns undefined when the workspace isn't resolvable at all (distinct from
 * an empty-but-present policy) — resolveCapabilityGrants treats both the same
 * under the trust floor, but keeping the distinction here lets callers/tests
 * tell "no data" from "data says nothing granted".
 */
export function resolveWorkspaceGrantPolicy(workspace: Workspace | undefined, agentId: string): CapabilityGrantPolicy | undefined {
  if (!workspace) return undefined;
  return {
    workspace: workspace.config.plugins?.grants?.[agentId] ?? [],
    agent: agentFor(workspace, agentId)?.capabilities ?? [],
  };
}

/**
 * Effective trust bit for one agent in one workspace — derives from the same
 * real trust data every other surface uses (services/summons.ts#isTrusted:
 * agent.json `trust`, default true, never config-widenable once false — see
 * domain/agents.ts#mergeAgentConfig's tightening-only merge). An agent that
 * can't be found (workspace unresolved, or the id isn't registered in it) is
 * untrusted — fail closed, never assume trust for unknown identity.
 */
export function resolveWorkspaceTrust(workspace: Workspace | undefined, agentId: string): boolean {
  const agent = agentFor(workspace, agentId);
  return agent !== undefined && isTrusted(agent);
}
