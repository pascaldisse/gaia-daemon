import test from "node:test";
import assert from "node:assert/strict";
import { resolveApiModelAlias, findModelWithAlias } from "../src/harness/model-aliases.js";

test("resolveApiModelAlias maps short tier names to canonical registry ids", () => {
  assert.equal(resolveApiModelAlias("fable"), "claude-fable-5");
  assert.equal(resolveApiModelAlias("opus"), "claude-opus-4-8");
  assert.equal(resolveApiModelAlias("sonnet"), "claude-sonnet-5");
  assert.equal(resolveApiModelAlias("haiku"), "claude-haiku-4-5");
});

test("resolveApiModelAlias passes through already-canonical / unknown names", () => {
  assert.equal(resolveApiModelAlias("claude-fable-5"), "claude-fable-5");
  assert.equal(resolveApiModelAlias("gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(resolveApiModelAlias("deepseek-v4-pro"), "deepseek-v4-pro");
});

test("findModelWithAlias returns a direct hit without aliasing", () => {
  const registry = {
    find: (_p: string, n: string) => (n === "claude-sonnet-5" ? { id: n } : undefined),
  };
  assert.deepEqual(findModelWithAlias(registry, "anthropic", "claude-sonnet-5"), { id: "claude-sonnet-5" });
});

test("findModelWithAlias falls back to the canonical id when the short name misses", () => {
  // Registry only knows canonical ids — the exact shape of the consolidation /
  // proxy / oauth failure this helper exists to prevent (short name → miss →
  // alias → hit) instead of throwing "model not found".
  const registry = {
    find: (_p: string, n: string) => (n === "claude-fable-5" ? { id: n } : undefined),
  };
  assert.deepEqual(findModelWithAlias(registry, "anthropic", "fable"), { id: "claude-fable-5" });
});

test("findModelWithAlias returns undefined when neither name nor alias resolves", () => {
  const registry = { find: (_p: string, _n: string) => undefined };
  assert.equal(findModelWithAlias(registry, "anthropic", "nope"), undefined);
});
