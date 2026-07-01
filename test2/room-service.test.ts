import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomService } from "../src2/services/room-service.js";
import { RoomHandle } from "../src2/domain/rooms.js";
import { MemoryStore } from "../src2/domain/memory.js";
import { readJson } from "../src2/core/store.js";
import { workspacePaths } from "../src2/core/paths.js";
import type { AgentDef, AgentEvent, UiEvent, Workspace } from "../src2/core/types.js";
import type { AgentRuntime } from "../src2/harness/spec.js";

process.env.GAIA_HOME = await mkdtemp(join(tmpdir(), "gaia-home-"));

function makeAgent(id: string, root: string): AgentDef {
  const dir = join(root, "agents", id);
  return {
    id,
    displayName: id[0].toUpperCase() + id.slice(1),
    icon: "🤖",
    dir,
    configPath: join(dir, "agent.json"),
    personaDir: join(dir, "persona"),
    rolesDir: join(dir, "persona", "roles"),
    soulPath: join(dir, "persona", "SOUL.md"),
    memoryDir: join(dir, "persona", "memory"),
    tools: [],
  };
}

/** Scripted runtime: replies with fixed events per send() call. */
function scriptedRuntime(agent: AgentDef, script: () => AgentEvent[]): AgentRuntime & { aborted: boolean; sends: number } {
  const runtime = {
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    aborted: false,
    sends: 0,
    async *send() {
      runtime.sends += 1;
      for (const event of script()) yield event;
    },
    async abort() {
      runtime.aborted = true;
    },
    dispose() {},
    resetRoom() {},
  };
  return runtime as AgentRuntime & { aborted: boolean; sends: number };
}

async function makeService(options: {
  script?: () => AgentEvent[];
  agents?: string[];
} = {}): Promise<{ service: RoomService; workspace: Workspace; root: string; events: UiEvent[]; runtimes: Map<string, ReturnType<typeof scriptedRuntime>> }> {
  const root = await mkdtemp(join(tmpdir(), "gaia-svc-"));
  await mkdir(join(root, ".gaia", "rooms", "default"), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), "{}", "utf8");

  const agentIds = options.agents ?? ["gaia", "terry"];
  const agents = Object.fromEntries(agentIds.map((id) => [id, makeAgent(id, root)]));
  const workspace: Workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20 },
    contextFiles: [],
    agents,
  };

  const script = options.script ?? (() => [{ type: "text-delta", delta: "hello from agent" } as AgentEvent]);
  const runtimes = new Map<string, ReturnType<typeof scriptedRuntime>>();
  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    memoryStore: new MemoryStore(),
    runtimeFactory: (agent) => {
      const runtime = scriptedRuntime(agent, script);
      runtimes.set(agent.id, runtime);
      return runtime;
    },
  });
  const events: UiEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { service, workspace, root, events, runtimes };
}

test("a plain message routes to the default agent and commits a detailed reply", async () => {
  const { service, root, events } = await makeService({
    script: () => [
      { type: "model-info", provider: "test", modelId: "m1", subscription: false },
      { type: "thinking-start" },
      { type: "thinking-delta", delta: "pondering" },
      { type: "thinking-end" },
      { type: "text-delta", delta: "the " },
      { type: "text-delta", delta: "answer" },
    ],
  });
  const task = await service.sendMessage("what is up?");
  await service.waitForIdle();
  assert.equal(task.targets[0], "gaia");

  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  assert.equal(transcript.length, 2);
  assert.equal(transcript[0].author, "user");
  const reply = transcript[1] as { author: string; text: string; details?: { model?: string; thinking?: string } };
  assert.equal(reply.author, "gaia");
  assert.equal(reply.text, "the answer");
  // Details live ON the event — no side-table, no LRU amnesia.
  assert.equal(reply.details?.model, "test/m1");
  assert.equal(reply.details?.thinking, "pondering");

  // Cursor advanced past the user message + own reply.
  assert.equal((await room.state()).agentCursors.gaia, 2);
  // Streaming deltas carried the reserved eventId that the commit used.
  const delta = events.find((event) => event.type === "text-delta") as { eventId?: string } | undefined;
  assert.equal(delta?.eventId, reply["id" as keyof typeof reply]);
});

test("@mentions route to multiple agents in order; unknown mentions fail at send time", async () => {
  const { service, root } = await makeService();
  await assert.rejects(() => service.sendMessage("@nobody hi"), /Unknown agent/);

  await service.sendMessage("@terry @gaia both of you");
  await service.waitForIdle();
  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  assert.deepEqual(
    transcript.map((event) => event.author),
    ["user", "terry", "gaia"],
  );
});

