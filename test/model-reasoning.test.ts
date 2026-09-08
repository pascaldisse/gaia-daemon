import { test } from "bun:test";
import assert from "node:assert/strict";
import { mergeModelReasoningOverrides, parseModelReasoningOverrides } from "../src/core/model-reasoning-config.js";
import { describeModelReasoning, resolveReasoningLevel } from "../src/domain/model-reasoning.js";

test("reasoning override parser keeps exact provider/model identities and valid levels", () => {
  const parsed = parseModelReasoningOverrides({
    anthropic: {
      "same/name": { supportedLevels: ["off", "low", "max", "bogus"], defaultLevel: "low", future: true },
    },
    openai: { "same/name": { supportedLevels: ["off", "high"], defaultLevel: "bogus" } },
  });
  assert.deepEqual(parsed, {
    anthropic: { "same/name": { supportedLevels: ["off", "low", "max"], defaultLevel: "low" } },
    openai: { "same/name": { supportedLevels: ["off", "high"] } },
  });
});

test("global and workspace reasoning overrides merge per exact model", () => {
  assert.deepEqual(
    mergeModelReasoningOverrides(
      { anthropic: { a: { defaultLevel: "low" }, b: { defaultLevel: "medium" } } },
      { anthropic: { a: { supportedLevels: ["off", "high"] } }, openai: { a: { defaultLevel: "high" } } },
    ),
    {
      anthropic: { a: { defaultLevel: "low", supportedLevels: ["off", "high"] }, b: { defaultLevel: "medium" } },
      openai: { a: { defaultLevel: "high" } },
    },
  );
});

test("descriptor collapses native aliases but preserves max distinct from xhigh", () => {
  const descriptor = describeModelReasoning("anthropic", "model", {
    adaptive: true,
    levels: [
      { level: "off", providerValue: "off" },
      { level: "minimal", providerValue: "low" },
      { level: "low", providerValue: "low" },
      { level: "high", providerValue: "high" },
      { level: "xhigh", providerValue: "xhigh" },
      { level: "max", providerValue: "max" },
    ],
  });
  assert.equal(descriptor.status, "known");
  if (descriptor.status !== "known") return;
  assert.deepEqual(descriptor.choices, [
    { level: "off", providerValue: "off" },
    { level: "low", providerValue: "low", aliases: ["minimal"] },
    { level: "high", providerValue: "high" },
    { level: "xhigh", providerValue: "xhigh" },
    { level: "max", providerValue: "max" },
  ]);
  assert.equal(descriptor.adaptive, true);
});

test("unsupported explicit levels reject; obsolete inherited levels resolve conservatively", () => {
  const descriptor = describeModelReasoning("p", "m", undefined, { supportedLevels: ["off", "high"], defaultLevel: "high" });
  assert.throws(() => resolveReasoningLevel(descriptor, "medium", true), /unsupported.*Use one of: off, high/);
  const inherited = resolveReasoningLevel(descriptor, "medium", false);
  assert.equal(inherited.status, "known");
  if (inherited.status === "known") {
    assert.equal(inherited.effectiveLevel, "off");
    assert.equal(inherited.resolution, "conservative");
    assert.equal(inherited.source, "override");
  }
});

test("reasoning false is known off-only while absent metadata remains unknown", () => {
  assert.deepEqual(describeModelReasoning("p", "off-model", { adaptive: false, defaultLevel: "off", levels: [{ level: "off", providerValue: "off" }] }), {
    status: "known", provider: "p", model: "off-model", choices: [{ level: "off", providerValue: "off" }], defaultLevel: "off", adaptive: false, source: "discovered",
  });
  assert.deepEqual(describeModelReasoning("p", "unknown", undefined), { status: "unknown", provider: "p", model: "unknown" });
});
