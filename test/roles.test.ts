import test from "node:test";
import assert from "node:assert/strict";
import { effectiveAgentSkills, effectiveAgentTools, parseRoleMarkdown } from "../src/domain/roles.js";
import { agentConfigTemplate } from "../src/domain/agents.js";
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
  assert.deepEqual(effectiveAgentTools(agent, role), ["web", "bash"]);
  assert.deepEqual(effectiveAgentSkills(agent, role), ["brave-search"]);
  assert.deepEqual(effectiveAgentTools({ ...agent, toolOverride: ["read", "edit"] }, role), ["read", "edit"]);
  assert.deepEqual(effectiveAgentSkills({ ...agent, skillOverride: ["research"] }, role), ["research"]);
});

test("new-agent config leaves tools inheritable for a later default role", () => {
  assert.equal("tools" in agentConfigTemplate("worker", "Worker", "•", undefined), false);
  assert.deepEqual(agentConfigTemplate("worker", "Worker", "•", ["read"]).tools, ["read"]);
});
