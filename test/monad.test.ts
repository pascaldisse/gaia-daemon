import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonadEngine } from "../src/services/monad.js";
import { extractJsonObject, replyAccepts, routingPolicyIds } from "../src/services/policies/index.js";
import type { MonadConfig } from "../src/core/types.js";
import { normalizeRoomState } from "../src/domain/rooms.js";
import { activateSetup, deactivateMonad, discoverSetups, readRoomMonad } from "../src/services/setups.js";
import { initWorkspace, loadWorkspace } from "../src/domain/workspace.js";

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

// ---------- registries ----------

test("policies self-register via the barrel", () => {
  for (const id of ["prompt-driven", "conductor-dag", "trinity-head"]) assert.ok(routingPolicyIds().includes(id), `missing policy ${id}`);
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
  assert.equal(result.terminatedBy, "accept"); // v2 folds verifier-accept into "accept"
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
  assert.equal(result.terminatedBy, "accept");
});

test("engine: stops at maxTurns and still returns the last worker result", async () => {
  const config: MonadConfig = { ...TRIO, maxTurns: 2, terminate: undefined };
  const dispatch = async (agentId: string): Promise<string> => (agentId === "terry" ? "partial" : "PLAN");
  const engine = new MonadEngine({ config, parentRoomId: "r", dispatch, invoke: async () => "" });
  const result = await engine.run("q");
  assert.equal(result.terminatedBy, "max-turns");
  assert.equal(result.final, "partial");
});

test("engine: cancellation stops the loop and reports 'stop'", async () => {
  let dispatched = 0;
  let cancelled = false;
  const dispatch = async (): Promise<string> => {
    dispatched++;
    cancelled = true; // cancel after the first step lands
    return "PLAN";
  };
  const engine = new MonadEngine({ config: TRIO, parentRoomId: "r", dispatch, invoke: async () => "" });
  const result = await engine.run("q", { isCancelled: () => cancelled });
  assert.equal(dispatched, 1);
  assert.equal(result.terminatedBy, "stop");
});

// ---------- step-threading / access_list ----------

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

test("engine: inlined rolePrompts win over resolveRolePrompt", async () => {
  const config: MonadConfig = { ...TRIO, maxTurns: 1, rolePrompts: { thinker: "INLINED ROLE PROMPT" } };
  let task = "";
  const engine = new MonadEngine({
    config,
    parentRoomId: "r",
    dispatch: async (_agentId, t) => {
      task = t;
      return "PLAN";
    },
    invoke: async () => "",
    resolveRolePrompt: async () => "FROM RESOLVER",
  });
  await engine.run("q");
  assert.ok(task.startsWith("INLINED ROLE PROMPT"), `expected inlined prompt, got: ${task.slice(0, 40)}`);
  assert.ok(!task.includes("FROM RESOLVER"));
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

test("setup: discover the bundled monad setup, activate it, then deactivate", async () => {
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
    assert.equal(result.setupId, "monad");
    assert.equal(result.monad.policy, "prompt-driven");
    assert.equal(result.monad.slots.length, 3);
    assert.equal(result.monad.coordinatorAgentId, "gaia");
    assert.ok(result.monad.rolePrompts?.verifier?.includes("ACCEPT"), "verifier role prompt should be inlined");
    assert.ok(result.placedRoles.includes("terry:worker"), "role files should be placed into the project overlay");

    const persisted = await readRoomMonad(workspace, "default");
    assert.equal(persisted?.policy, "prompt-driven");
    assert.equal(persisted?.slots.length, 3);

    assert.equal(await deactivateMonad(workspace, "default"), true);
    assert.equal(await readRoomMonad(workspace, "default"), undefined);
    assert.equal(await deactivateMonad(workspace, "default"), false);
  } finally {
    if (prevHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("setup: activating with an unknown policy or missing agents fails clearly", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gaia-monad-bad-"));
  const home = join(tmp, "home");
  const proj = join(tmp, "proj");
  const prevHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = home;
  try {
    await mkdir(proj, { recursive: true });
    await initWorkspace(proj);
    const workspace = await loadWorkspace(proj);
    await assert.rejects(() => activateSetup(workspace, "no-such-setup", "default"), /Unknown setup/);
  } finally {
    if (prevHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------- loadWorkspace: global ~/.gaia/config.json env fallback ----------

test("loadWorkspace: global config.json env is a base, workspace env overrides same key", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gaia-env-"));
  const home = join(tmp, "home");
  const proj = join(tmp, "proj");
  const prevHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = home;
  try {
    await mkdir(proj, { recursive: true });
    await initWorkspace(proj);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({ env: { BRAVE_API_KEY: "global-key", SHARED: "global" } }));

    const configPath = join(proj, ".gaia", "config.json");
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    raw.env = { SHARED: "workspace" };
    await writeFile(configPath, JSON.stringify(raw));

    const workspace = await loadWorkspace(proj);
    assert.equal(workspace.config.env?.BRAVE_API_KEY, "global-key", "global-only key must be visible");
    assert.equal(workspace.config.env?.SHARED, "workspace", "workspace key must win over global same-key");
  } finally {
    if (prevHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("loadWorkspace: missing global config.json leaves workspace env untouched", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gaia-env-"));
  const home = join(tmp, "home");
  const proj = join(tmp, "proj");
  const prevHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = home;
  try {
    await mkdir(proj, { recursive: true });
    await initWorkspace(proj);
    // No ~/.gaia/config.json written at all.

    const configPath = join(proj, ".gaia", "config.json");
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    raw.env = { ONLY_WORKSPACE: "1" };
    await writeFile(configPath, JSON.stringify(raw));

    const workspace = await loadWorkspace(proj);
    assert.deepEqual(workspace.config.env, { ONLY_WORKSPACE: "1" });
  } finally {
    if (prevHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  }
});
