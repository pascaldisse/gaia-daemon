import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SummonCoordinator,
  allowSummonForTurn,
  awaitTask,
  effectiveTrust,
  isTrusted,
  mayNestSummon,
  summonAck,
  summonUntrustedTier,
  type SummonRoomAccess,
  type SummonResultDelivery,
  type SummonTaskEvent,
} from "../src/services/summons.js";
import { resolveSandboxPolicy } from "../src/harness/sandbox/spec.js";
import { RoomService } from "../src/services/room-service.js";
import { normalizeRoomState, RoomHandle } from "../src/domain/rooms.js";
import { MemoryStore } from "../src/domain/memory.js";
import { readJson, writeJsonAtomic } from "../src/core/store.js";
import { workspacePaths } from "../src/core/paths.js";
import type { AgentDef, AgentEvent, AgentRoomEvent, RoomEvent, Workspace } from "../src/core/types.js";
import type { AgentRuntime } from "../src/harness/spec.js";

process.env.GAIA_HOME ??= await mkdtemp(join(tmpdir(), "gaia-home-"));

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  const id = overrides.id ?? "gaia";
  return {
    id,
    displayName: id[0].toUpperCase() + id.slice(1),
    icon: "🌍",
    dir: `/tmp/x-${id}`,
    configPath: `/tmp/x-${id}/agent.json`,
    personaDir: `/tmp/x-${id}/persona`,
    rolesDir: `/tmp/x-${id}/persona/roles`,
    soulPath: `/tmp/x-${id}/persona/SOUL.md`,
    memoryDir: `/tmp/x-${id}/persona/memory`,
    tools: [],
    ...overrides,
  };
}

test("trust policy: one bit drives sandbox forcing and summon rights", () => {
  assert.equal(isTrusted(agent()), true);
  assert.equal(isTrusted(agent({ trust: false })), false);

  // Nested summons are default-deny; opt-in respected only for trusted agents.
  assert.equal(mayNestSummon(agent()), false);
  assert.equal(mayNestSummon(agent({ allowNestedSummon: true })), true);
  assert.equal(mayNestSummon(agent({ allowNestedSummon: true, trust: false })), false);

  // Top-level turns may always summon; nested only via mayNestSummon.
  assert.equal(allowSummonForTurn(agent(), false), true);
  assert.equal(allowSummonForTurn(agent(), true), false);
  assert.equal(allowSummonForTurn(agent({ allowNestedSummon: true }), true), true);

  // An untrusted agent is NOT denied top-level summoning — its summons run
  // under the untrusted tier instead (data flow, not gating; see
  // summonUntrustedTier). A turn under an INHERITED untrusted tier nests
  // exactly like an untrusted agent's turn: never.
  assert.equal(allowSummonForTurn(agent({ trust: false }), false), true);
  assert.equal(allowSummonForTurn(agent({ allowNestedSummon: true }), true, true), false);

  // effectiveTrust: the inherited tier can only remove trust, never grant it.
  assert.equal(effectiveTrust(agent(), false), true);
  assert.equal(effectiveTrust(agent(), true), false);
  assert.equal(effectiveTrust(agent({ trust: false }), false), false);
  assert.equal(effectiveTrust(agent({ trust: false }), true), false);

  // summonUntrustedTier: untrusted caller OR tainted parent room → untrusted
  // child; human /summon and daemon orchestration (no caller agent) stay on
  // the trusted root — unless launched from a tainted room (transitive).
  assert.equal(summonUntrustedTier(agent(), false), false);
  assert.equal(summonUntrustedTier(agent({ trust: false }), false), true);
  assert.equal(summonUntrustedTier(agent(), true), true);
  assert.equal(summonUntrustedTier(undefined, false), false);
  assert.equal(summonUntrustedTier(undefined, true), true);
});

async function makeWorkspace(extraAgents: Record<string, AgentDef> = {}): Promise<{ workspace: Workspace; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "gaia-summons-"));
  await mkdir(join(root, ".gaia", "rooms"), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), "{}", "utf8");
  const workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "global-agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20 },
    contextFiles: [],
    agents: { gaia: agent(), terry: agent({ id: "terry" }), ...extraAgents },
  } satisfies Workspace;
  return { workspace, path: root };
}

/** A controllable fake room: sendMessage returns a live task the test settles;
 * delivery + bookkeeping calls are recorded. */
