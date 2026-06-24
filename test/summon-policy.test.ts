import test from "node:test";
import assert from "node:assert/strict";
import type { AgentDefinition } from "../src/agents/types.ts";
import { allowSummonForTurn, isTrusted, mayNestSummon } from "../src/app/summon-policy.ts";

const agent = (over: Partial<AgentDefinition>): AgentDefinition => ({ id: "a", allowNestedSummon: false, ...over }) as AgentDefinition;

test("isTrusted: default trusted; only an explicit false flips it", () => {
  assert.equal(isTrusted(agent({})), true);
  assert.equal(isTrusted(agent({ trust: true })), true);
  assert.equal(isTrusted(agent({ trust: false })), false);
});

test("mayNestSummon: default-deny, opt-in with the flag", () => {
  assert.equal(mayNestSummon(agent({})), false);
  assert.equal(mayNestSummon(agent({ allowNestedSummon: true })), true);
});

test("mayNestSummon: an untrusted agent can never nest-summon, even opted in", () => {
  assert.equal(mayNestSummon(agent({ trust: false, allowNestedSummon: true })), false);
});

test("allowSummonForTurn: top-level always may; nested follows mayNestSummon", () => {
  // Top-level turn (not a summon) — always allowed, even untrusted.
  assert.equal(allowSummonForTurn(agent({ trust: false }), false), true);
  // Nested turn (this room is itself a summon).
  assert.equal(allowSummonForTurn(agent({}), true), false);
  assert.equal(allowSummonForTurn(agent({ allowNestedSummon: true }), true), true);
  assert.equal(allowSummonForTurn(agent({ trust: false, allowNestedSummon: true }), true), false);
});
