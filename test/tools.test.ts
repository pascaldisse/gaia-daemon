import test from "node:test";
import assert from "node:assert/strict";
import type { AgentDef } from "../src/core/types.js";
import { gaiaCliPointer } from "../src/harness/prompt.js";
import { INCOGNITO_STRIPPED_TOOLS, stripIncognitoTools } from "../src/harness/tools.js";

function agentWith(tools: string[]): AgentDef {
  return { id: "a", tools } as unknown as AgentDef;
}

test("the uniform pointer resolver passes static docs through and injects live context into dynamic docs", () => {
  const pointer = gaiaCliPointer(["memory", "summon"], ["memory", "summon"], {
    availableAgents: [{ id: "gaia", label: "Gaia" }, { id: "ghoul-sol", label: "Ghoul Sol" }],
  });
  assert.match(pointer, /gaia mem list\|read\|add/);
  assert.match(pointer, /`gaia summon \[--worktree\] <agent> "<task>"`/);
  assert.match(pointer, /Available agents: gaia, ghoul-sol/);
});

test("stripIncognitoTools removes memory + recall, keeps everything else (incl. summon)", () => {
  const stripped = stripIncognitoTools(agentWith(["read", "bash", "edit", "write", "web", "memory", "recall", "summon"]));
  assert.deepEqual(stripped.tools, ["read", "bash", "edit", "write", "web", "summon"]);
  assert.ok(!stripped.tools.includes("memory"));
  assert.ok(!stripped.tools.includes("recall"));
  assert.ok(stripped.tools.includes("summon"), "summon is NOT a memory tool and stays");
});

test("stripIncognitoTools returns the SAME object when there is nothing to strip", () => {
  const agent = agentWith(["read", "bash", "edit", "write"]);
  assert.equal(stripIncognitoTools(agent), agent, "no allocation when no memory tools present");
});

test("stripIncognitoTools does not mutate the input agent", () => {
  const agent = agentWith(["read", "memory", "recall"]);
  const stripped = stripIncognitoTools(agent);
  assert.deepEqual(agent.tools, ["read", "memory", "recall"], "original is untouched");
  assert.deepEqual(stripped.tools, ["read"]);
});

test("the stripped set is exactly memory + recall", () => {
  assert.deepEqual([...INCOGNITO_STRIPPED_TOOLS].sort(), ["memory", "recall"]);
});
