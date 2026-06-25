import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonadEngine } from "../src/app/monad-engine.ts";
import { routingPolicyIds, serveAdapterIds } from "../src/runtime/monad/index.ts";
import type { MonadConfig, MonadObservation, RoutingPolicyContext } from "../src/runtime/monad/types.ts";
import { ConductorDagPolicy, parseWorkflow } from "../src/runtime/monad/policies/conductor-dag.ts";
import { decisionFromRouter } from "../src/runtime/monad/policies/trinity-head.ts";
import { extractJsonObject, renderTranscript, replyAccepts } from "../src/runtime/monad/util.ts";
import { normalizeRoomState } from "../src/room/state.ts";
import { activateSetup, discoverSetups, readRoomMonad } from "../src/setups/setup-loader.ts";
import { initWorkspace, loadWorkspace } from "../src/workspace/workspace-loader.ts";

const TRIO: MonadConfig = {
  policy: "prompt-driven",
  slots: [
    { index: 0, agentId: "gaia", label: "thinker", defaultRole: "thinker" },
    { index: 1, agentId: "terry", label: "worker", defaultRole: "worker" },
    { index: 2, agentId: "sidia", label: "verifier", defaultRole: "verifier" },
  ],
  roles: ["thinker", "worker", "verifier"],
  maxTurns: 6,
  terminate: { on: "verifier-accept", acceptToken: "ACCEPT" },
};

function ctxStub(slots: MonadConfig["slots"]): RoutingPolicyContext {
  return { slots, roles: [], maxTurns: 5, coordinatorAgentId: slots[0]?.agentId ?? "", terminate: { on: "verifier-accept", acceptToken: "ACCEPT" }, invoke: async () => "" };
}

// ---------- registries ----------

test("policies and serve adapters self-register via the barrel", () => {
  for (const id of ["prompt-driven", "conductor-dag", "trinity-head"]) assert.ok(routingPolicyIds().includes(id), `missing policy ${id}`);
  assert.ok(serveAdapterIds().includes("openai-compatible"));
});

// ---------- util ----------

test("replyAccepts: leading token, tolerant of markdown", () => {
  assert.equal(replyAccepts("ACCEPT looks good", "ACCEPT"), true);
  assert.equal(replyAccepts("**ACCEPT** done", "ACCEPT"), true);
  assert.equal(replyAccepts("REVISE: fix the edge case", "ACCEPT"), false);
  assert.equal(replyAccepts("I accept this", "ACCEPT"), false); // not leading
});

test("extractJsonObject: pulls the first balanced object out of prose/fences", () => {
  assert.deepEqual(extractJsonObject('prefix ```json\n{"a":1,"b":[2,3]}\n``` tail'), { a: 1, b: [2, 3] });
  assert.deepEqual(extractJsonObject('{"s":"a } b","n":1}'), { s: "a } b", n: 1 }); // brace inside string
  assert.equal(extractJsonObject("no json here"), undefined);
});

// ---------- engine loop (prompt-driven rule fallback, no model) ----------

test("engine: Thinker→Worker→Verifier loop, REVISE then ACCEPT, answers the last worker", async () => {
  let verifierCalls = 0;
  const seen: string[] = [];
  const dispatch = async (agentId: string): Promise<string> => {
    seen.push(agentId);
    if (agentId === "gaia") return "PLAN: decompose the task";
    if (agentId === "terry") return verifierCalls === 0 ? "RESULT v1" : "RESULT v2";
    verifierCalls++;
    return verifierCalls === 1 ? "REVISE: missing the edge case" : "ACCEPT complete and correct";
  };
  // invoke returns no JSON → the prompt-driven policy uses its deterministic floor.
  const engine = new MonadEngine({ config: TRIO, parentRoomId: "r", dispatch, invoke: async () => "" });
  const result = await engine.run("do the thing");

  assert.deepEqual(seen, ["gaia", "terry", "sidia", "terry", "sidia"]);
  assert.equal(result.terminatedBy, "verifier-accept");
  assert.equal(result.final, "RESULT v2");
  assert.equal(result.steps.length, 5);
  assert.deepEqual(result.steps.map((s) => s.role), ["thinker", "worker", "verifier", "worker", "verifier"]);
});

