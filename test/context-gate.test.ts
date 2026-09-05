import { test } from "bun:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../src/core/tokens.js";
import { DEFAULT_CONTEXT_WARN_TOKENS, parseWorkspaceConfig } from "../src/core/config.js";
import "../src/harness/index.js";
import { contextWindowFor } from "../src/harness/spec.js";

test("estimateTokens: ~4 chars/token, zero for empty", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(400)), 100);
  assert.equal(estimateTokens(undefined as unknown as string), 0);
});

test("parseWorkspaceConfig normalizes legacy harness ids to Pi", () => {
  assert.equal(DEFAULT_CONTEXT_WARN_TOKENS, 100_000);
  const config = parseWorkspaceConfig({ harness: "claude", contextGate: { warnAboveTokens: 250_000 } }, (id) => id === "pi");
  assert.equal(config.harness, "pi");
  assert.deepEqual(config.contextGate, { warnAboveTokens: 250_000 });
  assert.equal(contextWindowFor("pi", "anything"), undefined);
});
