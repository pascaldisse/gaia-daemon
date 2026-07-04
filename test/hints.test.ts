import test from "node:test";
import assert from "node:assert/strict";
import "../src/harness/index.js"; // registers pi/claude/codex — hints derive from the registry
import { buildFileHints, sdkThinkingLevels, sdkToolNames, type FieldHint, type FileHints, type HintSources } from "../src/services/hints.js";

const sources: HintSources = {
  agentIds: ["gaia", "sidia"],
  roomIds: ["default", "lab"],
  toolNames: ["read", "bash", "memory"],
  thinkingLevels: ["off", "medium"],
  models: [
    { provider: "anthropic", providerLabel: "Anthropic", id: "claude-sonnet-4-6", label: "Claude Sonnet", configured: true, subscription: true },
    { provider: "anthropic", providerLabel: "Anthropic", id: "claude-haiku-4-5", label: "Claude Haiku", configured: true, subscription: true },
    { provider: "ollama", providerLabel: "Ollama", id: "llama3", label: "Llama 3", configured: false, subscription: false },
  ],
};

/** Typed accessor: the FileHints index signature is a union, tests want FieldHint. */
function hint(hints: FileHints | undefined, key: string): FieldHint {
  assert.ok(hints, "hints missing");
  const value = hints[key];
  assert.ok(value && key !== "_harness", `hint missing: ${key}`);
  return value as FieldHint;
}

test("config.json gets harness, agent and room dropdowns and a numeric window", () => {
  const hints = buildFileHints({ label: ".gaia/config.json", kind: "json" }, sources);
  assert.ok(hints);
  assert.equal(hint(hints, "harness").input, "select");
  assert.equal(hint(hints, "harness").optional, true);
  assert.deepEqual(hint(hints, "harness").options?.map((option) => option.value).sort(), ["claude", "codex", "pi"]);
  assert.equal(hint(hints, "defaultAgent").input, "select");
  assert.deepEqual(hint(hints, "defaultAgent").options?.map((option) => option.value), ["gaia", "sidia"]);
  assert.deepEqual(hint(hints, "room").options?.map((option) => option.value), ["default", "lab"]);
  assert.equal(hint(hints, "transcriptWindow").input, "number");
});

test("agent.json gets tools multiselect and grouped model dropdowns", () => {
  const hints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json" }, sources);
  assert.ok(hints);
  assert.equal(hint(hints, "tools").input, "multiselect");
  assert.deepEqual(hint(hints, "tools").options?.map((option) => option.value), ["read", "bash", "memory"]);

  assert.equal(hint(hints, "model.provider").input, "select");
  assert.equal(hint(hints, "model.provider").optional, true);
  assert.deepEqual(hint(hints, "model.provider").options?.map((option) => option.value), ["anthropic", "ollama"]);
  assert.match(hint(hints, "model.provider").options?.[0]?.description ?? "", /2 models · subscription/);
  assert.match(hint(hints, "model.provider").options?.[1]?.description ?? "", /no auth configured/);

  assert.equal(hint(hints, "model.name").groupBy, "model.provider");
  const sonnet = hint(hints, "model.name").options?.find((option) => option.value === "claude-sonnet-4-6");
  assert.equal(sonnet?.group, "anthropic");
  assert.match(sonnet?.description ?? "", /Anthropic · Claude Sonnet · subscription/);

  assert.equal(hint(hints, "thinking").optional, true);
  assert.deepEqual(hint(hints, "thinking").options?.map((option) => option.value), ["off", "medium"]);
});

test("markdown and unknown json files get no hints", () => {
  assert.equal(buildFileHints({ label: "agents/gaia/persona/SOUL.md", kind: "markdown" }, sources), undefined);
  assert.equal(buildFileHints({ label: "app.json", kind: "json" }, sources), undefined);
});

test("agent.json gets harness select (optional, pi/codex/claude)", () => {
  const hints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json" }, sources);
  assert.ok(hints);
  assert.equal(hint(hints, "harness").input, "select");
  assert.equal(hint(hints, "harness").optional, true);
  assert.deepEqual(hint(hints, "harness").options?.map((option) => option.value).sort(), ["claude", "codex", "pi"]);
});

