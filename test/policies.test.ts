import test from "node:test";
import assert from "node:assert/strict";
import type { MonadConfig, MonadObservation, MonadStep } from "../src/core/types.js";
import type { RoutingPolicyContext } from "../src/services/policies/registry.js";
import { PromptDrivenPolicy } from "../src/services/policies/prompt-driven.js";
import { ConductorDagPolicy, parseWorkflow } from "../src/services/policies/conductor-dag.js";
import { decisionFromRouter } from "../src/services/policies/trinity-head.js";

function ctxStub(slots: MonadConfig["slots"], invoke: RoutingPolicyContext["invoke"] = async () => ""): RoutingPolicyContext {
  return { slots, roles: [], maxTurns: 5, coordinatorAgentId: slots[0]?.agentId ?? "", terminate: { on: "verifier-accept", acceptToken: "ACCEPT" }, invoke };
}

function step(index: number, agentId: string, role: string, reply: string): MonadStep {
  return { index, agentId, role, subtask: "", sees: [], reply };
}

const TRIO_SLOTS: MonadConfig["slots"] = [
  { index: 0, agentId: "gaia", label: "thinker", defaultRole: "thinker" },
  { index: 1, agentId: "terry", label: "worker", defaultRole: "worker" },
  { index: 2, agentId: "sidia", label: "verifier", defaultRole: "verifier" },
];

// ---------- prompt-driven: deterministic fallback cycle ----------

test("prompt-driven: no model → thinker first, then worker, then verifier", async () => {
  const policy = new PromptDrivenPolicy({});
  const ctx = ctxStub(TRIO_SLOTS); // invoke returns "" → unparseable → rule floor

  const first = await policy.next({ query: "q", steps: [] }, ctx);
  assert.equal(first.kind, "dispatch");
  if (first.kind === "dispatch") assert.equal(first.decision.role, "thinker");

  const second = await policy.next({ query: "q", steps: [step(0, "gaia", "thinker", "PLAN")] }, ctx);
  assert.equal(second.kind, "dispatch");
  if (second.kind === "dispatch") {
    assert.equal(second.decision.role, "worker");
    assert.equal(second.decision.agentId, "terry");
  }

  const third = await policy.next({ query: "q", steps: [step(0, "gaia", "thinker", "PLAN"), step(1, "terry", "worker", "RESULT")] }, ctx);
  assert.equal(third.kind, "dispatch");
  if (third.kind === "dispatch") assert.equal(third.decision.role, "verifier");
});

test("prompt-driven: verifier REVISE → rework by the worker; ACCEPT → accept", async () => {
  const policy = new PromptDrivenPolicy({});
  const ctx = ctxStub(TRIO_SLOTS);

  const rework = await policy.next(
    { query: "q", steps: [step(0, "terry", "worker", "v1"), step(1, "sidia", "verifier", "REVISE: broken")] },
    ctx,
  );
  assert.equal(rework.kind, "dispatch");
  if (rework.kind === "dispatch") {
    assert.equal(rework.decision.role, "worker");
    assert.match(rework.decision.subtask, /verifier's feedback/);
  }

  const accepted = await policy.next(
    { query: "q", steps: [step(0, "terry", "worker", "v2"), step(1, "sidia", "verifier", "ACCEPT good")] },
    ctx,
  );
  assert.equal(accepted.kind, "accept");
});

test("prompt-driven: a pool without a verifier accepts after the worker", async () => {
  const policy = new PromptDrivenPolicy({});
  const ctx = ctxStub([{ index: 0, agentId: "terry", defaultRole: "worker" }]);
  const first = await policy.next({ query: "q", steps: [] }, ctx);
  assert.equal(first.kind, "dispatch");
  if (first.kind === "dispatch") assert.equal(first.decision.role, "worker");
  const after = await policy.next({ query: "q", steps: [step(0, "terry", "worker", "done")] }, ctx);
  assert.equal(after.kind, "accept");
});

test("prompt-driven: an erroring model falls back to the rule cycle", async () => {
  const policy = new PromptDrivenPolicy({});
  const ctx = ctxStub(TRIO_SLOTS, async () => {
    throw new Error("model down");
  });
  const out = await policy.next({ query: "q", steps: [] }, ctx);
  assert.equal(out.kind, "dispatch");
  if (out.kind === "dispatch") assert.equal(out.decision.role, "thinker");
});

test("prompt-driven: honors a parseable model decision, including sees indices", async () => {
  const policy = new PromptDrivenPolicy({});
  const obs: MonadObservation = { query: "q", steps: [step(0, "gaia", "thinker", "PLAN"), step(1, "terry", "worker", "RESULT")] };
  const ctx = ctxStub(TRIO_SLOTS, async () => '{"action":"dispatch","agent":"sidia","role":"verifier","subtask":"check it","sees":[1,9]}');
  const out = await policy.next(obs, ctx);
  assert.equal(out.kind, "dispatch");
  if (out.kind === "dispatch") {
    assert.equal(out.decision.agentId, "sidia");
    assert.equal(out.decision.subtask, "check it");
    assert.deepEqual(out.decision.sees, [1]); // 9 is not a valid step index
  }
});

// ---------- conductor-dag ----------

test("conductor-dag parseWorkflow: drops unknown agents and forward references", () => {
  const ctx = ctxStub([
    { index: 0, agentId: "terry", defaultRole: "worker" },
    { index: 1, agentId: "sidia", defaultRole: "verifier" },
  ]);
  const plan = parseWorkflow('{"steps":[{"agent":"terry","sees":[1]},{"agent":"ghost","sees":[]},{"agent":"sidia","sees":[0,5]}]}', ctx, "worker");
  // ghost dropped; terry's forward ref [1] dropped (>= its own index 0); sidia keeps [0], drops [5].
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { agentId: "terry", role: "worker", subtask: "Step 0", sees: [] });
  assert.equal(plan[1].agentId, "sidia");
  assert.deepEqual(plan[1].sees, [0]);
});