test("messages sent while busy queue DURABLY and drain in order", async () => {
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let first = true;
  const { service, root } = await makeService({
    script: () => {
      if (first) {
        first = false;
        return [{ type: "text-delta", delta: "first (slow)" } as AgentEvent];
      }
      return [{ type: "text-delta", delta: "queued reply" } as AgentEvent];
    },
  });
  // Make the first turn slow by wrapping runtime.send via a slow onEvent — simplest:
  // send the first message, then immediately queue two more before it settles.
  const t1 = await service.sendMessage("one");
  const t2 = await service.sendMessage("two");
  const t3 = await service.sendMessage("three");
  releaseFirst();
  assert.equal(t1.status === "running" || t1.status === "complete", true);
  assert.equal(t2.status, "queued");
  assert.equal(t3.status, "queued");

  // DURABILITY: the queue is on disk, not in a private array (v1's data-loss bug).
  const persisted = (await readJson(workspacePaths.roomState(root, "default"))) as { queue?: unknown[] };
  assert.ok((persisted.queue?.length ?? 0) >= 1, "queued messages persisted to state.json");

  await service.waitForIdle();
  // Drain until everything ran.
  for (let i = 0; i < 10 && (await RoomHandle.open(root, "default").then((r) => r.state().then((s) => s.queue?.length ?? 0))) > 0; i++) {
    await service.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  const userTexts = transcript.filter((event) => event.author === "user").map((event) => event.text);
  assert.deepEqual(userTexts, ["one", "two", "three"]);
  assert.equal((await room.state()).queue, undefined);
});

test("a queued message survives a daemon restart (drains on boot)", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-restart-"));
  await mkdir(join(root, ".gaia", "rooms", "default"), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), "{}", "utf8");
  // A prior process died with a message still queued.
  const room = await RoomHandle.open(root, "default");
  await room.enqueue({ taskId: "task_zombie", text: "resurrect me", targets: ["gaia"], queuedAt: "2026-01-01" });

  const agents = { gaia: makeAgent("gaia", root) };
  const workspace: Workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20 },
    contextFiles: [],
    agents,
  };
  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    memoryStore: new MemoryStore(),
    runtimeFactory: (agent) => scriptedRuntime(agent, () => [{ type: "text-delta", delta: "revived" } as AgentEvent]),
  });
  await service.init();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await service.waitForIdle();

  const reopened = await RoomHandle.open(root, "default");
  const { events: transcript } = await reopened.eventsFrom(0);
  assert.ok(transcript.some((event) => event.author === "gaia" && event.text === "revived"), "queued message ran after restart");
  assert.equal((await reopened.state()).queue, undefined);
});

test("an interrupted turn resumes on boot: partial committed, prompt replayed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-resume-"));
  await mkdir(join(root, ".gaia", "rooms", "default"), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), "{}", "utf8");
  const room = await RoomHandle.open(root, "default");
  // Simulate a crash mid-stream: user message on disk, pendingTurn with partial.
  await room.addUserMessage("long question", ["gaia"]);
  await room.markPendingTurn({
    id: "task_dead",
    eventId: "evt_reserved",
    prompt: "long question",
    targets: ["gaia"],
    agentId: "gaia",
    partialReply: "partial progress before the crash",
    startedAt: "2026-01-01",
  });

  const agents = { gaia: makeAgent("gaia", root) };
  const workspace: Workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20 },
    contextFiles: [],
    agents,
  };
  const runtimes = new Map<string, ReturnType<typeof scriptedRuntime>>();
  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    memoryStore: new MemoryStore(),
    runtimeFactory: (agent) => {
      const runtime = scriptedRuntime(agent, () => [{ type: "text-delta", delta: "resumed and finished" } as AgentEvent]);
      runtimes.set(agent.id, runtime);
      return runtime;
    },
  });
  await service.init();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await service.waitForIdle();

  const reopened = await RoomHandle.open(root, "default");
  const { events: transcript } = await reopened.eventsFrom(0);
  const gaiaReplies = transcript.filter((event) => event.author === "gaia").map((event) => event.text);
  // The partial streamed before the crash was preserved…
  assert.ok(gaiaReplies.includes("partial progress before the crash"), `partial preserved (got: ${JSON.stringify(gaiaReplies)})`);
  // …and the prompt was replayed so the agent CONTINUED.
  assert.ok(gaiaReplies.includes("resumed and finished"), "turn re-ran after resume");
  // The user message was NOT re-recorded.
  assert.equal(transcript.filter((event) => event.author === "user").length, 1);
  assert.equal((await reopened.state()).pendingTurn, undefined);
});

