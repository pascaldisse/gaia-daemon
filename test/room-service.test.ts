import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile as readFileText } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_DIALOGUE_MAX_HOPS, RoomService, type RoomMemoryHooks } from "../src/services/room-service.js";
import { RoomHandle } from "../src/domain/rooms.js";
import { MemoryStore } from "../src/domain/memory.js";
import { readJson } from "../src/core/store.js";
import { workspacePaths } from "../src/core/paths.js";
import type { AgentDef, AgentEvent, SanitizeProposal, Snapshot, UiEvent, Workspace, WorkspaceConfig } from "../src/core/types.js";
import type { AgentInput, AgentRuntime } from "../src/harness/spec.js";
import type { SummonHost } from "../src/services/summons.js";
import type { ConsolidateLlm } from "../src/services/consolidate.js";

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
function scriptedRuntime(agent: AgentDef, script: () => AgentEvent[]): AgentRuntime & { aborted: boolean; sends: number; resets: number } {
  const runtime = {
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    aborted: false,
    sends: 0,
    resets: 0,
    async *send() {
      runtime.sends += 1;
      for (const event of script()) yield event;
    },
    async abort() {
      runtime.aborted = true;
    },
    dispose() {},
    resetRoom() {
      runtime.resets += 1;
    },
  };
  return runtime as AgentRuntime & { aborted: boolean; sends: number; resets: number };
}