test("conductor-dag: an unparseable plan degrades to a single worker step", async () => {
  const ctx = ctxStub(
    [
      { index: 0, agentId: "terry", defaultRole: "worker" },
      { index: 1, agentId: "sidia", defaultRole: "verifier" },
    ],
    async () => "not json",
  );
  const policy = new ConductorDagPolicy({});
  const out = await policy.next({ query: "q", steps: [] }, ctx);
  assert.equal(out.kind, "dispatch");
  if (out.kind === "dispatch") assert.equal(out.decision.agentId, "terry");
});

test("conductor-dag: plans once on turn 0, replays per turn, accepts after the last step", async () => {
  let invokes = 0;
  const ctx = ctxStub(
    [
      { index: 0, agentId: "terry", defaultRole: "worker" },
      { index: 1, agentId: "sidia", defaultRole: "verifier" },
    ],
    async () => {
      invokes++;
      return '{"steps":[{"agent":"terry","role":"worker","subtask":"a","sees":[]},{"agent":"sidia","role":"verifier","subtask":"b","sees":[0]}]}';
    },
  );
  const policy = new ConductorDagPolicy({});

  const s0 = await policy.next({ query: "q", steps: [] }, ctx);
  assert.equal(s0.kind, "dispatch");
  const s1 = await policy.next({ query: "q", steps: [step(0, "terry", "worker", "A")] }, ctx);
  assert.equal(s1.kind, "dispatch");
  if (s1.kind === "dispatch") assert.equal(s1.decision.agentId, "sidia");
  const done = await policy.next({ query: "q", steps: [step(0, "terry", "worker", "A"), step(1, "sidia", "verifier", "B")] }, ctx);
  assert.equal(done.kind, "accept");
  assert.equal(invokes, 1, "the conductor plans exactly once");
});

// ---------- trinity-head mapping (pure) ----------

test("trinity-head decisionFromRouter: maps (agent_id, role_id) onto the pool", () => {
  const ctx = ctxStub([
    { index: 0, agentId: "terry", defaultRole: "worker" },
    { index: 1, agentId: "sidia", defaultRole: "verifier" },
  ]);
  const obs: MonadObservation = { query: "q", steps: [] };
  const withRoles = decisionFromRouter({ agent_id: 1, role_id: 2 }, obs, ctx, true);
  assert.equal(withRoles?.agentId, "sidia");
  assert.equal(withRoles?.role, "verifier"); // role_id 2 → verifier

  // roles disabled (production L-only head) → fall back to the slot's default role.
  const noRoles = decisionFromRouter({ agent_id: 0, role_id: 2 }, obs, ctx, false);
  assert.equal(noRoles?.role, "worker");

  // explicit agent name wins over the positional id
  const named = decisionFromRouter({ agent: "sidia", agent_id: 0 }, obs, ctx, true);
  assert.equal(named?.agentId, "sidia");

  assert.equal(decisionFromRouter({ agent_id: 99 }, obs, ctx, true), undefined); // out of pool
});
