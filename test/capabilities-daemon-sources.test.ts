// ADV-014 focused tests: the REAL daemon-boot capability sources
// (services/capabilities/daemon-sources.ts) wired into daemon.ts's
// CapabilityBroker, replacing the always-deny stub
// (`grantSource: () => undefined, trustSource: () => false`). Pure over an
// already-loaded Workspace — no daemon/HTTP/process needed to exercise the
// three required scenarios:
//   1. untrusted agent → network capability denied even though granted;
//   2. trusted agent with the capability granted (workspace or agent tier)
//      → allowed;
//   3. granted but trust:false → denied regardless of the grant.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveCapabilityGrants } from "../src/services/capabilities/resolver.js";
import { authorizeCapabilities } from "../src/services/capabilities/broker.js";
import { resolveWorkspaceGrantPolicy, resolveWorkspaceTrust } from "../src/services/capabilities/daemon-sources.js";
import type { AgentDef, Workspace } from "../src/core/types.js";

function makeAgent(id: string, overrides: Partial<AgentDef> = {}): AgentDef {
  const dir = join("/fixture", "agents", id);
  return {
    id,
    displayName: id,
    icon: "\u2022",
    dir,
    configPath: join(dir, "agent.json"),
    personaDir: join(dir, "persona"),
    rolesDir: join(dir, "persona", "roles"),
    soulPath: join(dir, "persona", "SOUL.md"),
    memoryDir: join(dir, "persona", "memory"),
    tools: [],
    ...overrides,
  };
}

function makeWorkspace(agents: Record<string, AgentDef>, grants: Record<string, readonly string[]> = {}): Workspace {
  const root = "/fixture";
  return {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "agents"),
    config: {
      defaultAgent: "agent-1",
      room: "default",
      transcriptWindow: 20,
      agentEndConversation: true,
      memory: {
        autoRecall: false,
        autoRecallBudget: 0,
        embeddings: "off",
        reranker: "off",
        consolidate: { enabled: false, idleMinutes: 0, maxPerDay: 0 },
        decayHalfLifeDays: 0,
      },
      ...(Object.keys(grants).length > 0 ? { plugins: { grants } } : {}),
    },
    contextFiles: [],
    agents,
  };
}

/** Full pipeline used by daemon.ts's grantSource/trustSource →
 * resolveCapabilityGrants → authorizeCapabilities, exactly as CapabilityBroker
 * chains them (broker.ts#grantsFor/decide) — exercised directly here so a
 * fixture-shape bug can't hide behind the broker's own indirection. */
function decide(workspace: Workspace | undefined, agentId: string, requiredCaps: readonly string[]) {
  const trusted = resolveWorkspaceTrust(workspace, agentId);
  const grants = resolveCapabilityGrants(resolveWorkspaceGrantPolicy(workspace, agentId), trusted);
  return authorizeCapabilities(requiredCaps, grants);
}

test("untrusted agent: network capability denied even though workspace config grants it", () => {
  const agent = makeAgent("net-agent"); // trust default (true) — override below to simulate untrusted
  const untrusted = { ...agent, trust: false as const };
  const workspace = makeWorkspace({ [untrusted.id]: untrusted }, { [untrusted.id]: ["network"] });

  assert.equal(resolveWorkspaceTrust(workspace, untrusted.id), false);
  const decision = decide(workspace, untrusted.id, ["network"]);
  assert.deepEqual(decision, { allowed: false, missing: ["network"] });
});

test("trusted + granted (workspace tier): allowed", () => {
  const agent = makeAgent("ws-granted-agent");
  const workspace = makeWorkspace({ [agent.id]: agent }, { [agent.id]: ["network"] });

  assert.equal(resolveWorkspaceTrust(workspace, agent.id), true);
  const decision = decide(workspace, agent.id, ["network"]);
  assert.deepEqual(decision, { allowed: true, missing: [] });
});

test("trusted + granted (agent tier, agent.json capabilities): allowed", () => {
  const agent = makeAgent("agent-granted-agent", { capabilities: ["network"] });
  const workspace = makeWorkspace({ [agent.id]: agent });

  assert.equal(resolveWorkspaceTrust(workspace, agent.id), true);
  const decision = decide(workspace, agent.id, ["network"]);
  assert.deepEqual(decision, { allowed: true, missing: [] });
});

test("granted but trust:false: denied regardless of config", () => {
  const agent = makeAgent("revoked-agent", { trust: false, capabilities: ["network"] });
  const workspace = makeWorkspace({ [agent.id]: agent }, { [agent.id]: ["network"] });

  assert.equal(resolveWorkspaceTrust(workspace, agent.id), false);
  const decision = decide(workspace, agent.id, ["network"]);
  assert.deepEqual(decision, { allowed: false, missing: ["network"] });
});

test("unresolvable workspace (no live RoomService) fails closed: no grants, untrusted", () => {
  assert.equal(resolveWorkspaceTrust(undefined, "anyone"), false);
  assert.equal(resolveWorkspaceGrantPolicy(undefined, "anyone"), undefined);
  const decision = decide(undefined, "anyone", ["network"]);
  assert.deepEqual(decision, { allowed: false, missing: ["network"] });
});

test("unknown agentId in a resolvable workspace is untrusted — never inferred open", () => {
  const workspace = makeWorkspace({}, { "ghost": ["network"] });
  assert.equal(resolveWorkspaceTrust(workspace, "ghost"), false);
  const decision = decide(workspace, "ghost", ["network"]);
  assert.deepEqual(decision, { allowed: false, missing: ["network"] });
});