async function makeService(options: {
  script?: () => AgentEvent[];
  agents?: string[];
  runtimeFactory?: (agent: AgentDef) => AgentRuntime;
  memory?: RoomMemoryHooks;
  settingsChanged?: (scope: "global" | "workspace") => Promise<void>;
  summonHost?: SummonHost;
  config?: Partial<WorkspaceConfig>;
  llm?: ConsolidateLlm;
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
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20, ...options.config },
    contextFiles: [],
    agents,
  };

  const script = options.script ?? (() => [{ type: "text-delta", delta: "hello from agent" } as AgentEvent]);
  const runtimes = new Map<string, ReturnType<typeof scriptedRuntime>>();
  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    memoryStore: new MemoryStore(),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.settingsChanged ? { settingsChanged: options.settingsChanged } : {}),
    ...(options.summonHost ? { summonHost: options.summonHost } : {}),
    ...(options.llm ? { llm: options.llm } : {}),
    runtimeFactory: (agent) => {
      const runtime = options.runtimeFactory ? (options.runtimeFactory(agent) as ReturnType<typeof scriptedRuntime>) : scriptedRuntime(agent, script);
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

test("/compact runs on an idle room (does not self-block), shows a compacting status mid-pass, and persists its reply", async () => {
  let serviceRef: RoomService | undefined;
  let compactCalls = 0;
  let statusDuringCompact: string | undefined;
  const factory = (agent: AgentDef) => {
    const runtime = scriptedRuntime(agent, () => [{ type: "text-delta", delta: "hi" } as AgentEvent]);
    // Declare native compaction and capture the live agent status mid-pass — the
    // command must not trip on its own task, and the UI must see "compacting".
    runtime.capabilities = { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsCompact: true };
    (runtime as unknown as { compact: (roomId: string) => Promise<string> }).compact = async () => {
      compactCalls += 1;
      const snapshot = await serviceRef!.getSnapshot();
      statusDuringCompact = snapshot.agents.find((agent) => agent.id === "gaia")?.status;
      return "session compacted (999 tokens before).";
    };
    return runtime as unknown as AgentRuntime;
  };
  const { service, root } = await makeService({ runtimeFactory: factory });
  serviceRef = service;

  const task = await service.sendMessage("/compact");
  assert.equal(task.status, "complete");
  assert.equal(compactCalls, 1, "harness compaction actually ran — the command did not self-block");
  assert.equal(statusDuringCompact, "compacting", "the agent shows a compacting status while the pass runs");

  // After settling, the status clears back to idle...
  const after = await service.getSnapshot();
  assert.equal(after.agents.find((agent) => agent.id === "gaia")?.status, "idle");

  // ...and the reply is persisted so it survives a reload (not just a live flash).
  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  assert.ok(
    transcript.some((event) => event.author === "system" && /session compacted \(999 tokens before\)/.test(event.text)),
    "compaction reply is written to the transcript",
  );
});

test("/compact streams live progress (token counts + start time) into the snapshot", async () => {
  let serviceRef: RoomService | undefined;
  let midPass: Snapshot | undefined;
  const factory = (agent: AgentDef) => {
    const runtime = scriptedRuntime(agent, () => [{ type: "text-delta", delta: "hi" } as AgentEvent]);
    runtime.capabilities = { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsCompact: true };
    (
      runtime as unknown as { compact: (roomId: string, onProgress?: (u: { outputTokens?: number }) => void) => Promise<string> }
    ).compact = async (_roomId, onProgress) => {
      // The harness reports the summary growing; it must reach the snapshot.
      onProgress?.({ outputTokens: 512 });
      midPass = await serviceRef!.getSnapshot();
      return "session compacted.";
    };
    return runtime as unknown as AgentRuntime;
  };
  const { service } = await makeService({ runtimeFactory: factory });
  serviceRef = service;

  const task = await service.sendMessage("/compact");
  assert.equal(task.status, "complete");

  const during = midPass?.agents.find((agent) => agent.id === "gaia");
  assert.equal(during?.status, "compacting");
  assert.equal(during?.compact?.outputTokens, 512, "live output-token progress reached the snapshot");
  assert.equal(typeof during?.compact?.startedAt, "number", "a start time is stamped so the client can tick an elapsed");

  // Progress is cleared once the pass settles (no stale numbers on the idle agent).
  const after = await service.getSnapshot();
  assert.equal(after.agents.find((agent) => agent.id === "gaia")?.compact, undefined);
});

test("bare /compact targets the room's ACTIVE agent, not the workspace default", async () => {
  // The room default is gaia, but the user has been talking to terry. A bare
  // /compact must compact terry (who they're addressing), not gaia — else it
  // reports "nothing to compact" for an agent with no session in this room.
  const compacted: string[] = [];
  const factory = (agent: AgentDef) => {
    const runtime = scriptedRuntime(agent, () => [{ type: "text-delta", delta: "hi" } as AgentEvent]);
    runtime.capabilities = { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsCompact: true };
    (runtime as unknown as { compact: (roomId: string) => Promise<string> }).compact = async () => {
      compacted.push(agent.id);
      return "session compacted.";
    };
    return runtime as unknown as AgentRuntime;
  };
  const { service } = await makeService({ agents: ["gaia", "terry"], runtimeFactory: factory });

  // Address terry so the room remembers them as its active agent...
  await service.sendMessage("@terry hello");
  await service.waitForIdle();
  // ...then a bare /compact must land on terry, not the workspace default gaia.
  const task = await service.sendMessage("/compact");
  assert.equal(task.status, "complete");
  assert.deepEqual(compacted, ["terry"], "bare /compact compacted the active agent, not the default");
});

test("/cancel aborts a running compaction — the pass is killed and the reply says cancelled, not crashed", async () => {
  // The /compact command task carries no targets, so cancel must reach the
  // compacting agent through compactingAgents — otherwise "stop" reports
  // cancelled while the harness keeps going and compacts the session anyway.
  let abortCalled = false;
  let rejectCompact: ((err: Error) => void) | undefined;
  const factory = (agent: AgentDef) => {
    const runtime = scriptedRuntime(agent, () => [{ type: "text-delta", delta: "hi" } as AgentEvent]);
    runtime.capabilities = { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsCompact: true };
    // A pass that only ends when aborted — mirrors the real chain, where
    // abort() kills the harness process and the in-flight compact rejects.
    (runtime as unknown as { compact: (roomId: string) => Promise<string> }).compact = () =>
      new Promise<string>((_resolve, reject) => {
        rejectCompact = reject;
      });
    runtime.abort = async () => {
      abortCalled = true;
      rejectCompact?.(new Error("claude exited (signal SIGTERM) before compacting."));
    };
    return runtime as unknown as AgentRuntime;
  };
  const { service, root } = await makeService({ runtimeFactory: factory });

  const compactTask = service.sendMessage("/compact"); // resolves only when the pass settles
  // Wait until the pass is actually live before cancelling it.
  while (!rejectCompact) await new Promise((resolve) => setTimeout(resolve, 5));

  const cancel = await service.sendMessage("/cancel");
  assert.equal(cancel.status, "complete");
  const task = await compactTask;
  assert.equal(task.status, "cancelled");
  assert.equal(abortCalled, true, "cancel aborted the compacting runtime despite the command task having no targets");

  // The persisted reply reads as a deliberate cancel, not a harness crash.
  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  assert.ok(
    transcript.some((event) => event.author === "system" && /Compaction cancelled for @gaia\./.test(event.text)),
    "cancel reply persisted",
  );
  assert.ok(
    !transcript.some((event) => /Compaction failed/.test(event.text)),
    "the abort is not misreported as a failure",
  );
  const after = await service.getSnapshot();
  assert.equal(after.agents.find((agent) => agent.id === "gaia")?.status, "idle", "compacting status cleared");
});

test("a successful compact refreshes the stale ctx chip: streamed summary size, else dropped", async () => {
  // Before the fix the chip sat on the pre-compact % until the next turn.
  let compactCalls = 0;
  const factory = (agent: AgentDef) => {
    const runtime = scriptedRuntime(agent, () => [
      { type: "context-usage", usedTokens: 100_000, maxTokens: 200_000 } as AgentEvent,
      { type: "text-delta", delta: "hi" } as AgentEvent,
    ]);
    runtime.capabilities = { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsCompact: true };
    (
      runtime as unknown as { compact: (roomId: string, onProgress?: (u: { outputTokens?: number }) => void) => Promise<string> }
    ).compact = async (_roomId, onProgress) => {
      compactCalls += 1;
      if (compactCalls === 1) onProgress?.({ outputTokens: 512 }); // second pass streams nothing
      return "session compacted.";
    };
    return runtime as unknown as AgentRuntime;
  };
  const { service, root } = await makeService({ runtimeFactory: factory });

  await service.sendMessage("hello");
  await service.waitForIdle();
  assert.equal((await service.getSnapshot()).agents.find((agent) => agent.id === "gaia")?.context?.usedTokens, 100_000);

  // Pass 1 streamed a 512-token summary: that becomes the chip (max kept).
  await service.sendMessage("/compact");
  const streamed = (await service.getSnapshot()).agents.find((agent) => agent.id === "gaia")?.context;
  assert.deepEqual(streamed, { usedTokens: 512, maxTokens: 200_000 }, "chip shows the streamed post-compact size");
  const persisted = (await (await RoomHandle.open(root, "default")).state()).contextUsage?.gaia;
  assert.deepEqual(persisted, { usedTokens: 512, maxTokens: 200_000 }, "post-compact usage persisted durably");

  // Pass 2 reported nothing: better no chip than a stale one.
  await service.sendMessage("/compact");
  const dropped = (await service.getSnapshot()).agents.find((agent) => agent.id === "gaia")?.context;
  assert.equal(dropped, undefined, "stale usage dropped when the harness streamed no post-compact figure");
});

test("persisted system command replies are kept out of the agent's replayed context", async () => {
  let seenTranscript: AgentInput["transcript"] | undefined;
  const factory = (agent: AgentDef) => {
    const runtime = scriptedRuntime(agent, () => [{ type: "text-delta", delta: "ok" } as AgentEvent]);
    const original = runtime.send.bind(runtime);
    runtime.send = async function* (input: AgentInput) {
      seenTranscript = input.transcript;
      yield* original(input);
    } as typeof runtime.send;
    return runtime as unknown as AgentRuntime;
  };
  const { service, root } = await makeService({ runtimeFactory: factory });

  await service.sendMessage("hello"); // a normal exchange (user + agent)
  await service.waitForIdle();
  await service.sendMessage("/help"); // persists an @system reply to the transcript
  await service.waitForIdle();

  // A fresh agent joins → full replay from cursor 0. Its transcript must carry
  // the human/agent turns but NOT the persisted /help system reply.
  await service.sendMessage("@terry catch up");
  await service.waitForIdle();

  assert.ok(seenTranscript, "agent turn ran");
  assert.ok(seenTranscript!.some((event) => event.author === "user"), "human events reach the agent");
  assert.ok(!seenTranscript!.some((event) => event.author === "system"), "system command replies are filtered out of agent context");

  // The /help reply is still on disk for the UI to render on reload.
  const room = await RoomHandle.open(root, "default");
  const { events: raw } = await room.eventsFrom(0);
  assert.ok(
    raw.some((event) => event.author === "system"),
    "system reply persisted for the UI",
  );
});

test("/steer injects into the RUNNING turn without queueing behind it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const steerCalls: string[] = [];
  const factory = (agent: AgentDef): AgentRuntime => ({
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsMcp: false, supportsSteer: true },
    async *send() {
      await gate;
      yield { type: "text-delta", delta: "answer (steered)" } as AgentEvent;
    },
    async steer(_roomId: string, message: string) {
      steerCalls.push(message);
      return true;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
  });
  const { service, root, events } = await makeService({ runtimeFactory: factory });

  await service.sendMessage("start a long task");
  const steerTask = await service.sendMessage("/steer focus only on the tests");
  assert.equal(steerTask.status, "complete", "steer settles while the turn still runs");
  assert.deepEqual(steerCalls, ["focus only on the tests"]);
  const reply = events.find((event) => event.type === "room-event" && event.event.author === "system");
  assert.match((reply as { event: { text: string } }).event.text, /Steering @gaia/);

  // Not queued: the durable queue stays empty.
  const state = (await readJson(workspacePaths.roomState(root, "default"))) as { queue?: unknown[] };
  assert.equal(state.queue, undefined);

  release();
  await service.waitForIdle();

  // The guidance is recorded in the transcript as a user event.
  const { events: transcript } = await service.room.eventsFrom(0);
  const steerEvent = transcript.find((event) => event.text === "focus only on the tests");
  assert.ok(steerEvent, "steer text recorded for history");
  assert.equal(steerEvent?.author, "user");
});

