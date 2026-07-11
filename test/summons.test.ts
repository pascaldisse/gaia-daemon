import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
  settle: (status?: string, error?: string) => void;
} {
  const listeners = new Set<(event: SummonTaskEvent) => void>();
  const task = { id: "t1", status: "running" as string, error: undefined as string | undefined };
  const room = {
    sent: [] as string[],
    delivered: [] as { from: string; reply: string; delivery: SummonResultDelivery }[],
    markedDelivered: 0,
    settle(status = "complete", error?: string) {
      task.status = status;
      task.error = error;
      for (const listener of listeners) listener({ type: status === "error" ? "task-error" : "task-end", task: { id: task.id } });
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
      return reply;
    },
    async waitForSettled() {},
    async deliverAgentResult(from: string, reply: string, delivery: SummonResultDelivery) {
      room.delivered.push({ from, reply, delivery });
    },
    async markSummonDelivered() {
      room.markedDelivered += 1;
    },
  };
  return room;
}

test("summonAndWait creates a linked child room and returns the worker's reply", async () => {
  const { workspace, path } = await makeWorkspace();
  const room = fakeRoom("worker says done");
  const coordinator = new SummonCoordinator(workspace, path, async () => room, 8, () => {});

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
  const coordinator = new SummonCoordinator(workspace, path, async (roomId) => services.get(roomId) ?? child, 8, () => {});

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

test("a failed worker turn is delivered loudly, never swallowed", async () => {
  const { workspace, path } = await makeWorkspace();
  const child = fakeRoom("");
  const parent = fakeRoom("");
  const services = new Map<string, SummonRoomAccess>([["default", parent]]);
  const coordinator = new SummonCoordinator(workspace, path, async (roomId) => services.get(roomId) ?? child, 8, () => {});

  const { done } = await coordinator.launch("default", "terry", "doomed task", { deliver: "note" });
  child.settle("error", "sandbox exploded");
  await done.catch(() => {}); // done rejects; the failure still got delivered
  assert.equal(parent.delivered.length, 1);
  assert.equal(parent.delivered[0].delivery.failed, true); // rendered as a "⚠️ FAILED" collapsed header
  assert.match(parent.delivered[0].reply, /sandbox exploded/);
  assert.equal(parent.delivered[0].delivery.triggerTarget, undefined); // note mode: no turn trigger
  assert.equal(child.markedDelivered, 1); // delivered (the failure IS the result)
});

test("summon refuses unknown agents and enforces the per-room cap", async () => {
  const { workspace, path } = await makeWorkspace();
  const room = fakeRoom("ok");
  const coordinator = new SummonCoordinator(workspace, path, async () => room, 1, () => {});

  await assert.rejects(() => coordinator.summon("default", "nobody", "task"), /Unknown agent/);

  await coordinator.summon("default", "terry", "long task");
  assert.equal(coordinator.runningChildren("default").length, 1);
  await assert.rejects(() => coordinator.summon("default", "gaia", "another"), /Too many running summons/);
  room.settle();
});

test("an untrusted caller's summon runs under the untrusted tier — forced sandbox regardless of the worker's own trust", async () => {
  // caller 'shady' is trust:false; worker 'naked' is TRUSTED and even
  // configures its own sandbox off — the exact escape the tier must close.
  const shady = agent({ id: "shady", trust: false });
  const naked = agent({ id: "naked", sandbox: { enabled: false, backend: "none" } });
  const { workspace, path } = await makeWorkspace({ shady, naked });
  const room = fakeRoom("ok");
  const coordinator = new SummonCoordinator(workspace, path, async () => room, 8, () => {});

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
  }, 8, () => {});

  await coordinator.recoverUndelivered();
  // Recovery runs in the background — wait for the delivery to land.
  for (let i = 0; i < 100 && parent.delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(parent.delivered.length, 1);
  assert.match(parent.delivered[0].reply, /recovered result/);
  assert.equal(parent.delivered[0].delivery.triggerTarget, "gaia");
  assert.equal(child.markedDelivered, 1);
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
  }, 8, () => {});
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

  const coordinator = new SummonCoordinator(workspace, path, serviceFor, 8, () => {});
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
  assert.equal(childState.summon?.status, "delivered");
});
