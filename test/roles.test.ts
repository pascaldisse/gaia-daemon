import { test } from "bun:test";
import assert from "node:assert/strict";
import { effectiveAgentSkills, effectiveAgentTools, parseRoleMarkdown } from "../src/domain/roles.js";
import { agentConfigTemplate, gaiaOnlyTools } from "../src/domain/agents.js";
import type { AgentDef } from "../src/core/types.js";
import type { ResolvedRole } from "../src/domain/roles.js";

test("role frontmatter accepts tool and skill defaults", () => {
  const role = parseRoleMarkdown(`---
tools: [web, bash, read]
skills: [brave-search]
---
# Worker
`, "ghoul.md");
  assert.deepEqual(role.tools, ["web", "bash", "read"]);
  assert.deepEqual(role.skills, ["brave-search"]);
  assert.deepEqual(role.diagnostics, []);
});

test("role defaults yield to explicit per-agent Settings overrides", () => {
  const role = { tools: ["web", "bash"], skills: ["brave-search"] } as ResolvedRole;
  const agent = { tools: ["read"], skills: ["plan"] } as AgentDef;
  assert.deepEqual(effectiveAgentTools(agent, role), ["gaia"]);
  assert.deepEqual(effectiveAgentSkills(agent, role), ["brave-search"]);
  assert.deepEqual(effectiveAgentTools({ ...agent, toolOverride: ["read", "edit"] }, role), ["gaia"]);
  assert.deepEqual(effectiveAgentTools({ ...agent, gaiaOnly: false }, role), ["web", "bash"]);
  assert.deepEqual(effectiveAgentTools({ ...agent, toolOverride: ["read", "edit"], gaiaOnly: false }, role), ["read", "edit"]);
  assert.deepEqual(effectiveAgentSkills({ ...agent, skillOverride: ["research"] }, role), ["research"]);
});

test("new-agent config defaults to reversible unified Gaia exposure and leaves tools inheritable", () => {
  const inherited = agentConfigTemplate("worker", "Worker", "•", undefined);
  assert.equal("tools" in inherited, false);
  assert.equal(inherited.gaiaOnly, true);
  assert.deepEqual(agentConfigTemplate("worker", "Worker", "•", ["read"]).tools, ["read"]);
});

test("gaia-only composition strips every routed native duplicate, keeps unique tools, and preserves explicit toolless agents", () => {
  assert.deepEqual(
    gaiaOnlyTools(["bash", "read", "write", "edit", "web", "memory", "mem", "recall", "artifact", "summon", "resume", "caryll", "grep", "gaia"]),
    ["gaia", "grep"],
  );
  assert.deepEqual(gaiaOnlyTools([]), [], "an explicit empty tool list remains a toolless safety boundary");
  assert.deepEqual(gaiaOnlyTools(["read", "web"], false), ["read", "web"], "gaiaOnly:false restores direct exposure");
});