test("/steer declines gracefully when idle or unsupported", async () => {
  const { service } = await makeService();
  const idle = await service.sendMessage("/steer do it differently");
  assert.equal(idle.status, "complete");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const factory = (agent: AgentDef): AgentRuntime => ({
    agent,
    modelLabel: "test/model",
    // claude-like: no steering.
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: true, supportsMcp: true, supportsSteer: false },
    async *send() {
      await gate;
      yield { type: "text-delta", delta: "done" } as AgentEvent;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
  });
  const second = await makeService({ runtimeFactory: factory });
  await second.service.sendMessage("long task");
  const declined = await second.service.sendMessage("/steer nope");
  assert.equal(declined.status, "complete");
  const reply = second.events.filter((event) => event.type === "room-event" && event.event.author === "system").pop();
  assert.match((reply as { event: { text: string } }).event.text, /does not support mid-turn steering/);
  release();
  await second.service.waitForIdle();
});

test("/cancel stops the running turn and drops queued messages without queueing itself", async () => {
  let started!: () => void;
  const firstSend = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const factory = (agent: AgentDef): AgentRuntime => {
    const runtime = {
      agent,
      modelLabel: "test/model",
      capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsMcp: false, supportsSteer: false },
      aborted: false,
      async *send() {
        started();
        await gate;
        yield { type: "text-delta", delta: "never finished" } as AgentEvent;
      },
      async abort() {
        runtime.aborted = true;
      },
      dispose() {},
      resetRoom() {},
    };
    return runtime as unknown as AgentRuntime;
  };
  const { service, root, events, runtimes } = await makeService({ runtimeFactory: factory });

  // Idle: /cancel is a no-op, and it never queues.
  const idle = await service.sendMessage("/cancel");
  assert.equal(idle.status, "complete");
  const idleReply = events.filter((event) => event.type === "room-event" && event.event.author === "system").pop();
  assert.match((idleReply as { event: { text: string } }).event.text, /Nothing is running/);

  await service.sendMessage("start a long task");
  await firstSend;
  const queued = await service.sendMessage("this waits in the queue");
  const cancelTask = await service.sendMessage("/stop"); // alias for /cancel
  assert.equal(cancelTask.status, "complete", "cancel settles while the turn is active");
  const reply = events.filter((event) => event.type === "room-event" && event.event.author === "system").pop();
  assert.match((reply as { event: { text: string } }).event.text, /Cancelled the running turn/);
  assert.match((reply as { event: { text: string } }).event.text, /dropped 1 queued message/);

  assert.equal((runtimes.get("gaia") as unknown as { aborted: boolean }).aborted, true, "runtime abort requested");
  assert.equal(queued.status, "cancelled");
  const state = (await readJson(workspacePaths.roomState(root, "default"))) as { queue?: unknown[] };
  assert.ok(!state.queue || state.queue.length === 0, "durable queue emptied");
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("/recall searches the target agent's memory and reports misses", async () => {
  const searches: Array<{ agentId: string; query: string }> = [];
  const memory: RoomMemoryHooks = {
    async autoRecallBlock() {
      return "";
    },
    async capture() {},
    async consolidate() {
      return { ran: false, episodesSeen: 0, factsAdded: 0, factsInvalidated: 0, memoryEdits: 0, opsSkipped: 0 };
    },
    async search(agentId, query) {
      searches.push({ agentId, query });
      if (query.includes("nothing")) return { hits: [], degraded: [] };
      return { hits: [{ kind: "fact" as const, text: "GAIA commits turns through a WAL", ts: "2026-07-01T00:00:00.000Z", score: 0.9 }], degraded: [] };
    },
  };
  const { service, events } = await makeService({ memory });

  const usage = await service.sendMessage("/recall");
  assert.equal(usage.status, "complete");
  const usageReply = events.filter((event) => event.type === "room-event" && event.event.author === "system").pop();
  assert.match((usageReply as { event: { text: string } }).event.text, /Usage: \/recall/);

  await service.sendMessage("/recall @terry turn durability");
  assert.deepEqual(searches, [{ agentId: "terry", query: "turn durability" }]);
  const hitReply = events.filter((event) => event.type === "room-event" && event.event.author === "system").pop();
  assert.match((hitReply as { event: { text: string } }).event.text, /Recall @terry/);
  assert.match((hitReply as { event: { text: string } }).event.text, /WAL/);

  await service.sendMessage("/recall nothing here");
  const missReply = events.filter((event) => event.type === "room-event" && event.event.author === "system").pop();
  assert.match((missReply as { event: { text: string } }).event.text, /No matches/);
  // Default agent used when no @mention.
  assert.equal(searches[1].agentId, "gaia");
});

test("/rewind truncates after the n-th-last user message and resets cursors + sessions", async () => {
  const resets: string[] = [];
  const factory = (agent: AgentDef): AgentRuntime => ({
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsMcp: false, supportsSteer: false },
    async *send() {
      yield { type: "text-delta", delta: `reply from ${agent.id}` } as AgentEvent;
    },
    async abort() {},
    dispose() {},
    resetRoom(roomId: string) {
      resets.push(`${agent.id}:${roomId}`);
    },
  });
  const { service, root } = await makeService({ runtimeFactory: factory });

  await service.sendMessage("first question");
  await service.waitForIdle();
  await service.sendMessage("second question");
  await service.waitForIdle();

  const before = await service.room.eventsFrom(0);
  assert.equal(before.events.length, 4, "two exchanges committed");

  const task = await service.sendMessage("/rewind");
  assert.equal(task.status, "complete");

  const after = await service.room.eventsFrom(0);
  assert.equal(after.events.length, 2, "second exchange dropped");
  assert.equal(after.events[0].text, "first question");
  assert.match(after.events[1].text, /reply from gaia/);

  const state = (await readJson(workspacePaths.roomState(root, "default"))) as { agentCursors: Record<string, number> };
  assert.deepEqual(state.agentCursors, { gaia: 0, terry: 0 }, "cursors capped to the kept window so the next turn replays it");
  assert.ok(resets.includes("gaia:default"), "harness sessions reset");

  // Rewinding past the beginning answers politely instead of corrupting.
  await service.sendMessage("/rewind 5");
  const untouched = await service.room.eventsFrom(0);
  assert.equal(untouched.events.length, 2);
});

