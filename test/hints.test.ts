import test from "node:test";
import assert from "node:assert/strict";
import "../src/harness/index.js";
import { buildFileHints, sdkThinkingLevels, sdkToolNames, type FieldHint, type FileHints, type HintSources } from "../src/services/hints.js";

const sources: HintSources = {
  agentIds: ["gaia", "sidia"],
  roomIds: ["default", "lab"],
  toolNames: ["read", "bash", "memory"],
  thinkingLevels: ["off", "medium"],
  models: [
    { provider: "anthropic", providerLabel: "Anthropic", id: "claude-sonnet-4-6", label: "Claude Sonnet", configured: true, subscription: true },
    { provider: "ollama", providerLabel: "Ollama", id: "llama3", label: "Llama 3", configured: false, subscription: false },
  ],
  skills: [],
};

function hint(hints: FileHints | undefined, key: string): FieldHint {
  assert.ok(hints, "hints missing");
  const value = hints[key];
  assert.ok(value && key !== "_harness", `hint missing: ${key}`);
  return value as FieldHint;
}

test("config and agent harness pickers expose Pi only", () => {
  const config = buildFileHints({ label: ".gaia/config.json", kind: "json" }, sources);
  assert.deepEqual(hint(config, "harness").options?.map((option) => option.value), ["pi"]);
  const agent = buildFileHints({ label: "agents/gaia/agent.json", kind: "json" }, sources);
  assert.deepEqual(hint(agent, "harness").options?.map((option) => option.value), ["pi"]);
  assert.deepEqual(agent?._harness.configs.pi?.hiddenFields.sort(), ["mcpServers", "permissionMode"]);
  assert.equal(Object.keys(agent?._harness.configs ?? {}).length, 1);
});

test("Pi hints retain model, tool, and account configuration", () => {
  const hints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json", content: JSON.stringify({ harness: "pi" }) }, sources);
  assert.equal(hint(hints, "tools").input, "multiselect");
  assert.equal(hint(hints, "model.provider").hidden, false);
  assert.ok(hint(hints, "model.name").options?.some((option) => option.value === "claude-sonnet-4-6"));
  const accounts = buildFileHints({ label: "accounts.json", kind: "json" }, sources);
  assert.deepEqual(hint(accounts, "accounts.[].harness").options?.map((option) => option.value), ["pi"]);
  assert.ok(accounts?.["accounts.[].credentials.oauthToken"]);
});

test("tool and thinking vocabularies remain available through Pi", () => {
  const names = sdkToolNames(process.cwd());
  for (const expected of ["read", "memory", "recall", "summon", "web"]) assert.ok(names.includes(expected), `${expected} present`);
  assert.deepEqual(sdkThinkingLevels(), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});