function fakeRoom(reply: string): SummonRoomAccess & {
  sent: string[];
  delivered: { from: string; reply: string; delivery: SummonResultDelivery }[];
  markedDelivered: number;
  resumeMarkedDelivered: number;
  /** Epoch token each markSummonResumeDelivered call carried (RC5 window 1/2). */
  resumeEpochs: (string | undefined)[];
  settle: (status?: string, error?: string) => void;
  holdPending: () => void;
  releasePending: (reply?: string) => void;
} {
  const listeners = new Set<(event: SummonTaskEvent) => void>();
  const task = { id: "t1", status: "running" as string, error: undefined as string | undefined };
  let currentReply = reply;
  let pending = false;
  let pendingDone = Promise.resolve();
  let finishPending = (): void => {};
  const room = {
    sent: [] as string[],
    delivered: [] as { from: string; reply: string; delivery: SummonResultDelivery }[],
    markedDelivered: 0,
    resumeMarkedDelivered: 0,
    resumeEpochs: [] as (string | undefined)[],
    settle(status = "complete", error?: string) {
      task.status = status;
      task.error = error;
      for (const listener of listeners) listener({ type: status === "error" ? "task-error" : "task-end", task: { id: task.id } });
    },
    holdPending() {
      pending = true;
      pendingDone = new Promise<void>((resolve) => {
        finishPending = resolve;
      });
    },
    releasePending(nextReply?: string) {
      if (nextReply !== undefined) currentReply = nextReply;
      pending = false;
      finishPending();
    },
    async sendMessage(text: string) {
      room.sent.push(text);
      return task;
    },
    subscribe(listener: (event: SummonTaskEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async latestReplyFrom() {
      return currentReply;
    },
    async waitForSettled() {
      await pendingDone;
    },
    async hasPendingWork() {
      return pending;
    },
    async getSnapshot() {
      return { tasks: [task] };
    },
    async runCancelCommand() {
      room.settle("cancelled");
      return "cancelled";
    },
    async deliverAgentResult(from: string, reply: string, delivery: SummonResultDelivery) {
      room.delivered.push({ from, reply, delivery });
    },
    async markSummonDelivered() {
      room.markedDelivered += 1;
    },
    async markSummonResumeDelivered(epoch?: string) {
      room.resumeMarkedDelivered += 1;
      room.resumeEpochs.push(epoch);
    },
    async broadcastRoomsChanged() {},
  };
  return room;
}

test("summonAndWait creates a linked child room and returns the worker's reply", async () => {
  const { workspace, path } = await makeWorkspace();
  const room = fakeRoom("worker says done");
  const coordinator = new SummonCoordinator(workspace, path, async () => room, async () => 8, () => {});

  const pending = coordinator.summonAndWait("default", "terry", "do a thing");
  // Let launch reach the turn, then settle it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  room.settle();
  const reply = await pending;
  assert.equal(reply, "worker says done");
  assert.equal(room.sent[0], "do a thing");
  assert.equal(room.delivered.length, 0); // deliver-less mode: caller consumed the promise
  assert.equal(coordinator.runningChildren().length, 0); // settled

  // The child room exists on disk, stamped with its parent BEFORE first turn.
  const dirs = await (await import("node:fs/promises")).readdir(workspace.roomsDir);
  const childId = dirs.find((name) => name.startsWith("terry-"));
  assert.ok(childId, "child room dir exists");
  const state = normalizeRoomState(await readJson(workspacePaths.roomState(path, childId!)));
  assert.equal(state.parentRoomId, "default");
  assert.equal(state.incognito, true, "summon children never enter recall or episodic memory");
  assert.equal(state.summon, undefined); // no delivery record without a deliver mode
});

test("background summon never blocks: launch resolves first, then the result is delivered as a caller turn", async () => {
  const { workspace, path } = await makeWorkspace();
  const child = fakeRoom("scouting report: all clear");
  const parent = fakeRoom("");
  const services = new Map<string, SummonRoomAccess>([["default", parent]]);
  const coordinator = new SummonCoordinator(workspace, path, async (roomId) => services.get(roomId) ?? child, async () => 8, () => {});

  const { roomId, done } = await coordinator.launch("default", "terry", "scout ahead", { deliver: "turn", callerAgentId: "gaia" });
  // Launch resolved while the worker is still running — the caller's turn is free.
  assert.equal(coordinator.runningChildren("default").length, 1);
  assert.equal(parent.delivered.length, 0);

  // The durable delivery record is stamped BEFORE the first turn.
  const state = normalizeRoomState(await readJson(workspacePaths.roomState(path, roomId)));
  assert.equal(state.summon?.status, "running");
  assert.equal(state.summon?.deliver, "turn");
  assert.equal(state.summon?.callerAgentId, "gaia");
  assert.equal(state.summon?.agentId, "terry");

  child.settle();
  await done;
  assert.equal(parent.delivered.length, 1);
  assert.equal(parent.delivered[0].from, "terry");
  assert.match(parent.delivered[0].reply, /scouting report: all clear/);
  assert.equal(parent.delivered[0].delivery.childRoomId, roomId);
  assert.equal(parent.delivered[0].delivery.failed, false);
  assert.equal(parent.delivered[0].delivery.triggerTarget, "gaia"); // the subagent callback re-invokes the caller
  assert.equal(child.markedDelivered, 1);
  assert.equal(coordinator.runningChildren().length, 0);
});

test("a parent summon stays live until nested workers return and its callback settles", async () => {
  const { workspace, path } = await makeWorkspace();
  const root = fakeRoom("");
  const outer = fakeRoom("children launched");
  const leaf = fakeRoom("leaf result");
  const originalDelivery = outer.deliverAgentResult.bind(outer);
  outer.deliverAgentResult = async (from, reply, delivery) => {
    await originalDelivery(from, reply, delivery);
    // Real RoomService delivery queues a callback turn before returning.
    outer.holdPending();
  };
  const coordinator = new SummonCoordinator(
    workspace,
    path,
    async (roomId) => {
      if (roomId === "default") return root;
      return roomId.startsWith("terry-") ? outer : leaf;
    },
    async () => 8,
    () => {},
  );

  const outerRun = await coordinator.launch("default", "terry", "build through children", { deliver: "turn", callerAgentId: "gaia" });
  const leafRun = await coordinator.launch(outerRun.roomId, "gaia", "inspect one atom", { deliver: "turn", callerAgentId: "terry" });
  let outerSettled = false;
  void outerRun.done.finally(() => {
    outerSettled = true;
  });

  // The delegation-only first reply must not close or deliver the outer lane.
  outer.settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(outerSettled, false);
  assert.equal(root.delivered.length, 0);
  assert.equal(coordinator.runningChildren("default").length, 1);

  // Even after the leaf delivers, its callback turn still belongs to the outer
  // lane's lifetime and must settle before the final upstream result.
  leaf.settle();
  await leafRun.done;
  assert.equal(outer.delivered.length, 1);
  assert.equal(outerSettled, false);
  assert.equal(outer.markedDelivered, 0);
  assert.equal(root.delivered.length, 0);

  outer.releasePending("integrated leaf result");
  await outerRun.done;
  assert.equal(outer.markedDelivered, 1);
  assert.equal(root.delivered.length, 1);
  assert.match(root.delivered[0].reply, /integrated leaf result/);
  assert.equal(coordinator.runningChildren().length, 0);
});

test("a failed worker turn is delivered loudly, never swallowed", async () => {
  const { workspace, path } = await makeWorkspace();
  const child = fakeRoom("");
  const parent = fakeRoom("");
  const services = new Map<string, SummonRoomAccess>([["default", parent]]);
  const coordinator = new SummonCoordinator(workspace, path, async (roomId) => services.get(roomId) ?? child, async () => 8, () => {});

  const { done } = await coordinator.launch("default", "terry", "doomed task", { deliver: "note" });
  child.settle("error", "sandbox exploded");
  await done.catch(() => {}); // done rejects; the failure still got delivered
  assert.equal(parent.delivered.length, 1);
  assert.equal(parent.delivered[0].delivery.failed, true); // rendered as a "⚠️ FAILED" collapsed header
  assert.match(parent.delivered[0].reply, /sandbox exploded/);
  assert.equal(parent.delivered[0].delivery.triggerTarget, undefined); // note mode: no turn trigger
  assert.equal(child.markedDelivered, 1); // delivered (the failure IS the result)
});

test("summon suggests substring and near-match agent ids in the unknown-agent error", async () => {
  const ghoulSol = agent({ id: "ghoul-sol" });
  const solas = agent({ id: "solas" });
  const { workspace, path } = await makeWorkspace({ "ghoul-sol": ghoulSol, solas });
  const room = fakeRoom("ok");
  const coordinator = new SummonCoordinator(workspace, path, async () => room, async () => 1, () => {});

  await assert.rejects(
    () => coordinator.summon("default", "sol", "task"),
    (error: Error) => {
      assert.equal(
        error.message,
        "Unknown agent 'sol'. Did you mean: ghoul-sol, solas? Available: gaia, terry, ghoul-sol, solas",
      );
      return true;
    },
  );
});

test("summon refuses unknown agents and enforces the per-room cap", async () => {
  const { workspace, path } = await makeWorkspace();
  const room = fakeRoom("ok");
  const coordinator = new SummonCoordinator(workspace, path, async () => room, async () => 1, () => {});

  await assert.rejects(() => coordinator.summon("default", "nobody", "task"), /Unknown agent 'nobody'/);

  await coordinator.summon("default", "terry", "long task");
  assert.equal(coordinator.runningChildren("default").length, 1);
  await assert.rejects(() => coordinator.summon("default", "gaia", "another"), /Too many running summons/);
  room.settle();
});

test("trust:false worker remains sandboxed when a recovered legacy room lacks the tier marker", () => {
  const worker = agent({ trust: false, sandbox: { enabled: false, backend: "none" } });
  // Pre-tier state has no summonUntrusted field, hence recoveredTier=false.
  // The worker's own durable trust boundary must still force a real sandbox.
  const recoveredTier = false;
  const policy = resolveSandboxPolicy(undefined, worker.sandbox, true, { trusted: effectiveTrust(worker, recoveredTier) });
  assert.equal(policy.enabled, true);
  assert.notEqual(policy.backend, "none");
});

test("an untrusted caller's summon runs under the untrusted tier — forced sandbox regardless of the worker's own trust", async () => {
  // caller 'shady' is trust:false; worker 'naked' is TRUSTED and even
  // configures its own sandbox off — the exact escape the tier must close.
  const shady = agent({ id: "shady", trust: false });
  const naked = agent({ id: "naked", sandbox: { enabled: false, backend: "none" } });
  const { workspace, path } = await makeWorkspace({ shady, naked });
  const room = fakeRoom("ok");
  const coordinator = new SummonCoordinator(workspace, path, async () => room, async () => 8, () => {});

  // The summon is NOT denied (no gating) — the caller's untrust follows it.
  const { roomId } = await coordinator.launch("default", "naked", "delegated task", { deliver: "turn", callerAgentId: "shady" });
  const child = coordinator.runningChildren("default").find((c) => c.roomId === roomId);
  assert.ok(child, "child launched");
  assert.equal(child!.untrusted, true);

  // The tier is the `trusted` input the child room feeds sandbox resolution:
  // the worker's own trusted bit + config (enabled:false, backend:"none")
  // must NOT weaken it — a real sandbox is forced, exactly as for a
  // trust:false agent. Never config-weakenable.
  assert.equal(effectiveTrust(naked, child!.untrusted), false);
  const policy = resolveSandboxPolicy(undefined, naked.sandbox, true, { trusted: effectiveTrust(naked, child!.untrusted) });
  assert.equal(policy.enabled, true);
  assert.notEqual(policy.backend, "none");

  // The tier is transitive: a summon launched FROM the tainted child room
  // inherits it even though its caller agent ('naked') is trusted — no
  // laundering back to the trusted tier through an intermediary.
  const { roomId: grandRoomId } = await coordinator.launch(roomId, "terry", "sub-task", { deliver: "turn", callerAgentId: "naked" });
  const grandchild = coordinator.runningChildren(roomId).find((c) => c.roomId === grandRoomId);
  assert.ok(grandchild, "grandchild launched");
  assert.equal(grandchild!.untrusted, true);

  // Contrast: a trusted caller's summon — and a human/no-caller one — stay on
  // the trusted tier, so the worker's own trust decides its sandbox as before.
  const { roomId: cleanRoomId } = await coordinator.launch("default", "terry", "task", { deliver: "turn", callerAgentId: "gaia" });
  assert.equal(coordinator.runningChildren("default").find((c) => c.roomId === cleanRoomId)!.untrusted, false);
  const humanRoomId = await coordinator.summon("default", "terry", "task"); // /summon: no caller agent
  assert.equal(coordinator.runningChildren("default").find((c) => c.roomId === humanRoomId)!.untrusted, false);

  room.settle();
});

test("awaitTask resolves on the timeout arm while the task keeps running (summonAndWait's cap)", async () => {
  const task = { id: "x", status: "running" };
  const start = Date.now();
  await awaitTask({ subscribe: () => () => {} }, task, 50);
  assert.ok(Date.now() - start >= 45);
  assert.equal(task.status, "running"); // the turn keeps going in its room
});

test("recoverUndelivered re-arms a stranded summon and delivers its surviving reply", async () => {
  const { workspace, path } = await makeWorkspace();
  const childRoomId = "terry-stranded1";
  await mkdir(join(workspace.roomsDir, childRoomId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, childRoomId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: { agentId: "terry", deliver: "turn", callerAgentId: "gaia", status: "running", launchedAt: new Date().toISOString() },
  });

  const child = fakeRoom("recovered result ✓");
  const parent = fakeRoom("");
  const services = new Map<string, SummonRoomAccess>([
    ["default", parent],
    [childRoomId, child],
  ]);
  const coordinator = new SummonCoordinator(workspace, path, async (roomId) => {
    const service = services.get(roomId);
    if (!service) throw new Error(`unexpected room: ${roomId}`);
    return service;
  }, async () => 8, () => {});

  await coordinator.recoverUndelivered();
  // Recovery runs in the background — wait for the delivery to land.
  for (let i = 0; i < 100 && parent.delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(parent.delivered.length, 1);
  assert.match(parent.delivered[0].reply, /recovered result/);
  assert.equal(parent.delivered[0].delivery.triggerTarget, "gaia");
  assert.equal(child.markedDelivered, 1);
});

test("recoverUndelivered skips corrupt child state rather than laundering its untrusted tier", async () => {
  const { workspace, path } = await makeWorkspace();
  const childRoomId = "untrusted-corrupt";
  await mkdir(join(workspace.roomsDir, childRoomId), { recursive: true });
  await writeFile(workspacePaths.roomState(path, childRoomId), "{ corrupt state\n", "utf8");
  const logs: string[] = [];
  let opened = false;
  const coordinator = new SummonCoordinator(
    workspace,
    path,
    async () => {
      opened = true;
      throw new Error("corrupt child must never be recovered as trusted");
    },
    async () => 8,
    (line) => logs.push(line),
  );

  await coordinator.recoverUndelivered();
  assert.equal(opened, false, "corrupt state never reaches service recovery");
  assert.ok(logs.some((line) => line.includes("skipped unsafe 'untrusted-corrupt'")), "recovery skip is logged");
  assert.equal(await readFile(workspacePaths.roomState(path, childRoomId), "utf8"), "{ corrupt state\n", "recovery preserves corrupt bytes for repair");
});

test("recoverUndelivered skips a corrupt room but continues its valid sibling", async () => {
  const { workspace, path } = await makeWorkspace();
  await mkdir(join(workspace.roomsDir, "corrupt"), { recursive: true });
  await writeFile(workspacePaths.roomState(path, "corrupt"), "null", "utf8");
  await mkdir(join(workspace.roomsDir, "valid"), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, "valid"), {
    activeRoles: {}, agentCursors: {}, parentRoomId: "default",
    summon: { agentId: "terry", deliver: "note", status: "running", launchedAt: new Date().toISOString() },
  });
  const parent = fakeRoom("");
  const child = fakeRoom("valid sibling recovered");
  const logs: string[] = [];
  const services = new Map<string, SummonRoomAccess>([["default", parent], ["valid", child]]);
  const coordinator = new SummonCoordinator(workspace, path, async (id) => {
    const service = services.get(id);
    if (!service) throw new Error(`unexpected recovery service: ${id}`);
    return service;
  }, async () => 8, (line) => logs.push(line));
  await coordinator.recoverUndelivered();
  for (let i = 0; i < 100 && parent.delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(parent.delivered.length, 1, "the valid sibling still recovers");
  assert.ok(logs.some((line) => line.includes("skipped unsafe 'corrupt'")));
  assert.equal(await readFile(workspacePaths.roomState(path, "corrupt"), "utf8"), "null");
});

test("recoverUndelivered preserves an explicit untrusted tier", async () => {
  const { workspace, path } = await makeWorkspace();
  const childRoomId = "untrusted-recovery";
  await mkdir(join(workspace.roomsDir, childRoomId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, childRoomId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summonUntrusted: true,
    summon: { agentId: "terry", deliver: "turn", callerAgentId: "gaia", status: "running", launchedAt: new Date().toISOString() },
  });
  const child = fakeRoom("still working");
  child.holdPending();
  const coordinator = new SummonCoordinator(workspace, path, async () => child, async () => 8, () => {});

  await coordinator.recoverUndelivered();
  for (let i = 0; i < 20 && coordinator.runningChildren().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(coordinator.runningChildren()[0]?.untrusted, true, "explicit durable tier is retained during recovery");

  child.releasePending();
});

test("recoverUndelivered reconstructs a nested tree before delivering its parent", async () => {
  const { workspace, path } = await makeWorkspace();
  const outerRoomId = "terry-outer-stranded";
  const leafRoomId = "gaia-leaf-stranded";
  for (const [roomId, state] of [
    [
      outerRoomId,
      {
        activeRoles: {},
        agentCursors: {},
        parentRoomId: "default",
        summon: { agentId: "terry", deliver: "turn", callerAgentId: "gaia", status: "running", launchedAt: new Date().toISOString() },
      },
    ],
    [
      leafRoomId,
      {
        activeRoles: {},
        agentCursors: {},
        parentRoomId: outerRoomId,
        summon: { agentId: "gaia", deliver: "turn", callerAgentId: "terry", status: "running", launchedAt: new Date().toISOString() },
      },
    ],
  ] as const) {
    await mkdir(join(workspace.roomsDir, roomId), { recursive: true });
    await writeJsonAtomic(workspacePaths.roomState(path, roomId), state);
  }

  const root = fakeRoom("");
  const outer = fakeRoom("delegated before restart");
  const leaf = fakeRoom("recovered leaf result");
  outer.settle();
  leaf.settle();
  const originalDelivery = outer.deliverAgentResult.bind(outer);
  outer.deliverAgentResult = async (from, reply, delivery) => {
    await originalDelivery(from, reply, delivery);
    outer.holdPending();
  };
  const services = new Map<string, SummonRoomAccess>([
    ["default", root],
    [outerRoomId, outer],
    [leafRoomId, leaf],
  ]);
  const coordinator = new SummonCoordinator(
    workspace,
    path,
    async (roomId) => {
      const room = services.get(roomId);
      if (!room) throw new Error(`unexpected room: ${roomId}`);
      return room;
    },
    async () => 8,
    () => {},
  );

  await coordinator.recoverUndelivered();
  for (let i = 0; i < 100 && outer.delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(outer.delivered.length, 1);
  assert.equal(root.delivered.length, 0);
  assert.equal(outer.markedDelivered, 0);

  outer.releasePending("integrated after recovery");
  for (let i = 0; i < 100 && root.delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(root.delivered.length, 1);
  assert.match(root.delivered[0].reply, /integrated after recovery/);
  assert.equal(outer.markedDelivered, 1);
  assert.equal(leaf.markedDelivered, 1);
});

test("recoverUndelivered skips delivered records and non-summon rooms", async () => {
  const { workspace, path } = await makeWorkspace();
  await mkdir(join(workspace.roomsDir, "plain-room"), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, "plain-room"), { activeRoles: {}, agentCursors: {} });
  await mkdir(join(workspace.roomsDir, "terry-done1"), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, "terry-done1"), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: { agentId: "terry", deliver: "note", status: "delivered", launchedAt: new Date().toISOString() },
  });

  const coordinator = new SummonCoordinator(workspace, path, async () => {
    throw new Error("recovery must not open settled rooms");
  }, async () => 8, () => {});
  await coordinator.recoverUndelivered();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(coordinator.runningChildren().length, 0);
});

test("summonAck names the sub-room and forbids waiting", () => {
  const ack = summonAck("terry", "terry-abc123");
  assert.match(ack, /terry-abc123/);
  assert.match(ack, /Do NOT wait or poll/);
  assert.match(ack, /posted back to this room/);
});

// --- end-to-end: real RoomServices, real queue, real callback turn ------------

/** Scripted runtime capturing every AgentInput message AND the transcript it is
 * sent (the summon result rides the transcript as a note, not the message). */
function scriptedRuntime(agentDef: AgentDef, reply: () => string): AgentRuntime & { messages: string[]; transcripts: RoomEvent[][] } {
  const runtime = {
    agent: agentDef,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    messages: [] as string[],
    transcripts: [] as RoomEvent[][],
    async *send(input: { message: string; transcript?: RoomEvent[] }) {
      runtime.messages.push(input.message);
      runtime.transcripts.push(input.transcript ?? []);
      yield { type: "text-delta", delta: reply() } as AgentEvent;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
  };
  return runtime as unknown as AgentRuntime & { messages: string[]; transcripts: RoomEvent[][] };
}

test("end-to-end: a background summon posts its result into the parent room and re-invokes the caller", async () => {
  const { workspace, path } = await makeWorkspace();
  await mkdir(join(workspace.roomsDir, "default"), { recursive: true });

  const runtimes = new Map<string, ReturnType<typeof scriptedRuntime>>();
  const services = new Map<string, Promise<RoomService>>();
  const serviceFor = (roomId: string): Promise<RoomService> => {
    let service = services.get(roomId);
    if (!service) {
      service = RoomService.open({
        workspaceId: "ws1",
        workspace,
        roomId,
        memoryStore: new MemoryStore(),
        runtimeFactory: (agentDef) => {
          const runtime = scriptedRuntime(agentDef, () => (agentDef.id === "terry" ? "the tide tables say: go at dawn" : "synthesized."));
          runtimes.set(`${roomId}:${agentDef.id}`, runtime);
          return runtime;
        },
      }).then(async (svc) => {
        await svc.init();
        return svc;
      });
      services.set(roomId, service);
    }
    return service;
  };

  const coordinator = new SummonCoordinator(workspace, path, serviceFor, async () => 8, () => {});
  const { roomId: childRoomId, done } = await coordinator.launch("default", "terry", "check the tides", {
    deliver: "turn",
    callerAgentId: "gaia",
  });
  await done;

  // The parent room got the worker-authored result...
  const parent = await serviceFor("default");
  await parent.waitForSettled();
  const parentRoom = await RoomHandle.open(path, "default");
  const { events } = await parentRoom.eventsFrom(0);
  const note = events.find((event) => event.author === "terry") as AgentRoomEvent | undefined;
  assert.ok(note, "worker result posted into the parent room");
  assert.match(note!.text, /the tide tables say: go at dawn/);
  // Provenance rides details.summonResult (a collapsed UI header), not the text.
  assert.equal(note!.details?.summonResult?.childRoomId, childRoomId);
  assert.equal(note!.details?.summonResult?.failed, false);

  // ...and the CALLER ran a real turn processing it (the subagent callback): a
  // short pointer as the message, the worker's full result as a transcript note.
  const caller = runtimes.get("default:gaia");
  assert.ok(caller, "caller runtime exists");
  assert.equal(caller!.messages.length, 1);
  assert.match(caller!.messages[0], new RegExp(childRoomId)); // pointer references the summon
  const callerNote = caller!.transcripts[0].find((event) => event.author === "terry") as AgentRoomEvent | undefined;
  assert.ok(callerNote, "the worker's result note reached the caller's context");
  assert.match(callerNote!.text, /the tide tables say: go at dawn/);

  // The child's durable record is closed out.
  const childState = normalizeRoomState(await readJson(workspacePaths.roomState(path, childRoomId)));
  assert.equal(childState.incognito, true, "summon child rooms stay out of workspace recall and memory capture");
  assert.equal(childState.summon?.status, "delivered");
});

test("end-to-end (Fix #1): `resume` into an already-delivered summon child runs a REAL second turn and posts its result back to the parent, re-invoking the caller again", async () => {
  const { workspace, path } = await makeWorkspace();
  await mkdir(join(workspace.roomsDir, "default"), { recursive: true });

  const runtimes = new Map<string, ReturnType<typeof scriptedRuntime>>();
  const services = new Map<string, Promise<RoomService>>();
  let terryReply = "the tide tables say: go at dawn";
  const serviceFor = (roomId: string): Promise<RoomService> => {
    let service = services.get(roomId);
    if (!service) {
      service = RoomService.open({
        workspaceId: "ws1",
        workspace,
        roomId,
        memoryStore: new MemoryStore(),
        runtimeFactory: (agentDef) => {
          const runtime = scriptedRuntime(agentDef, () => (agentDef.id === "terry" ? terryReply : "synthesized."));
          runtimes.set(`${roomId}:${agentDef.id}`, runtime);
          return runtime;
        },
      }).then(async (svc) => {
        await svc.init();
        return svc;
      });
      services.set(roomId, service);
    }
    return service;
  };

  const coordinator = new SummonCoordinator(workspace, path, serviceFor, async () => 8, () => {});
  const { roomId: childRoomId, done } = await coordinator.launch("default", "terry", "check the tides", {
    deliver: "turn",
    callerAgentId: "gaia",
  });
  await done; // first turn delivered — baseline, unchanged behavior (see the test above)

  // Real `gaia resume` (HTTP handler's own call shape: coordinator.resume,
  // no explicit targets — routeTargets picks the room's active agent, the
  // SAME path a plain `gaia resume` into a normal room takes).
  terryReply = "second pass: tides confirmed, all clear";
  const child = await serviceFor(childRoomId);
  const { tracked } = await coordinator.resume(childRoomId, child, "one more check please");
  assert.equal(tracked, true);

  // Stamped BEFORE the resumed turn ran.
  const midState = normalizeRoomState(await readJson(workspacePaths.roomState(path, childRoomId)));
  assert.equal(midState.summon?.resumeStatus, "running");

  // Wait for the coordinator's background completion (the resumed turn itself
  // already ran synchronously inside resume()'s awaited sendMessage — this
  // waits for runResume's delivery tail).
  for (let i = 0; i < 200; i++) {
    const state = normalizeRoomState(await readJson(workspacePaths.roomState(path, childRoomId)));
    if (state.summon?.resumeStatus === "delivered") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const finalState = normalizeRoomState(await readJson(workspacePaths.roomState(path, childRoomId)));
  assert.equal(finalState.summon?.resumeStatus, "delivered", "resumed turn's own delivery record closed out");
  assert.equal(finalState.summon?.status, "delivered", "original first-turn record untouched");

  // The REAL child room actually ran "terry" a second time.
  const terryRuntime = runtimes.get(`${childRoomId}:terry`);
  assert.ok(terryRuntime, "terry's runtime exists in the child room");
  assert.equal(terryRuntime!.messages.length, 2, "first-turn task + the resumed message, both real turns");
  assert.equal(terryRuntime!.messages[1], "one more check please");

  // The resumed turn's result posted back into the PARENT room — the exact
  // gap Fix #1 closes (RC1: this note never existed before this fix).
  const parentRoom = await RoomHandle.open(path, "default");
  const { events } = await parentRoom.eventsFrom(0);
  const notes = events.filter((event) => event.author === "terry") as AgentRoomEvent[];
  assert.equal(notes.length, 2, "first-turn result note PLUS the resumed-turn result note");
  assert.match(notes[1]!.text, /second pass: tides confirmed, all clear/);
  assert.equal(notes[1]!.details?.summonResult?.childRoomId, childRoomId);
  assert.equal(notes[1]!.details?.summonResult?.failed, false);

  // The caller ran a SECOND callback turn processing the resumed result.
  const caller = runtimes.get("default:gaia");
  assert.ok(caller, "caller runtime exists");
  assert.equal(caller!.messages.length, 2, "one callback per delivered result: first turn, then the resume");
  assert.match(caller!.messages[1], new RegExp(childRoomId));
  const secondCallerNote = caller!.transcripts[1].filter((event) => event.author === "terry").at(-1) as AgentRoomEvent | undefined;
  assert.ok(secondCallerNote, "the resumed result reached the caller's context");
  assert.match(secondCallerNote!.text, /second pass: tides confirmed, all clear/);
});

test("insight ledger: a caller with insight opts into a distilled per-worker trace at lane close; default caller writes nothing", async () => {
  const insightMemDir = await mkdtemp(join(tmpdir(), "gaia-ledger-mem-"));
  const { workspace, path } = await makeWorkspace({
    watcher: agent({ id: "watcher", memoryDir: insightMemDir, insight: "line" }),
  });
  const room = fakeRoom("scouted the area, all quiet");
  const coordinator = new SummonCoordinator(workspace, path, async () => room, async () => 8, () => {});

  const { roomId: childRoomId, done } = await coordinator.launch("default", "terry", "scout the ruins", { callerAgentId: "watcher" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  room.settle();
  await done;

  const { readFile: read } = await import("node:fs/promises");
  const ledger = await read(join(insightMemDir, "ledgers", "terry.md"), "utf8");
  assert.match(ledger, /done/); // outcome recorded
  assert.match(ledger, new RegExp(childRoomId)); // provenance
  assert.match(ledger, /scout the ruins/); // task, distilled
  assert.match(ledger, /scouted the area, all quiet/); // result, distilled

  // The worker's OWN room is still incognito — insight is caller-scoped
  // visibility via the ledger file, never a widened recall index.
  const childState = normalizeRoomState(await readJson(workspacePaths.roomState(path, childRoomId)));
  assert.equal(childState.incognito, true);

  // A caller with no `insight` (today's every ghoul) writes NOTHING — zero
  // behavior change unless an agent opts in.
  const plainRoom = fakeRoom("quiet run");
  const plainCoordinator = new SummonCoordinator(workspace, path, async () => plainRoom, async () => 8, () => {});
  const { done: plainDone } = await plainCoordinator.launch("default", "terry", "another task", { callerAgentId: "gaia" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  plainRoom.settle();
  await plainDone;
  await assert.rejects(read(join(workspace.agents.gaia!.memoryDir, "ledgers", "terry.md"), "utf8"));
});

// --- Fix #1: resume-completion tracking ----------------------------------

test("resume: a plain (non-summon) room gets the original untracked fire-and-forget behavior", async () => {
  const { workspace, path } = await makeWorkspace();
  const room = fakeRoom("");
  const coordinator = new SummonCoordinator(workspace, path, async () => room, async () => 8, () => {});

  const { tracked } = await coordinator.resume("default", room, "keep going");
  assert.equal(tracked, false);
  assert.deepEqual(room.sent, ["keep going"]);
  assert.equal(coordinator.runningChildren().length, 0);
});

test("resume: an ALREADY-delivered summon child registers a new durable contract and delivers to the parent on settle (Fix #1)", async () => {
  const { workspace, path } = await makeWorkspace();
  const childRoomId = "terry-resumeme1";
  await mkdir(join(workspace.roomsDir, childRoomId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, childRoomId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: { agentId: "terry", deliver: "turn", callerAgentId: "gaia", status: "delivered", launchedAt: new Date().toISOString() },
  });
  const child = fakeRoom("resumed and finished the extra task");
  const parent = fakeRoom("");
  const services = new Map<string, SummonRoomAccess>([
    ["default", parent],
    [childRoomId, child],
  ]);
  const coordinator = new SummonCoordinator(
    workspace,
    path,
    async (roomId) => {
      const service = services.get(roomId);
      if (!service) throw new Error(`unexpected room: ${roomId}`);
      return service;
    },
    async () => 8,
    () => {},
  );

  const { tracked } = await coordinator.resume(childRoomId, child, "one more thing please");
  assert.equal(tracked, true);
  assert.deepEqual(child.sent, ["one more thing please"]);

  // Stamped BEFORE the turn can run — same ordering law as launch()'s own
  // status stamp — and the first-turn record is untouched.
  let state = normalizeRoomState(await readJson(workspacePaths.roomState(path, childRoomId)));
  assert.equal(state.summon?.resumeStatus, "running");
  assert.equal(state.summon?.status, "delivered");
  assert.equal(coordinator.runningChildren("default").length, 1, "visible to census/cap while the resumed turn is in flight");

  child.settle();
  for (let i = 0; i < 100 && parent.delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(parent.delivered.length, 1);
  assert.equal(parent.delivered[0].from, "terry");
  assert.match(parent.delivered[0].reply, /resumed and finished the extra task/);
  assert.equal(parent.delivered[0].delivery.triggerTarget, "gaia");
  assert.equal(child.resumeMarkedDelivered, 1, "markSummonResumeDelivered called — real RoomService persists this to disk (see room-service.ts); fakeRoom only counts it, matching this file's markedDelivered convention");
  assert.equal(child.markedDelivered, 0, "deliverResume never touches the first-turn delivery record");
  assert.equal(coordinator.runningChildren().length, 0);
});

test("resume: does not double-track a summon child whose first turn hasn't delivered yet (avoids a double delivery)", async () => {
  const { workspace, path } = await makeWorkspace();
  const childRoomId = "terry-inflight1";
  await mkdir(join(workspace.roomsDir, childRoomId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, childRoomId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: { agentId: "terry", deliver: "turn", callerAgentId: "gaia", status: "running", launchedAt: new Date().toISOString() },
  });
  const child = fakeRoom("");
  const coordinator = new SummonCoordinator(workspace, path, async () => child, async () => 8, () => {});

  const { tracked } = await coordinator.resume(childRoomId, child, "steer it");
  assert.equal(tracked, false);
  assert.deepEqual(child.sent, ["steer it"]);
  const state = normalizeRoomState(await readJson(workspacePaths.roomState(path, childRoomId)));
  assert.equal(state.summon?.resumeStatus, undefined, "no resume stamp while the first turn is still undelivered");
});

test("resume: rolls back its own stamp when sendMessage throws, so a boot sweep never chases a resume that never ran", async () => {
  const { workspace, path } = await makeWorkspace();
  const childRoomId = "terry-resumefail1";
  await mkdir(join(workspace.roomsDir, childRoomId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, childRoomId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: { agentId: "terry", deliver: "note", status: "delivered", launchedAt: new Date().toISOString() },
  });
  const child = fakeRoom("");
  child.sendMessage = async () => {
    throw new Error("boom: bad target");
  };
  const coordinator = new SummonCoordinator(workspace, path, async () => child, async () => 8, () => {});

  await assert.rejects(coordinator.resume(childRoomId, child, "steer it"), /boom: bad target/);
  const state = normalizeRoomState(await readJson(workspacePaths.roomState(path, childRoomId)));
  assert.equal(state.summon?.resumeStatus, "delivered", "rolled back — nothing was ever kicked off");
  assert.equal(coordinator.runningChildren().length, 0);
});

test("recoverUndelivered re-arms an interrupted resume (Fix #1, RC4) via markSummonResumeDelivered", async () => {
  const { workspace, path } = await makeWorkspace();
  const childRoomId = "terry-resume-stranded1";
  await mkdir(join(workspace.roomsDir, childRoomId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, childRoomId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: {
      agentId: "terry",
      deliver: "turn",
      callerAgentId: "gaia",
      status: "delivered",
      resumeStatus: "running",
      resumeStartedAt: new Date().toISOString(),
      launchedAt: new Date().toISOString(),
    },
  });
  const child = fakeRoom("recovered resume result ✓");
  const parent = fakeRoom("");
  const services = new Map<string, SummonRoomAccess>([
    ["default", parent],
    [childRoomId, child],
  ]);
  const coordinator = new SummonCoordinator(
    workspace,
    path,
    async (roomId) => {
      const service = services.get(roomId);
      if (!service) throw new Error(`unexpected room: ${roomId}`);
      return service;
    },
    async () => 8,
    () => {},
  );
  await coordinator.recoverUndelivered();
  for (let i = 0; i < 100 && parent.delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(parent.delivered.length, 1);
  assert.match(parent.delivered[0].reply, /recovered resume result/);
  assert.equal(parent.delivered[0].delivery.triggerTarget, "gaia");
  assert.equal(child.resumeMarkedDelivered, 1);
  assert.equal(child.markedDelivered, 0);
});

// --- RC5: resume-epoch closure (a watcher may only close ITS OWN resume) ----

/** Window 1 (live path): resume A is in flight; before A's watcher delivers,
 * a NEW resume B stamps its own epoch "running" on disk. A's completion must
 * close A's epoch ONLY — closing B's would strand B (no watcher after a crash,
 * the boot sweep skips it because the record reads "delivered"). */
test("RC5 window 1: a finished resume closes its OWN epoch, never a newer one", async () => {
  const { workspace, path } = await makeWorkspace();
  const childRoomId = "terry-epoch1";
  await mkdir(join(workspace.roomsDir, childRoomId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, childRoomId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: { agentId: "terry", deliver: "turn", callerAgentId: "gaia", status: "delivered", launchedAt: new Date().toISOString() },
  });
  const child = fakeRoom("resume A done");
  const parent = fakeRoom("");
  const services = new Map<string, SummonRoomAccess>([
    ["default", parent],
    [childRoomId, child],
  ]);
  const coordinator = new SummonCoordinator(workspace, path, async (roomId) => services.get(roomId)!, async () => 8, () => {});

  await coordinator.resume(childRoomId, child, "task A");
  const epochA = (normalizeRoomState(await readJson(workspacePaths.roomState(path, childRoomId))).summon as { resumeStartedAt?: string }).resumeStartedAt;
  assert.ok(epochA, "resume A stamped an epoch");

  // Resume B lands while A is still in flight (a second `gaia resume`).
  const epochB = new Date(Date.now() + 1_000).toISOString();
  const handle = await RoomHandle.open(path, childRoomId);
  await handle.updateState((s) => {
    if (s.summon) {
      s.summon.resumeStatus = "running";
      s.summon.resumeStartedAt = epochB;
    }
  });

  child.settle();
  for (let i = 0; i < 100 && parent.delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(parent.delivered.length, 1, "A's result still delivers to the parent");
  assert.deepEqual(child.resumeEpochs, [epochA], "A's watcher carries A's epoch token, not a blind 'latest' stamp");
});

/** Window 2 (boot recovery): the sweep re-arms an interrupted resume; a NEW
 * live resume stamps a newer epoch while the recovered turn runs. Recovery
 * must close only the epoch it scanned. */
test("RC5 window 2: resume recovery carries the epoch it scanned", async () => {
  const { workspace, path } = await makeWorkspace();
  const childRoomId = "terry-epoch2";
  const strandedEpoch = "2026-01-01T00:03:00.000Z";
  await mkdir(join(workspace.roomsDir, childRoomId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, childRoomId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: {
      agentId: "terry",
      deliver: "turn",
      callerAgentId: "gaia",
      status: "delivered",
      resumeStatus: "running",
      resumeStartedAt: strandedEpoch,
      launchedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  const child = fakeRoom("recovered result");
  const parent = fakeRoom("");
  const services = new Map<string, SummonRoomAccess>([
    ["default", parent],
    [childRoomId, child],
  ]);
  const coordinator = new SummonCoordinator(workspace, path, async (roomId) => services.get(roomId)!, async () => 8, () => {});

  await coordinator.recoverUndelivered();
  for (let i = 0; i < 100 && parent.delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(parent.delivered.length, 1);
  assert.deepEqual(child.resumeEpochs, [strandedEpoch], "recovery passes the scanned epoch through to the close");
});

/** The durable half: RoomService's stamp is epoch-guarded, so even a stale
 * token arriving late cannot close a newer resume's record. */
test("RC5: markSummonResumeDelivered only closes a matching epoch (real RoomService)", async () => {
  const { workspace, path } = await makeWorkspace();
  const roomId = "terry-epoch3";
  await mkdir(join(workspace.roomsDir, roomId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, roomId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: {
      agentId: "terry",
      deliver: "note",
      status: "delivered",
      resumeStatus: "running",
      resumeStartedAt: "2026-02-02T00:00:00.000Z",
      launchedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    roomId,
    memoryStore: new MemoryStore(),
    runtimeFactory: (agentDef) => scriptedRuntime(agentDef, () => "noop"),
  });
  await service.markSummonResumeDelivered("2026-01-01T00:09:00.000Z"); // stale token
  let state = normalizeRoomState(await readJson(workspacePaths.roomState(path, roomId)));
  assert.equal(state.summon?.resumeStatus, "running", "stale epoch must not close the live resume");
  await service.markSummonResumeDelivered("2026-02-02T00:00:00.000Z"); // own token
  state = normalizeRoomState(await readJson(workspacePaths.roomState(path, roomId)));
  assert.equal(state.summon?.resumeStatus, "delivered");
});

// --- Fix #2: `gaia summon --status` census -------------------------------

test("census: running/idle/dead/completed-undelivered states, scoped by parent, with a last-event time (Fix #2)", async () => {
  const { workspace, path } = await makeWorkspace();

  // idle: settled, delivered, a normal (non-failure) transcript line.
  const idleId = "terry-idle1";
  await mkdir(join(workspace.roomsDir, idleId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, idleId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: { agentId: "terry", deliver: "note", status: "delivered", launchedAt: "2026-01-01T00:00:00.000Z" },
  });
  await writeFile(workspacePaths.transcript(path, idleId), `${JSON.stringify({ author: "terry", text: "all done", timestamp: "2026-01-01T00:01:00.000Z" })}\n`, "utf8");

  // dead: settled, delivered, but the transcript recorded a turn failure.
  const deadId = "terry-dead1";
  await mkdir(join(workspace.roomsDir, deadId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, deadId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: { agentId: "terry", deliver: "note", status: "delivered", launchedAt: "2026-01-01T00:00:00.000Z" },
  });
  await writeFile(
    workspacePaths.transcript(path, deadId),
    `${JSON.stringify({ author: "system", text: "⚠ turn failed: boom", timestamp: "2026-01-01T00:02:00.000Z" })}\n`,
    "utf8",
  );

  // completed-undelivered (the lampas class): durable record still reads
  // "running" (here via resumeStatus) but nothing in THIS process is
  // watching it — exactly recoverUndelivered's own re-arm predicate.
  const lampasId = "terry-lampas1";
  await mkdir(join(workspace.roomsDir, lampasId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, lampasId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: {
      agentId: "terry",
      deliver: "note",
      status: "delivered",
      resumeStatus: "running",
      resumeStartedAt: "2026-01-01T00:03:00.000Z",
      launchedAt: "2026-01-01T00:00:00.000Z",
    },
  });

  // running: a live launch this coordinator has NOT yet seen settle.
  const liveChild = fakeRoom("");
  const parent = fakeRoom("");
  const coordinator = new SummonCoordinator(workspace, path, async (roomId) => (roomId === "default" ? parent : liveChild), async () => 8, () => {});
  const { roomId: runningId } = await coordinator.launch("default", "terry", "still going", { deliver: "note" });
  assert.equal(coordinator.runningChildren("default").length, 1, "sanity: truly tracked as running right now");

  const entries = await coordinator.census("default");
  const byId = new Map(entries.map((entry) => [entry.roomId, entry]));
  assert.equal(byId.get(runningId)?.state, "running");
  assert.equal(byId.get(idleId)?.state, "idle");
  assert.equal(byId.get(idleId)?.delivered, true);
  assert.ok(byId.get(idleId)?.lastEventAt, "idle lane carries a last-event time (transcript mtime)");
  assert.equal(byId.get(deadId)?.state, "dead");
  assert.equal(byId.get(deadId)?.delivered, true);
  assert.equal(byId.get(lampasId)?.state, "completed-undelivered");
  assert.equal(byId.get(lampasId)?.resumeStatus, "running");
  assert.ok(entries.every((entry) => entry.dirtyWorktree === undefined), "no workDir on any fixture → no hint attempted");

  // Scoped by parent: an unrelated parent room sees none of these.
  assert.equal((await coordinator.census("someone-elses-room")).length, 0);
});

test("census: dirty-worktree hint reads a real `git status` when a workDir is cheaply known", async () => {
  const { workspace, path } = await makeWorkspace();
  const { execFileSync } = await import("node:child_process");
  const repoDir = await mkdtemp(join(tmpdir(), "gaia-census-git-"));
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir });
  await writeFile(join(repoDir, "a.txt"), "1", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

  const roomId = "terry-workdir1";
  await mkdir(join(workspace.roomsDir, roomId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, roomId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    workDir: repoDir,
    summon: { agentId: "terry", deliver: "note", status: "delivered", launchedAt: new Date().toISOString() },
  });
  const coordinator = new SummonCoordinator(
    workspace,
    path,
    async () => {
      throw new Error("census must never open a live service");
    },
    async () => 8,
    () => {},
  );

  let entries = await coordinator.census("default");
  assert.equal(entries.find((entry) => entry.roomId === roomId)?.dirtyWorktree, false, "clean checkout reports dirtyWorktree:false");

  await writeFile(join(repoDir, "a.txt"), "2", "utf8"); // modify a TRACKED file
  entries = await coordinator.census("default");
  assert.equal(entries.find((entry) => entry.roomId === roomId)?.dirtyWorktree, true, "a modified tracked file reports dirtyWorktree:true");
});

test("resume: two CONCURRENT resumes into the same child deliver to the parent exactly once (no double delivery)", async () => {
  const { workspace, path } = await makeWorkspace();
  const childRoomId = "terry-resume-race1";
  await mkdir(join(workspace.roomsDir, childRoomId), { recursive: true });
  await writeJsonAtomic(workspacePaths.roomState(path, childRoomId), {
    activeRoles: {},
    agentCursors: {},
    parentRoomId: "default",
    summon: { agentId: "terry", deliver: "turn", callerAgentId: "gaia", status: "delivered", launchedAt: new Date().toISOString() },
  });
  const child = fakeRoom("raced resume result");
  const parent = fakeRoom("");
  const services = new Map<string, SummonRoomAccess>([
    ["default", parent],
    [childRoomId, child],
  ]);
  const coordinator = new SummonCoordinator(
    workspace,
    path,
    async (roomId) => {
      const service = services.get(roomId);
      if (!service) throw new Error(`unexpected room: ${roomId}`);
      return service;
    },
    async () => 8,
    () => {},
  );

  const [a, b] = await Promise.all([
    coordinator.resume(childRoomId, child, "steer one"),
    coordinator.resume(childRoomId, child, "steer two"),
  ]);
  assert.equal(a.tracked, true);
  assert.equal(b.tracked, true);
  assert.deepEqual([...child.sent].sort(), ["steer one", "steer two"], "both steers reached the room");

  child.settle();
  for (let i = 0; i < 100 && parent.delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(parent.delivered.length, 1, "ONE delivery for the merged resumed turn, not two");
  assert.equal(child.resumeMarkedDelivered, 1, "resume record closed out exactly once (fakeRoom counts; real RoomService persists)");
  assert.equal(coordinator.runningChildren().length, 0);
});