test("postTurn hooks fire with the committed reply (uniform, room-layer)", async () => {
  const { service, workspace, root } = await makeService();
  const out = join(root, "hook-out.json");
  workspace.config.hooks = { postTurn: [{ command: `cat > ${out}` }] };

  await service.sendMessage("trigger the hook");
  await service.waitForIdle();

  // Fire-and-forget: poll briefly for the hook's write.
  let body: { event?: string; agentId?: string; reply?: string; outcome?: string } | undefined;
  for (let i = 0; i < 100 && !body; i++) {
    try {
      body = JSON.parse(await readFileText(out));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.equal(body?.event, "postTurn");
  assert.equal(body?.agentId, "gaia");
  assert.equal(body?.reply, "hello from agent");
  assert.equal(body?.outcome, "complete");
});

test("retryMessage forks at the originating user message and regenerates the reply", async () => {
  let n = 0;
  const { service, root, runtimes } = await makeService({
    script: () => [{ type: "text-delta", delta: `reply ${++n}` } as AgentEvent],
  });
  await service.sendMessage("first question");
  await service.waitForIdle();
  await service.sendMessage("second question");
  await service.waitForIdle();

  const before = (await service.room.eventsFrom(0)).events;
  assert.equal(before.length, 4);
  const secondReply = before[3];
  assert.equal(before[3].text, "reply 2");

  // Retry targets the AGENT reply; the fork lands on the user message above it.
  await service.retryMessage(secondReply.id);
  await service.waitForIdle();

  const after = (await service.room.eventsFrom(0)).events;
  assert.equal(after.length, 4, "same shape: question re-sent, reply regenerated");
  assert.equal(after[2].text, "second question");
  assert.notEqual(after[2].id, before[2].id, "the re-sent user message is a new event");
  assert.equal(after[3].text, "reply 3");
  assert.equal(runtimes.get("gaia")?.sends, 3);

  // No progress ever lost: the dropped exchange is preserved beside the transcript.
  const rewound = (await readFileText(join(root, ".gaia", "rooms", "default", "rewound.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { text: string });
  assert.deepEqual(rewound.map((event) => event.text), ["second question", "reply 2"]);
});

test("editMessage forks at the edited user message and re-sends the new text with kept routing", async () => {
  const { service } = await makeService({ agents: ["gaia", "terry"] });
  await service.sendMessage("@terry original question");
  await service.waitForIdle();

  const before = (await service.room.eventsFrom(0)).events;
  assert.equal(before.length, 2);
  assert.equal(before[1].author, "terry");

  // No mention in the edited text -> the original @terry routing is kept.
  await service.editMessage(before[0].id, "edited question");
  await service.waitForIdle();

  const after = (await service.room.eventsFrom(0)).events;
  assert.equal(after.length, 2);
  assert.equal(after[0].text, "edited question");
  assert.equal(after[1].author, "terry");

  // Unknown event ids refuse cleanly.
  await assert.rejects(() => service.editMessage("evt_nope", "x"), /not found/i);
});

test("attachments: stored on the user event, handed to the runtime, kept across retry", async () => {
  const inputs: Array<{ attachments?: unknown }> = [];
  const { service, root } = await makeService({
    runtimeFactory: (agent) => {
      const runtime = {
        agent,
        modelLabel: "test/model",
        capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsMcp: false, supportsSteer: false },
        async *send(input: { attachments?: unknown }) {
          inputs.push(input);
          yield { type: "text-delta", delta: "seen" } as AgentEvent;
        },
        async abort() {},
        dispose() {},
        resetRoom() {},
      };
      return runtime as unknown as AgentRuntime;
    },
  });

  // Store bytes the way the upload route does, then re-resolve the ref the
  // way the messages route does — only the server-issued id is trusted.
  const stored = await service.storeAttachment("shot.png", Buffer.from("png-bytes"), "image/png");
  const resolved = await service.resolveAttachments([{ id: stored.id, name: stored.name, mime: stored.mime }]);
  assert.deepEqual(resolved, [{ name: "shot.png", mime: "image/png", size: 9, path: stored.path }]);
  assert.ok(stored.path.startsWith(join(root, ".gaia", "rooms", "default", "files")));

  await service.sendMessage("look at this", { attachments: resolved });
  await service.waitForIdle();

  // The runtime received them on AgentInput…
  assert.deepEqual(inputs[0]?.attachments, resolved);
  // …and the user event carries them durably (fresh handle = disk parse).
  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  assert.deepEqual((transcript[0] as { attachments?: unknown }).attachments, resolved);

  // Retry forks at the user message and re-sends WITH the attachments.
  await service.retryMessage(transcript[1].id);
  await service.waitForIdle();
  assert.deepEqual(inputs[1]?.attachments, resolved);

  // Unknown ids fail loudly instead of sending a dangling reference.
  await assert.rejects(() => service.resolveAttachments([{ id: "nope.png" }]), /Unknown attachment/);
});

test("/model rewrites agent.json AND fires the settings reload that reaches live runners", async () => {
  const reloads: string[] = [];
  const { service, workspace, root } = await makeService({
    settingsChanged: async (scope) => {
      reloads.push(scope);
    },
  });
  await service.init();

  const reply = await service.runModelCommand(undefined, "opus");
  assert.match(reply, /Set @gaia model to anthropic\/opus/);
  assert.match(reply, /next turn/);

  // Persisted to agent.json (a bare name keeps/derives the provider)…
  const config = (await readJson(join(root, "agents", "gaia", "agent.json"))) as { model?: { provider?: string; name?: string } };
  assert.deepEqual(config.model, { provider: "anthropic", name: "opus" });
  // …mirrored in-process for the snapshot chip…
  assert.deepEqual(workspace.agents.gaia.model, { provider: "anthropic", name: "opus" });
  // …and the daemon reload fired: runners snapshot agent.json at spawn, so
  // ONLY a service rebuild makes the next turn actually run the new model.
  assert.deepEqual(reloads, ["global"]);

  // Clearing the override goes through the same reload.
  const cleared = await service.runModelCommand(undefined, "none");
  assert.match(cleared, /Cleared @gaia model override/);
  const after = (await readJson(join(root, "agents", "gaia", "agent.json"))) as { model?: unknown };
  assert.equal(after.model, undefined);
  assert.deepEqual(reloads, ["global", "global"]);
});

test("/thinking fires the same settings reload (it rewrites agent.json too)", async () => {
  const reloads: string[] = [];
  const { service } = await makeService({
    settingsChanged: async (scope) => {
      reloads.push(scope);
    },
  });
  await service.init();
  const reply = await service.setAgentThinking("gaia", "high");
  assert.match(reply, /Set @gaia thinking to high/);
  assert.deepEqual(reloads, ["global"]);
});

// --- thanks-dario context sanitize ------------------------------------------

function fakeSummonHost(reply: (agentId: string, task: string) => string): SummonHost & { calls: { agentId: string; task: string }[] } {
  const host = {
    calls: [] as { agentId: string; task: string }[],
    async summon() {
      return "child-room";
    },
    async summonAndWait(_parent: string, agentId: string, task: string) {
      host.calls.push({ agentId, task });
      return reply(agentId, task);
    },
    runningChildren() {
      return [];
    },
  };
  return host;
}

test("/thanks-dario on|off persists the room flag and surfaces it on the snapshot", async () => {
  const { service } = await makeService();
  await service.init();
  const on = await service.runThanksDarioCommand("on");
  assert.match(on, /Thanks-Dario mode ON/);
  assert.equal((await service.getSnapshot()).room.thanksDario, true);
  const off = await service.runThanksDarioCommand("off");
  assert.match(off, /OFF/);
  assert.equal((await service.getSnapshot()).room.thanksDario, undefined);
});

test("sanitize preview runs the reviewer through the summon host; apply rewrites, preserves, resets", async () => {
  // The fake reviewer reads the event id out of the prompt it was given —
  // proving the prompt labels events the way apply expects them back.
  const host = fakeSummonHost((_agentId, task) => {
    const eventId = task.match(/\[event (evt_[^\]]+)\]/)?.[1] ?? "missing";
    return JSON.stringify({
      summary: "The tooling shorthand is the likely trigger.",
      options: [{ id: "light", label: "Light touch", description: "", suggestionIds: ["s1"] }],
      suggestions: [
        { id: "s1", eventId, quote: "IDA Pro", replacement: "the disassembler", reason: "tooling term" },
        { id: "s2", eventId, quote: "NOT PRESENT", replacement: "x", reason: "hallucinated" },
      ],
    });
  });
  const { service, root, runtimes } = await makeService({ agents: ["gaia", "terry", "dario"], summonHost: host });
  await service.sendMessage("please discuss IDA Pro internals");
  await service.waitForIdle();

  const proposal = await service.sanitizePreview();
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].agentId, "dario");
  assert.equal(proposal.parseError, undefined);
  assert.deepEqual(proposal.suggestions.map((suggestion) => suggestion.id), ["s1"]);
  assert.equal(proposal.discarded, 1); // the hallucinated quote never survives parsing
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.room.sanitize?.at, proposal.at);
  assert.equal(snapshot.room.sanitize?.suggestions, 1);
  const saved = (await readJson(join(root, ".gaia", "rooms", "default", "sanitize.json"))) as SanitizeProposal;
  assert.equal(saved.at, proposal.at);

  // Apply the approved edit.
  const target = proposal.suggestions[0];
  const result = await service.sanitizeApply([{ eventId: target.eventId, quote: target.quote, replacement: target.replacement }]);
  assert.deepEqual(result, { applied: 1, skipped: 0 });

  const room = await RoomHandle.open(root, "default");
  const { events } = await room.eventsFrom(0);
  const edited = events.find((event) => event.id === target.eventId);
  assert.equal(edited?.text, "please discuss the disassembler internals");
  assert.equal(edited?.redacted, true);
  // Original preserved beside the transcript.
  const preserved = (await readFileText(join(root, ".gaia", "rooms", "default", "redactions.jsonl"), "utf8")).trim();
  assert.match(preserved, /please discuss IDA Pro internals/);
  // Every runtime got a fresh session and cursors were capped to the window.
  for (const runtime of runtimes.values()) assert.ok(runtime.resets >= 1);
  const state = await room.state();
  assert.equal(state.agentCursors.gaia, 0);
  // The saved proposal is stamped applied (popup shows the ✂ state).
  assert.ok((await service.getSanitizeProposal())?.appliedAt);

  // Stale quotes never rewrite anything.
  await assert.rejects(
    service.sanitizeApply([{ eventId: target.eventId, quote: "IDA Pro", replacement: "x" }]),
    /None of the selected edits matched/,
  );
});

