import test from "node:test";
import assert from "node:assert/strict";
import { buildFileHints, sdkThinkingLevels, sdkToolNames, type HintSources } from "../src/app/settings-hints.ts";

const sources: HintSources = {
  agentIds: ["gaia", "sidia"],
  roomIds: ["default", "lab"],
  runtimes: ["pi"],
  toolNames: ["read", "bash", "memory"],
  thinkingLevels: ["off", "medium"],
  models: [
    { provider: "anthropic", providerLabel: "Anthropic", id: "claude-sonnet-4-6", label: "Claude Sonnet", configured: true, subscription: true },
    { provider: "anthropic", providerLabel: "Anthropic", id: "claude-haiku-4-5", label: "Claude Haiku", configured: true, subscription: true },
    { provider: "ollama", providerLabel: "Ollama", id: "llama3", label: "Llama 3", configured: false, subscription: false },
  ],
};

test("config.json gets agent, room, runtime dropdowns and a numeric window", () => {
  const hints = buildFileHints({ label: ".gaia/config.json", kind: "json" }, sources);
  assert.ok(hints);
  assert.equal(hints.defaultAgent.input, "select");
  assert.deepEqual(hints.defaultAgent.options?.map((option) => option.value), ["gaia", "sidia"]);
  assert.deepEqual(hints.room.options?.map((option) => option.value), ["default", "lab"]);
  assert.deepEqual(hints.runtime.options?.map((option) => option.value), ["pi"]);
  assert.equal(hints.transcriptWindow.input, "number");
});

test("agent.json gets tools multiselect and grouped model dropdowns", () => {
  const hints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json" }, sources);
  assert.ok(hints);
  assert.equal(hints.tools.input, "multiselect");
  assert.deepEqual(hints.tools.options?.map((option) => option.value), ["read", "bash", "memory"]);

  assert.equal(hints["model.provider"].input, "select");
  assert.equal(hints["model.provider"].optional, true);
  assert.deepEqual(hints["model.provider"].options?.map((option) => option.value), ["anthropic", "ollama"]);
  assert.match(hints["model.provider"].options?.[0]?.description ?? "", /2 models · subscription/);
  assert.match(hints["model.provider"].options?.[1]?.description ?? "", /no auth configured/);

  assert.equal(hints["model.name"].groupBy, "model.provider");
  const sonnet = hints["model.name"].options?.find((option) => option.value === "claude-sonnet-4-6");
  assert.equal(sonnet?.group, "anthropic");
  assert.match(sonnet?.description ?? "", /Anthropic · Claude Sonnet · subscription/);

  assert.equal(hints.thinking.optional, true);
  assert.deepEqual(hints.thinking.options?.map((option) => option.value), ["off", "medium"]);
});

test("markdown and unknown json files get no hints", () => {
  assert.equal(buildFileHints({ label: "agents/gaia/persona/SOUL.md", kind: "markdown" }, sources), undefined);
  assert.equal(buildFileHints({ label: "app.json", kind: "json" }, sources), undefined);
});

test("voice.json gets boolean and number hints", () => {
  const hints = buildFileHints({ label: "voice.json", kind: "json" }, sources);
  assert.ok(hints);
  assert.equal(hints.autoStart.input, "boolean");
  assert.equal(hints.speakOnSilence.input, "boolean");
  assert.equal(hints.disableThinking.input, "boolean");
  assert.equal(hints.silenceDelaySec.input, "number");
  assert.equal(hints.startTimeoutSec.input, "number");
});

test("sdk tool names and thinking levels come from the SDK", () => {
  const names = sdkToolNames(process.cwd());
  for (const expected of ["read", "bash", "edit", "write", "grep", "find", "ls", "memory"]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
  assert.ok(sdkThinkingLevels().includes("medium"));
});