test("engine: model-led routing is honored when the coordinator returns a decision", async () => {
  const seen: string[] = [];
  const dispatch = async (agentId: string): Promise<string> => {
    seen.push(agentId);
    return agentId === "terry" ? "the answer is 42" : "ACCEPT";
  };
  // Coordinator routes straight to the worker, then accepts.
  let call = 0;
  const invoke = async (): Promise<string> => {
    call++;
    if (call === 1) return '{"action":"dispatch","agent":"terry","role":"worker","subtask":"answer it","sees":"all"}';
    return '{"action":"accept"}';
  };
  const engine = new MonadEngine({ config: { ...TRIO, maxTurns: 5 }, parentRoomId: "r", dispatch, invoke });
  const result = await engine.run("answer");
  assert.deepEqual(seen, ["terry"]);
  assert.equal(result.final, "the answer is 42");
  assert.equal(result.terminatedBy, "verifier-accept");
});

test("engine: stops at maxTurns and still returns the last worker result", async () => {
  const config: MonadConfig = { ...TRIO, maxTurns: 2, terminate: undefined };
  const dispatch = async (agentId: string): Promise<string> => (agentId === "terry" ? "partial" : "PLAN");
  const engine = new MonadEngine({ config, parentRoomId: "r", dispatch, invoke: async () => "" });
  const result = await engine.run("q");
  assert.equal(result.terminatedBy, "max-turns");
  assert.equal(result.final, "partial");
});

// ---------- step-threading / access_list (P2) ----------

test("engine + conductor-dag: a later step provably sees only its access_list", async () => {
  const config: MonadConfig = {
    policy: "conductor-dag",
    slots: [
      { index: 0, agentId: "terry", defaultRole: "worker" },
      { index: 1, agentId: "sidia", defaultRole: "verifier" },
    ],
    roles: ["worker", "verifier"],
    maxTurns: 5,
    terminate: { on: "verifier-accept", acceptToken: "ACCEPT" },
  };
  const tasks: Record<string, string> = {};
  const dispatch = async (agentId: string, task: string): Promise<string> => {
    tasks[agentId] = task;
    return agentId === "terry" ? "A=42" : "ACCEPT verified against step 0";
  };
  const invoke = async (): Promise<string> =>
    '{"steps":[{"agent":"terry","role":"worker","subtask":"compute A","sees":[]},{"agent":"sidia","role":"verifier","subtask":"check A using step 0","sees":[0]}]}';
  const engine = new MonadEngine({ config, parentRoomId: "r", dispatch, invoke });
  const result = await engine.run("compute and check A");

  // The verifier step was threaded step 0's output (access_list [0]); the worker saw nothing prior.
  assert.ok(tasks.sidia.includes("A=42"), "verifier task should contain step 0's output");
  assert.ok(!tasks.terry.includes("A=42"), "worker task should not contain its own future output");
  assert.deepEqual(result.steps[1].sees, [0]);
  assert.equal(result.final, "A=42");
});

test("conductor-dag parseWorkflow: drops unknown agents and forward references", () => {
  const ctx = ctxStub([
    { index: 0, agentId: "terry", defaultRole: "worker" },
    { index: 1, agentId: "sidia", defaultRole: "verifier" },
  ]);
  const plan = parseWorkflow(
    '{"steps":[{"agent":"terry","sees":[1]},{"agent":"ghost","sees":[]},{"agent":"sidia","sees":[0,5]}]}',
    ctx,
    "worker",
  );
  // ghost dropped; terry's forward ref [1] dropped (>= its own index 0); sidia keeps [0], drops [5].
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { agentId: "terry", role: "worker", subtask: "Step 0", sees: [] });
  assert.equal(plan[1].agentId, "sidia");
  assert.deepEqual(plan[1].sees, [0]);
});