test("sanitize preview without a summon host or reviewer persona fails with a clear error", async () => {
  const { service: noHost } = await makeService();
  await noHost.sendMessage("hello");
  await noHost.waitForIdle();
  await assert.rejects(noHost.sanitizePreview(), /Summons are not available/);

  const { service: noDario } = await makeService({ summonHost: fakeSummonHost(() => "{}") });
  await noDario.sendMessage("hello");
  await noDario.waitForIdle();
  await assert.rejects(noDario.sanitizePreview(), /No "dario" persona/);
});

test("snapshot carries eventTotal beyond the tail window; eventsBefore pages backwards", async () => {
  const { service, root } = await makeService();
  await service.init();
  const lines = Array.from({ length: 25 }, (_, i) =>
    JSON.stringify({ id: `evt_${i}`, timestamp: "2026-01-01T00:00:00Z", author: i % 2 ? "gaia" : "user", targets: [], text: `m${i}` }),
  );
  await writeFile(join(root, ".gaia", "rooms", "default", "transcript.jsonl"), lines.join("\n") + "\n", "utf8");

  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.room.eventTotal, 25);
  assert.equal(snapshot.room.events.length, 20); // transcriptWindow
  assert.equal(snapshot.room.events[0]?.id, "evt_5");

  const page = await service.eventsBefore("evt_5", 4);
  assert.deepEqual(page.events.map((event) => event.id), ["evt_1", "evt_2", "evt_3", "evt_4"]);
  assert.equal(page.hasMore, true);

  const first = await service.eventsBefore("evt_1", 4);
  assert.deepEqual(first.events.map((event) => event.id), ["evt_0"]);
  assert.equal(first.hasMore, false);

  // Unknown/absent anchor pages from the tail.
  const tail = await service.eventsBefore(undefined, 3);
  assert.deepEqual(tail.events.map((event) => event.id), ["evt_22", "evt_23", "evt_24"]);
  assert.equal(tail.hasMore, true);
});

