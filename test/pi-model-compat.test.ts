import { test } from "bun:test";
import assert from "node:assert/strict";
import { withAdaptiveThinkingCompat } from "../src/harness/pi/model-compat.ts";

const model = (id: string, api = "anthropic-messages", compat?: Record<string, unknown>) =>
  ({ id, api, provider: "anthropic", reasoning: true, ...(compat ? { compat } : {}) }) as never;

test("Claude 5-generation anthropic models get forceAdaptiveThinking", () => {
  for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-sonnet-5-5"]) {
    const out = withAdaptiveThinkingCompat(model(id)) as { compat: { forceAdaptiveThinking: boolean } };
    assert.equal(out.compat.forceAdaptiveThinking, true, id);
  }
});

test("models below Claude 5 are untouched (budget thinking stays)", () => {
  for (const id of ["claude-opus-4-8", "claude-haiku-4-5", "claude-sonnet-4-5"]) {
    const input = model(id);
    assert.equal(withAdaptiveThinkingCompat(input), input, id);
  }
});

test("an explicit catalog value is respected, both true and false", () => {
  const explicitFalse = model("claude-opus-5", "anthropic-messages", { forceAdaptiveThinking: false });
  assert.equal(withAdaptiveThinkingCompat(explicitFalse), explicitFalse);
  const existing = model("claude-sonnet-5-5", "anthropic-messages", { forceAdaptiveThinking: true, supportsStrictTools: true });
  assert.equal(withAdaptiveThinkingCompat(existing), existing);
});

test("non-anthropic APIs and undefined pass through; input is never mutated", () => {
  const openai = model("claude-opus-5", "openai-completions");
  assert.equal(withAdaptiveThinkingCompat(openai), openai);
  assert.equal(withAdaptiveThinkingCompat(undefined), undefined);
  const input = model("claude-fable-5-1");
  withAdaptiveThinkingCompat(input);
  assert.equal((input as { compat?: unknown }).compat, undefined);
});