test("agent.json always includes tools hint; hidden flag set when harness is codex", () => {
  const codexHints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json", content: JSON.stringify({ harness: "codex" }) }, sources);
  assert.ok(codexHints);
  assert.ok(codexHints.tools, "tools hint always present");
  assert.equal(hint(codexHints, "tools").input, "multiselect");
  assert.equal(hint(codexHints, "tools").hidden, true, "tools hidden when saved harness is codex");
  assert.ok(codexHints.harness);
  assert.ok(codexHints["model.provider"]);
});

test("agent.json tools hint not hidden when harness is pi or unset", () => {
  const piHints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json", content: JSON.stringify({ harness: "pi" }) }, sources);
  assert.equal(hint(piHints, "tools").input, "multiselect");
  assert.equal(hint(piHints, "tools").hidden, false, "tools not hidden when harness is pi");

  const unsetHints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json" }, sources);
  assert.equal(hint(unsetHints, "tools").input, "multiselect");
  assert.equal(hint(unsetHints, "tools").hidden, false, "tools not hidden when harness is unset");
});

test("agent.json tools hint not hidden when harness is claude (tools are the control surface)", () => {
  const claudeHints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json", content: JSON.stringify({ harness: "claude" }) }, sources);
  assert.equal(hint(claudeHints, "tools").hidden, false, "tools visible for claude");
});

test("agent.json permissionMode hint is shown only for claude", () => {
  const claudeHints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json", content: JSON.stringify({ harness: "claude" }) }, sources);
  assert.equal(hint(claudeHints, "permissionMode").input, "select");
  assert.equal(hint(claudeHints, "permissionMode").hidden, false, "shown for claude");
  assert.ok(hint(claudeHints, "permissionMode").options?.some((option) => option.value === "plan"));

  const piHints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json", content: JSON.stringify({ harness: "pi" }) }, sources);
  assert.equal(hint(piHints, "permissionMode").hidden, true, "hidden for pi");

  const codexHints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json", content: JSON.stringify({ harness: "codex" }) }, sources);
  assert.equal(hint(codexHints, "permissionMode").hidden, true, "hidden for codex");
});

test("agent.json for a locked-provider harness hides model.provider and filters model names", () => {
  const claudeHints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json", content: JSON.stringify({ harness: "claude" }) }, sources);
  assert.equal(hint(claudeHints, "model.provider").hidden, true, "provider hidden when the harness locks it");
  assert.equal(hint(claudeHints, "model.name").groupBy, undefined, "no dependent grouping when locked");

  const codexHints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json", content: JSON.stringify({ harness: "codex" }) }, sources);
  // codex filters model names to its provider ids; none of the sample models match.
  assert.deepEqual(hint(codexHints, "model.name").options, []);
});

test("hints carry _harness meta with per-harness hidden fields and ui locks", () => {
  const hints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json" }, sources);
  assert.ok(hints?._harness);
  const configs = hints._harness.configs;
  assert.deepEqual(configs.codex?.hiddenFields.sort(), ["permissionMode", "tools"]);
  assert.deepEqual(configs.pi?.hiddenFields.sort(), ["mcpServers", "permissionMode"]);
  assert.deepEqual(configs.claude?.hiddenFields, []);
  assert.equal(configs.claude?.lockedProvider, "anthropic");
  assert.deepEqual(configs.claude?.modelNameOptions, ["fable", "opus", "sonnet", "haiku"]);
  assert.deepEqual(configs.codex?.modelProviderIds, ["openai-codex"]);
});

test("voice.json gets boolean and number hints", () => {
  const hints = buildFileHints({ label: "voice.json", kind: "json" }, sources);
  assert.ok(hints);
  assert.equal(hint(hints, "autoStart").input, "boolean");
  assert.equal(hint(hints, "speakOnSilence").input, "boolean");
  assert.equal(hint(hints, "disableThinking").input, "boolean");
  assert.equal(hint(hints, "silenceDelaySec").input, "number");
  assert.equal(hint(hints, "startTimeoutSec").input, "number");
});

test("sdk tool names and thinking levels come from the SDK + tool registry", () => {
  const names = sdkToolNames(process.cwd());
  for (const expected of ["read", "bash", "edit", "write", "grep", "find", "ls", "memory", "recall", "summon"]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
  assert.ok(sdkThinkingLevels().includes("medium"));
  assert.deepEqual(sdkThinkingLevels(), ["off", "minimal", "low", "medium", "high", "xhigh"]);
});