test("listRooms surfaces imported-chat metadata (title + import date)", async () => {
  const { service, root } = await makeService();
  await service.init();
  const dir = join(root, ".gaia", "rooms", "claude-20260421-first-chat");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "transcript.jsonl"), "", "utf8");
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify({ activeRoles: {}, agentCursors: {}, title: "Your first chat with Claude", imported: "2026-04-21T22:50:19Z" }),
    "utf8",
  );
  const rooms = await service.listRooms();
  const imported = rooms.find((room) => room.id === "claude-20260421-first-chat");
  assert.equal(imported?.title, "Your first chat with Claude");
  assert.equal(imported?.imported, "2026-04-21T22:50:19Z");
  const current = rooms.find((room) => room.id === "default");
  assert.equal(current?.title, undefined);
  assert.equal(current?.imported, undefined);
});

// --- context gate ------------------------------------------------------------

/** Records every AgentInput it receives, so a test can assert exactly how much
 * context a resolved gate handed the agent. `sessionAlive` (optional) backs
 * hasDurableSession — flip it to simulate a lost harness session; omitted ⇒
 * the method is absent, exercising the fail-safe "assume alive" default. */
function capturingRuntime(agent: AgentDef, sink: AgentInput[], sessionAlive?: () => boolean): AgentRuntime & { sends: number } {
  const runtime = {
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    sends: 0,
    async *send(input: AgentInput) {
      runtime.sends += 1;
      sink.push(input);
      yield { type: "text-delta", delta: `${agent.id} ok` } as AgentEvent;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
    ...(sessionAlive ? { hasDurableSession: () => sessionAlive() } : {}),
  };
  return runtime as unknown as AgentRuntime & { sends: number };
}

// A word-padded line so a few messages clearly clear the threshold, while a
// single short opener ("hi") stays well under it.
const PAD = "padded with lots of extra words to grow the transcript well past the configured threshold";

test("context gate: a new agent joining a big room is held until the human chooses (last-N replays a tail)", async () => {
  const captured = new Map<string, AgentInput[]>();
  const { service, runtimes } = await makeService({
    agents: ["gaia", "nyari"],
    config: { contextGate: { warnAboveTokens: 60 } },
    runtimeFactory: (agent) => {
      const sink: AgentInput[] = [];
      captured.set(agent.id, sink);
      return capturingRuntime(agent, sink);
    },
  });

  // gaia opens with a short line (under threshold → runs, no longer "new"),
  // then piles on — as an existing agent it's never gated, so the room grows.
  await service.sendMessage("@gaia hi");
  await service.waitForIdle();
  for (let i = 0; i < 4; i++) {
    await service.sendMessage(`@gaia message ${i} ${PAD}`);
    await service.waitForIdle();
  }
  assert.equal(runtimes.get("gaia")!.sends, 5, "gaia ran every time — the first agent is never gated on a small opener");

  // Address the NEW agent → held, not run; the gate is on the snapshot.
  await service.sendMessage("@nyari please catch up");
  await service.waitForIdle();
  assert.equal(runtimes.get("nyari")!.sends, 0, "new agent held, not run");
  const gate = (await service.getSnapshot()).room.contextGate;
  assert.equal(gate?.agentId, "nyari");
  assert.equal(gate?.reason, "new-agent");
  assert.ok((gate?.estTokens ?? 0) > 60, "estimate exceeded the threshold");
  assert.equal(gate?.totalEvents, 11); // 2 (hi round) + 8 (4 rounds) + 1 nyari message

  // Resolve: load only the last 2 messages.
  await service.resolveContextGate("last", 2);
  await service.waitForIdle();
  assert.equal(runtimes.get("nyari")!.sends, 1, "nyari ran after the choice");
  assert.equal((await service.getSnapshot()).room.contextGate, undefined, "gate cleared");
  assert.equal(captured.get("nyari")!.at(-1)!.transcript.length, 2, "loaded only the last 2 events");
  // gaia's own turns are untouched — the gate never re-ran it.
  assert.equal(runtimes.get("gaia")!.sends, 5);
});

test("context gate: compact summarizes the room once and seeds ONLY the new agent (empty transcript + summary recall)", async () => {
  const captured = new Map<string, AgentInput[]>();
  const llmSeen: string[] = [];
  const { service, runtimes } = await makeService({
    agents: ["gaia", "nyari"],
    config: { contextGate: { warnAboveTokens: 60 } },
    llm: async ({ user }) => {
      llmSeen.push(user);
      return "ROOM BRIEF: they discussed the plan.";
    },
    runtimeFactory: (agent) => {
      const sink: AgentInput[] = [];
      captured.set(agent.id, sink);
      return capturingRuntime(agent, sink);
    },
  });

  await service.sendMessage("@gaia hi");
  await service.waitForIdle();
  await service.sendMessage(`@gaia now the real discussion ${PAD} ${PAD}`);
  await service.waitForIdle();
  await service.sendMessage("@nyari hop in");
  await service.waitForIdle();
  assert.equal(runtimes.get("nyari")!.sends, 0, "new agent held");

  await service.resolveContextGate("compact");
  await service.waitForIdle();

  assert.equal(llmSeen.length, 1, "summarized the room exactly once");
  const turn = captured.get("nyari")!.at(-1)!;
  assert.equal(turn.transcript.length, 0, "no raw transcript — the summary IS the context");
  assert.match(turn.recall ?? "", /ROOM BRIEF/, "summary injected via the one-shot recall overlay");
  assert.equal((await service.getSnapshot()).room.contextGate, undefined, "gate cleared");
  // Only nyari was seeded; gaia was never re-run by the compaction.
  assert.equal(runtimes.get("gaia")!.sends, 2);
});

// --- session loss --------------------------------------------------------------

test("a lost harness session replays the full transcript instead of silently starting mid-conversation", async () => {
  const captured: AgentInput[] = [];
  let alive = true;
  const { service } = await makeService({
    agents: ["gaia"],
    runtimeFactory: (agent) => capturingRuntime(agent, captured, () => alive),
  });

  // Two normal rounds: turn 2 sees ONLY events since its cursor (the tail).
  await service.sendMessage("@gaia hello");
  await service.waitForIdle();
  await service.sendMessage("@gaia and again");
  await service.waitForIdle();
  assert.equal(captured.at(-1)!.transcript.length, 1, "existing agent loads only the new user message");

  // The session behind the cursor vanishes (crash / dropped handle / pruned
  // store). The cursor is now a lie — the turn must replay from the start.
  alive = false;
  await service.sendMessage("@gaia what do you remember?");
  await service.waitForIdle();
  assert.equal((await service.getSnapshot()).room.contextGate, undefined, "small room heals silently — no gate");
  // 5 events: 2 user + 2 replies from the earlier rounds, + this user message.
  assert.equal(captured.at(-1)!.transcript.length, 5, "full history replayed into the fresh session");

  // The healed turn re-established a session; the next one is tail-only again.
  alive = true;
  await service.sendMessage("@gaia carry on");
  await service.waitForIdle();
  assert.equal(captured.at(-1)!.transcript.length, 1, "cursor semantics restored after the heal");
});

test("a lost session in a BIG room is held by the context gate (reason: session-lost) and full-reload replays everything", async () => {
  const captured: AgentInput[] = [];
  let alive = true;
  const { service, runtimes } = await makeService({
    agents: ["gaia"],
    config: { contextGate: { warnAboveTokens: 60 } },
    runtimeFactory: (agent) => capturingRuntime(agent, captured, () => alive),
  });

  // Grow the room past the threshold — an existing agent with a LIVE session
  // is never gated, however big the room gets.
  await service.sendMessage("@gaia hi");
  await service.waitForIdle();
  for (let i = 0; i < 4; i++) {
    await service.sendMessage(`@gaia message ${i} ${PAD}`);
    await service.waitForIdle();
  }
  assert.equal(runtimes.get("gaia")!.sends, 5, "live session ⇒ never gated");

  // Session gone + big replay ⇒ held for the human's choice, like a first load.
  alive = false;
  await service.sendMessage("@gaia what happened so far?");
  await service.waitForIdle();
  assert.equal(runtimes.get("gaia")!.sends, 5, "held, not run");
  const gate = (await service.getSnapshot()).room.contextGate;
  assert.equal(gate?.agentId, "gaia");
  assert.equal(gate?.reason, "session-lost");
  assert.equal(gate?.totalEvents, 11); // 10 from the 5 rounds + the held user message

  await service.resolveContextGate("full");
  await service.waitForIdle();
  assert.equal(runtimes.get("gaia")!.sends, 6, "ran after the choice");
  assert.equal(captured.at(-1)!.transcript.length, 11, "full reload from event 0");
  assert.equal((await service.getSnapshot()).room.contextGate, undefined, "gate cleared");
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `cond` holds — used to let an agent-dialogue chain drain, since
 * waitForIdle only unblocks on the FIRST task to settle, not the hand-offs. */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error("waitFor: timed out");
}

test("a bare message follows the room's active agent, not the workspace default", async () => {
  const { service, root } = await makeService(); // gaia (default) + terry
  await service.sendMessage("@terry hi there");
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "default");
  assert.equal((await room.state()).activeAgent, "terry", "addressing terry makes it this room's active agent");
  assert.equal((await service.getSnapshot()).room.activeAgent, "terry");

  // No @mention → routes to the active agent (terry), NOT the workspace default (gaia).
  const task = await service.sendMessage("you still there?");
  await service.waitForIdle();
  assert.equal(task.targets[0], "terry");
  assert.deepEqual(
    (await room.eventsFrom(0)).events.map((event) => event.author),
    ["user", "terry", "user", "terry"],
  );
});

test("agent-dialogue hands off to an @mentioned agent only when the room toggle is on", async () => {
  const { service, root, runtimes } = await makeService({
    runtimeFactory: (agent) =>
      scriptedRuntime(agent, () =>
        agent.id === "gaia"
          ? [{ type: "text-delta", delta: "good question — @terry, your call" } as AgentEvent]
          : [{ type: "text-delta", delta: "on it" } as AgentEvent],
      ),
  });
  const room = await RoomHandle.open(root, "default");

  // OFF (default): gaia's @terry is inert prose — no hand-off.
  await service.sendMessage("@gaia kick off");
  await service.waitForIdle();
  assert.deepEqual((await room.eventsFrom(0)).events.map((event) => event.author), ["user", "gaia"]);
  assert.equal(runtimes.get("terry")!.sends, 0, "no hand-off while the toggle is off");

  // ON: gaia's @terry triggers terry to respond (gaia's reply is already in the
  // transcript, so terry replays it as the newest message without re-recording).
  await service.setAgentDialogue(true);
  await service.sendMessage("@gaia kick off again");
  // Wait for terry's reply to actually COMMIT (sends++ fires at send() start, before commit).
  await waitFor(async () => (await room.eventsFrom(0)).events.some((event) => event.author === "terry"));
  assert.equal(runtimes.get("terry")!.sends, 1);
  const authors = (await room.eventsFrom(0)).events.map((event) => event.author);
  assert.equal(authors.filter((a) => a === "terry").length, 1, "terry answered exactly once");
  // Read the authoritative service snapshot (a fresh RoomHandle would cache a
  // mid-chain state from the eventsFrom polling above).
  assert.equal((await service.getSnapshot()).room.activeAgent, "terry", "the hand-off target becomes active");
});

test("agent-dialogue mutual @mentions terminate at the hop cap, and a human resets it", async () => {
  const { service, runtimes } = await makeService({
    runtimeFactory: (agent) =>
      scriptedRuntime(agent, () =>
        agent.id === "gaia"
          ? [{ type: "text-delta", delta: "ping @terry" } as AgentEvent]
          : [{ type: "text-delta", delta: "pong @gaia" } as AgentEvent],
      ),
  });
  await service.setAgentDialogue(true);

  const totalSends = () => runtimes.get("gaia")!.sends + runtimes.get("terry")!.sends;
  await service.sendMessage("@gaia start the loop");
  // 1 human-driven turn + AGENT_DIALOGUE_MAX_HOPS hand-offs, then the guard pauses it.
  await waitFor(() => totalSends() >= 1 + AGENT_DIALOGUE_MAX_HOPS);
  await sleep(150); // it must STOP, not keep looping
  assert.equal(totalSends(), 1 + AGENT_DIALOGUE_MAX_HOPS, "the loop ran to the cap then halted");

  // A human message ends the chain and re-arms the hop budget.
  await service.sendMessage("@gaia go again");
  await waitFor(() => totalSends() >= 2 * (1 + AGENT_DIALOGUE_MAX_HOPS));
  await sleep(150);
  assert.equal(totalSends(), 2 * (1 + AGENT_DIALOGUE_MAX_HOPS), "the human reset re-armed the dialogue");
});