test("crash between transcript append and ack finishes the commit without re-running", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-ack-"));
  await mkdir(join(root, ".gaia", "rooms", "default"), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), "{}", "utf8");
  const room = await RoomHandle.open(root, "default");
  await room.addUserMessage("question", ["gaia"]);
  // The reply REACHED the transcript, but the state ack never happened.
  await room.appendEvent({ id: "evt_committed", timestamp: "t", author: "gaia", text: "full reply" });
  await room.markPendingTurn({
    id: "task_dead",
    eventId: "evt_committed",
    prompt: "question",
    targets: ["gaia"],
    agentId: "gaia",
    partialReply: "full reply",
    startedAt: "2026-01-01",
  });

  const agents = { gaia: makeAgent("gaia", root) };
  const workspace: Workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20 },
    contextFiles: [],
    agents,
  };
  const runtimes = new Map<string, ReturnType<typeof scriptedRuntime>>();
  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    memoryStore: new MemoryStore(),
    runtimeFactory: (agent) => {
      const runtime = scriptedRuntime(agent, () => [{ type: "text-delta", delta: "MUST NOT RUN" } as AgentEvent]);
      runtimes.set(agent.id, runtime);
      return runtime;
    },
  });
  await service.init();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await service.waitForIdle();

  const reopened = await RoomHandle.open(root, "default");
  const { events: transcript } = await reopened.eventsFrom(0);
  // v1 would re-run this turn (duplicate work, duplicate reply). v2 detects the
  // committed event id and only finishes the state write.
  assert.equal(runtimes.get("gaia")?.sends ?? 0, 0, "the turn did not re-run");
  assert.equal(transcript.filter((event) => event.author === "gaia").length, 1);
  const state = await reopened.state();
  assert.equal(state.pendingTurn, undefined);
  assert.equal(state.agentCursors.gaia, 2);
});

test("cancel aborts the runtime, preserves partial output, and clears the durable queue", async () => {
  let sawDelta: () => void = () => {};
  const firstDelta = new Promise<void>((resolve) => {
    sawDelta = resolve;
  });
  let hold: Promise<void> = Promise.resolve();
  let releaseHold: () => void = () => {};
  hold = new Promise((resolve) => {
    releaseHold = resolve;
  });

  const root = await mkdtemp(join(tmpdir(), "gaia-cancel-"));
  await mkdir(join(root, ".gaia", "rooms", "default"), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), "{}", "utf8");
  const agents = { gaia: makeAgent("gaia", root) };
  const workspace: Workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20 },
    contextFiles: [],
    agents,
  };
  const runtime: AgentRuntime & { aborted: boolean } = {
    agent: agents.gaia,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    aborted: false,
    async *send() {
      yield { type: "text-delta", delta: "partial before cancel" } as AgentEvent;
      sawDelta();
      await hold;
    },
    async abort() {
      runtime.aborted = true;
      releaseHold();
    },
    dispose() {},
    resetRoom() {},
  } as AgentRuntime & { aborted: boolean };

  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    memoryStore: new MemoryStore(),
    runtimeFactory: () => runtime,
  });
  await service.sendMessage("go");
  const queued = await service.sendMessage("queued behind");
  await firstDelta;
  const cancelled = await service.cancelActiveTask();
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(runtime.aborted, true);
  assert.equal(queued.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 100));

  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  // Cancel is a deliberate stop — but progress is never discarded.
  assert.ok(transcript.some((event) => event.author === "gaia" && event.text === "partial before cancel"));
  assert.equal((await room.state()).queue, undefined);
});

test("/clear wipes transcript + cursors and /fork branches with reset cursors", async () => {
  const { service, root } = await makeService();
  await service.sendMessage("hello");
  await service.waitForIdle();

  const cleared = await service.sendMessage("/clear");
  assert.equal(cleared.status, "complete");
  const room = await RoomHandle.open(root, "default");
  assert.equal((await room.eventsFrom(0)).events.length, 0);
  assert.deepEqual((await room.state()).agentCursors, {});

  await service.sendMessage("rebuild history");
  await service.waitForIdle();
  const forked = await service.sendMessage("/fork");
  assert.equal(forked.status, "complete");
  const forkRoom = await RoomHandle.open(root, "default-fork");
  const { events: forkEvents } = await forkRoom.eventsFrom(0);
  assert.ok(forkEvents.length >= 2, "transcript copied");
  assert.deepEqual((await forkRoom.state()).agentCursors, {}, "cursors reset so the branch replays history");
});

test("slash commands emit a system room-event and settle synchronously", async () => {
  const { service, events } = await makeService();
  const task = await service.sendMessage("/help");
  assert.equal(task.status, "complete");
  const system = events.find((event) => event.type === "room-event" && event.event.author === "system");
  assert.ok(system, "system reply emitted");
  const unknown = await service.sendMessage("/nonsense");
  assert.equal(unknown.status, "complete");
});
