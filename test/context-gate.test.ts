// Context-gate units: the token estimate, the configurable threshold, and each
// harness's a-priori context window (the % the warning shows before a turn).

import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../src/core/tokens.js";
import { DEFAULT_CONTEXT_WARN_TOKENS, parseWorkspaceConfig } from "../src/core/config.js";
import { claudeContextWindow } from "../src/harness/claude.js";
import { contextWindowFor } from "../src/harness/spec.js";
import "../src/harness/claude.js"; // registers the claude spec

test("estimateTokens: ~4 chars/token, zero for empty", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(400)), 100);
  assert.equal(estimateTokens(undefined as unknown as string), 0);
});

test("parseWorkspaceConfig: contextGate threshold parses, junk drops, default is exported", () => {
  assert.equal(DEFAULT_CONTEXT_WARN_TOKENS, 100_000);
  const ok = parseWorkspaceConfig({ contextGate: { warnAboveTokens: 250_000 } }, () => true);
  assert.deepEqual(ok.contextGate, { warnAboveTokens: 250_000 });
  // 0 is a valid explicit "disable".
  assert.deepEqual(parseWorkspaceConfig({ contextGate: { warnAboveTokens: 0 } }, () => true).contextGate, { warnAboveTokens: 0 });
  // Bad shapes drop to absent (→ the default applies at the use site).
  assert.equal(parseWorkspaceConfig({ contextGate: { warnAboveTokens: -5 } }, () => true).contextGate, undefined);
  assert.equal(parseWorkspaceConfig({ contextGate: { warnAboveTokens: "lots" } }, () => true).contextGate, undefined);
  assert.equal(parseWorkspaceConfig({}, () => true).contextGate, undefined);
});

test("claudeContextWindow: haiku is 200k, the rest 1M, explicit pins honored", () => {
  assert.equal(claudeContextWindow("opus"), 1_000_000);
  assert.equal(claudeContextWindow("sonnet"), 1_000_000);
  assert.equal(claudeContextWindow("fable"), 1_000_000);
  assert.equal(claudeContextWindow("haiku"), 200_000);
  assert.equal(claudeContextWindow("opus[1m]"), 1_000_000);
  assert.equal(claudeContextWindow("opus[200k]"), 200_000); // a pinned smaller window
  assert.equal(claudeContextWindow(undefined), 1_000_000);
});

test("contextWindowFor: reads the claude spec's declaration; unknown harness → undefined", () => {
  assert.equal(contextWindowFor("claude", "opus"), 1_000_000);
  assert.equal(contextWindowFor("claude", "haiku"), 200_000);
  assert.equal(contextWindowFor("no-such-harness", "opus"), undefined);
});