test("conductor-dag: an unparseable plan degrades to a single worker step", async () => {
  const ctx = ctxStub([
    { index: 0, agentId: "terry", defaultRole: "worker" },
    { index: 1, agentId: "sidia", defaultRole: "verifier" },
  ]);
  const policy = new ConductorDagPolicy({});
  const obs: MonadObservation = { query: "q", steps: [], transcript: renderTranscript("q", []) };
  const out = await policy.next(obs, { ...ctx, invoke: async () => "not json" });
  assert.equal(out.kind, "dispatch");
  if (out.kind === "dispatch") assert.equal(out.decision.agentId, "terry");
});

// ---------- trinity-head mapping (pure) ----------

test("trinity-head decisionFromRouter: maps (agent_id, role_id) onto the pool", () => {
  const ctx = ctxStub([
    { index: 0, agentId: "terry", defaultRole: "worker" },
    { index: 1, agentId: "sidia", defaultRole: "verifier" },
  ]);
  const obs: MonadObservation = { query: "q", steps: [], transcript: "" };
  const withRoles = decisionFromRouter({ agent_id: 1, role_id: 2 }, obs, ctx, true);
  assert.equal(withRoles?.agentId, "sidia");
  assert.equal(withRoles?.role, "verifier"); // role_id 2 → verifier

  // roles disabled (production L-only head) → fall back to the slot's default role.
  const noRoles = decisionFromRouter({ agent_id: 0, role_id: 2 }, obs, ctx, false);
  assert.equal(noRoles?.role, "worker");

  assert.equal(decisionFromRouter({ agent_id: 99 }, obs, ctx, true), undefined); // out of pool
});

// ---------- room state normalization ----------

test("normalizeRoomState: a valid monad block round-trips; a malformed one is dropped", () => {
  const ok = normalizeRoomState({
    activeRoles: {},
    agentCursors: {},
    runtimeDetails: {},
    monad: {
      policy: "prompt-driven",
      slots: [{ index: 0, agentId: "gaia", defaultRole: "thinker" }],
      roles: ["thinker"],
      maxTurns: 5,
      terminate: { on: "verifier-accept", acceptToken: "ACCEPT" },
      rolePrompts: { thinker: "plan it" },
    },
  });
  assert.equal(ok.monad?.policy, "prompt-driven");
  assert.equal(ok.monad?.slots.length, 1);
  assert.equal(ok.monad?.rolePrompts?.thinker, "plan it");

  assert.equal(normalizeRoomState({ monad: { policy: "", slots: [] } }).monad, undefined);
  assert.equal(normalizeRoomState({ monad: { policy: "x", slots: [{}] } }).monad, undefined); // no valid slot
});

// ---------- setup loader (real bundled setup, temp workspace) ----------

test("setup: discover the bundled monad setup and activate it into a room", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gaia-monad-"));
  const home = join(tmp, "home");
  const proj = join(tmp, "proj");
  const prevHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = home;
  try {
    await mkdir(proj, { recursive: true });
    await initWorkspace(proj);

    const setups = await discoverSetups(proj);
    assert.ok(setups.some((s) => s.id === "monad"), "bundled monad setup should be discoverable");

    const workspace = await loadWorkspace(proj);
    const result = await activateSetup(workspace, "monad", "default");
    assert.equal(result.monad.policy, "prompt-driven");
    assert.equal(result.monad.slots.length, 3);
    assert.equal(result.monad.coordinatorAgentId, "gaia");
    assert.ok(result.monad.rolePrompts?.verifier?.includes("ACCEPT"), "verifier role prompt should be inlined");

    const persisted = await readRoomMonad(workspace, "default");
    assert.equal(persisted?.policy, "prompt-driven");
    assert.equal(persisted?.slots.length, 3);
  } finally {
    if (prevHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  }
});
