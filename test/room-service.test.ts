import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile as readFileText } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_DIALOGUE_MAX_HOPS, RoomService, type RoomMemoryHooks } from "../src/services/room-service.js";
import { RoomHandle } from "../src/domain/rooms.js";
import { MemoryStore } from "../src/domain/memory.js";
import { DEFAULTS } from "../src/core/config.js";
import { readJson } from "../src/core/store.js";
import { workspacePaths } from "../src/core/paths.js";
import type { AgentDef, AgentEvent, QueuedMessage, SanitizeProposal, Snapshot, UiEvent, Workspace, WorkspaceConfig } from "../src/core/types.js";
import { RunnerHost } from "../src/harness/host.js";
import { registerHarness, type AgentInput, type AgentRuntime } from "../src/harness/spec.js";
import type { SummonHost } from "../src/services/summons.js";
import type { ConsolidateLlm } from "../src/services/consolidate.js";

process.env.GAIA_HOME = await mkdtemp(join(tmpdir(), "gaia-home-"));

registerHarness({
  id: "durability-protocol-stub",
  capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
  ui: { label: "Durability stub", description: "room-service protocol integration test double" },
  create: () => {
    throw new Error("not used: RunnerHost launches the protocol stub directly");
  },
});

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
function scriptedRuntime(agent: AgentDef, script: () => AgentEvent[]): AgentRuntime & { aborted: boolean; sends: number; resets: number; refreshes: number } {
  const runtime = {
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    aborted: false,
    sends: 0,
    resets: 0,
    refreshes: 0,
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
    refreshContext() {
      runtime.refreshes += 1;
    },
  };
  return runtime as AgentRuntime & { aborted: boolean; sends: number; resets: number; refreshes: number };
}

async function makeService(options: {
  script?: () => AgentEvent[];
  agents?: string[];
  runtimeFactory?: (agent: AgentDef, workspace: Workspace) => AgentRuntime;
  memory?: RoomMemoryHooks;
  settingsChanged?: (scope: "global" | "workspace") => Promise<void>;
  summonHost?: SummonHost;
  config?: Partial<WorkspaceConfig>;
  llm?: ConsolidateLlm;
  /** Room id to open (default "default"). */
  roomId?: string;
  /** Seed the room's state.json as incognito before RoomService.open reads it. */
  incognito?: boolean;
  /** Tool ids granted to every test agent (default none). */
  tools?: string[];
  /** Durable queue entries to seed before RoomService.open() runs boot drain. */
  queued?: QueuedMessage[];
} = {}): Promise<{ service: RoomService; workspace: Workspace; root: string; events: UiEvent[]; runtimes: Map<string, ReturnType<typeof scriptedRuntime>> }> {
  const root = await mkdtemp(join(tmpdir(), "gaia-svc-"));
  const roomId = options.roomId ?? "default";
  await mkdir(join(root, ".gaia", "rooms", roomId), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), "{}", "utf8");
  if (options.incognito) {
    await writeFile(workspacePaths.roomState(root, roomId), JSON.stringify({ activeRoles: {}, agentCursors: {}, incognito: true }), "utf8");
  }

  const agentIds = options.agents ?? ["gaia", "terry"];
  const agents = Object.fromEntries(agentIds.map((id) => [id, { ...makeAgent(id, root), ...(options.tools ? { tools: options.tools } : {}) }]));
  const workspace: Workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "agents"),
    config: { defaultAgent: "gaia", room: roomId, transcriptWindow: 20, ...options.config },
    contextFiles: [],
    agents,
  };

  if (options.queued?.length) {
    const room = await RoomHandle.open(root, roomId);
    for (const entry of options.queued) await room.enqueue(entry);
  }

  const script = options.script ?? (() => [{ type: "text-delta", delta: "hello from agent" } as AgentEvent]);
  const runtimes = new Map<string, ReturnType<typeof scriptedRuntime>>();
  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    roomId,
    memoryStore: new MemoryStore(),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.settingsChanged ? { settingsChanged: options.settingsChanged } : {}),
    ...(options.summonHost ? { summonHost: options.summonHost } : {}),
    ...(options.llm ? { llm: options.llm } : {}),
    runtimeFactory: (agent) => {
      const runtime = options.runtimeFactory ? (options.runtimeFactory(agent, workspace) as ReturnType<typeof scriptedRuntime>) : scriptedRuntime(agent, script);
      runtimes.set(agent.id, runtime);
      return runtime;
    },
  });
  const events: UiEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { service, workspace, root, events, runtimes };
}

/** Real RunnerHost child used by the durability regressions below. It speaks
 * the runner protocol but deliberately omits turn-end for the failure cases. */
async function makeDurabilityRunner(markerPath?: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gaia-durability-runner-"));
  const path = join(dir, "runner.mjs");
  const source = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const marker = ${JSON.stringify(markerPath)};
const send = (message, callback) => process.stdout.write(JSON.stringify(message) + "\\n", callback);
send({ type: "ready", modelLabel: "stub/durability" });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const command = JSON.parse(line);
  if (command.type === "turn") {
    if (command.input.message === "partial then die") {
      send({ type: "event", event: { type: "text-delta", delta: "answer survived" } }, () => process.exit(0));
      return;
    }
    if (command.input.message === "die empty") {
      process.exit(0);
      return;
    }
    if (command.input.message === "idle forever") return;
    send({ type: "event", event: { type: "text-delta", delta: "queued reply" } });
    send({ type: "turn-end" });
    return;
  }
  if (command.type === "abort") {
    if (marker) appendFileSync(marker, "abort\\n");
    send({ type: "turn-error", message: "runtime acknowledged abort" });
    return;
  }
  if (command.type === "dispose") process.exit(0);
});
`;
  await writeFile(path, source, "utf8");
  return { dir, path };
}

function durabilityHost(agent: AgentDef, workspace: Workspace, runnerPath: string, turnIdleTimeoutMs = 1_000): AgentRuntime {
  return new RunnerHost({
    workspace,
    agent,
    harness: "durability-protocol-stub",
    allowSummon: () => false,
    sandbox: () => ({ enabled: false, backend: "none" }),
    runnerArgv: [process.execPath, runnerPath],
    turnIdleTimeoutMs,
  });
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

test("background-task events persist, surface in snapshots, and cap at 20", async () => {
  const { service, root } = await makeService({
    script: () => [
      ...Array.from({ length: 22 }, (_, index): AgentEvent => ({
        type: "background-task",
        taskId: `bg-${index}`,
        toolName: "Shell",
        command: `work ${index}`,
        description: `background work ${index}`,
        outputPath: `/tmp/bg-${index}.out`,
      })),
      { type: "text-delta", delta: "started them" },
    ],
  });

  await service.sendMessage("start background work");
  await service.waitForIdle();

  const state = await readJson(workspacePaths.roomState(root, "default")) as { backgroundTasks?: Array<{ taskId: string; agentId: string }> };
  assert.equal(state.backgroundTasks?.length, 20);
  assert.deepEqual(state.backgroundTasks?.map((task) => task.taskId), Array.from({ length: 20 }, (_, index) => `bg-${index + 2}`));
  assert.ok(state.backgroundTasks?.every((task) => task.agentId === "gaia"));

  const snapshot = await service.getSnapshot();
  assert.deepEqual(snapshot.backgroundTasks.map((task) => task.taskId), state.backgroundTasks?.map((task) => task.taskId));
  assert.equal(snapshot.backgroundTasks[0]?.description, "background work 2");
});

test("recording a background task drops entries older than 24 hours", async () => {
  const { service } = await makeService({
    script: () => [
      { type: "background-task", taskId: "fresh", toolName: "Shell", outputPath: "/tmp/fresh.out" },
      { type: "text-delta", delta: "started" },
    ],
  });
  await service.room.updateState((state) => {
    state.backgroundTasks = [
      {
        taskId: "stale",
        toolName: "Shell",
        startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        agentId: "gaia",
      },
    ];
  });

  await service.sendMessage("start another");
  await service.waitForIdle();
  assert.deepEqual((await service.getSnapshot()).backgroundTasks.map((task) => task.taskId), ["fresh"]);
});

test("snapshot usage scope contains only accounts of agents active in this room", async () => {
  const { service, workspace } = await makeService({ agents: ["gaia", "terry", "elsewhere"] });
  workspace.agents.gaia.account = "claude-current";
  workspace.agents.terry.account = "openai-current";
  workspace.agents.elsewhere.account = "old-account";

  await service.sendMessage("@gaia first");
  await service.waitForIdle();
  await service.sendMessage("@terry second");
  await service.waitForIdle();

  const snapshot = await service.getSnapshot();
  assert.deepEqual(new Set(snapshot.room.usageAccounts), new Set(["claude-current", "openai-current"]));
  assert.equal(snapshot.room.usageAccounts?.includes("old-account"), false);
});

test("auto-created rooms get a fallback title and manual rename locks it", async () => {
  const { service, root } = await makeService({ roomId: "chat-test123" });
  await service.sendMessage("@gaia fix room naming and renames");
  await service.waitForIdle();

  let state = await RoomHandle.open(root, "chat-test123").then((room) => room.state());
  assert.equal(state.title, "fix room naming and renames");
  assert.equal(state.titleSource, "auto");

  await service.setTitle('"Readable room titles."');
  state = await RoomHandle.open(root, "chat-test123").then((room) => room.state());
  assert.equal(state.title, "Readable room titles");
  assert.equal(state.titleSource, "manual");
});

test("auto title refinement uses the cheap DeepSeek flash model", async () => {
  const calls: Parameters<ConsolidateLlm>[0][] = [];
  const { service, root } = await makeService({
    roomId: "chat-title-flash",
    llm: async (input) => {
      calls.push(input);
      return "Room Rename Controls";
    },
  });
  await service.sendMessage("no remove rename btn, double click is enough");
  await service.waitForIdle();

  let state = await RoomHandle.open(root, "chat-title-flash").then((room) => room.state());
  for (let i = 0; i < 20 && state.titleSource !== "model"; i += 1) {
    await sleep(10);
    state = await RoomHandle.open(root, "chat-title-flash").then((room) => room.state());
  }

  assert.equal(calls[0]?.model?.provider, DEFAULTS.roomTitleModel.provider);
  assert.equal(calls[0]?.model?.name, DEFAULTS.roomTitleModel.name);
  assert.equal(state.title, "Room Rename Controls");
  assert.equal(state.titleSource, "model");
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

test("@system is a reserved author, not an agent mention: routes as the room default instead of erroring", async () => {
  const { service } = await makeService();
  const task = await service.sendMessage("@system hello");
  await service.waitForIdle();
  assert.deepEqual(task.targets, ["gaia"]);
});

test("@user is a reserved author, not an agent mention: routes as the room default instead of erroring", async () => {
  const { service } = await makeService();
  const task = await service.sendMessage("@user hi");
  await service.waitForIdle();
  assert.deepEqual(task.targets, ["gaia"]);
});

test("@nosuchagent still errors Unknown agent — reserved-mention stripping doesn't touch real unknowns", async () => {
  const { service } = await makeService();
  await assert.rejects(() => service.sendMessage("@nosuchagent hi"), /Unknown agent/);
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

test("idle dispatch keeps durable custody across the append→pendingTurn gap and replays exactly once", async () => {
  const { service, root, runtimes } = await makeService({ agents: ["gaia"] });
  const originalMarkPendingTurn = service.room.markPendingTurn.bind(service.room);
  let markCalls = 0;
  let reachedGap!: () => void;
  let releaseFailure!: () => void;
  const atGap = new Promise<void>((resolve) => (reachedGap = resolve));
  const holdFailure = new Promise<void>((resolve) => (releaseFailure = resolve));

  service.room.markPendingTurn = async (...args: Parameters<RoomHandle["markPendingTurn"]>) => {
    markCalls += 1;
    if (markCalls === 1) {
      reachedGap();
      await holdFailure;
      throw new Error("injected failure after user append, before pendingTurn persistence");
    }
    await originalMarkPendingTurn(...args);
  };

  const task = await service.sendMessage("survive the custody gap");
  await atGap;

  const room = await RoomHandle.open(root, "default");
  const failedState = (await readJson(workspacePaths.roomState(root, "default"))) as { queue?: QueuedMessage[] };
  assert.equal(failedState.queue?.length, 1, "the idle message remains durably queued in the loss gap");
  assert.equal(failedState.queue?.[0].taskId, task.id);
  assert.ok(failedState.queue?.[0].eventId, "the queued entry reserved the appended user event id");
  const { events: beforeReplay } = await room.eventsFrom(0);
  assert.equal(beforeReplay.filter((event) => event.author === "user").length, 1, "the first append reached the transcript");
  assert.equal(beforeReplay.find((event) => event.author === "user")?.id, failedState.queue?.[0].eventId);

  releaseFailure();
  await waitFor(async () => {
    room.invalidate();
    const state = await room.state();
    return markCalls === 2 && runtimes.get("gaia")?.sends === 1 && state.queue === undefined && state.pendingTurn === undefined;
  });

  const { events: afterReplay } = await room.eventsFrom(0);
  assert.equal(afterReplay.filter((event) => event.author === "user" && event.text === "survive the custody gap").length, 1);
  assert.equal(afterReplay.filter((event) => event.author === "gaia").length, 1, "the drained turn ran exactly once");
});

test("a runtime that streams text then exits without turn-end commits the partial notice and drains the queued next message", async () => {
  const runner = await makeDurabilityRunner();
  const { service, root, events } = await makeService({
    agents: ["gaia"],
    runtimeFactory: (agent, workspace) => durabilityHost(agent, workspace, runner.path),
  });

  const first = await service.sendMessage("partial then die");
  const queued = await service.sendMessage("queued next");
  assert.equal(queued.status, "queued", "the second message is durably queued behind the dying turn");

  await waitFor(() => first.status === "error");
  await waitFor(() => queued.status === "complete");
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  const partial = transcript.find((event) => event.author === "gaia" && event.text.startsWith("answer survived"));
  assert.ok(partial, "the streamed answer commits instead of disappearing");
  assert.equal(
    partial.text,
    "answer survived\n\n⚠ turn ended without completion (agent runner exited (code 0).) — partial output preserved",
  );
  const streamed = events.find((event) => event.type === "text-delta") as { eventId?: string } | undefined;
  assert.equal(partial.id, streamed?.eventId, "the partial commits under the pre-stream reserved event id");
  assert.ok(transcript.some((event) => event.author === "gaia" && event.text === "queued reply"), "the queued next turn drained and completed");
  const state = await room.state();
  assert.equal(state.pendingTurn, undefined);
  assert.equal(state.queue, undefined);
  assert.equal((await service.getSnapshot()).agents.find((agent) => agent.id === "gaia")?.status, "idle", "activeTask cleared after settle/drain");
  await service.dispose();
});

test("a runtime that dies with zero output commits a loud durable failure", async () => {
  const runner = await makeDurabilityRunner();
  const { service, root } = await makeService({
    agents: ["gaia"],
    runtimeFactory: (agent, workspace) => durabilityHost(agent, workspace, runner.path),
  });

  const task = await service.sendMessage("die empty");
  await waitFor(() => task.status === "error");
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  assert.ok(
    transcript.some((event) => event.author === "system" && event.text.includes("turn died without output (agent runner exited (code 0).)")),
    "the failure survives reload in the transcript instead of existing only as task stderr",
  );
  assert.equal(transcript.some((event) => event.author === "gaia"), false, "a blank agent event is not fabricated");
  assert.equal((await room.state()).pendingTurn, undefined);
  await service.dispose();
});

test("the turn idle backstop aborts the runner and persists a no-output failure", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), "gaia-idle-abort-")), "abort.log");
  const runner = await makeDurabilityRunner(marker);
  const { service, root } = await makeService({
    agents: ["gaia"],
    runtimeFactory: (agent, workspace) => durabilityHost(agent, workspace, runner.path, 75),
  });

  const task = await service.sendMessage("idle forever");
  await waitFor(() => task.status === "error");
  await waitFor(async () => (await readFileText(marker, "utf8").catch(() => "")).includes("abort"));
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  assert.ok(
    transcript.some(
      (event) => event.author === "system" && event.text.includes("turn died without output (turn stalled — no output from the harness"),
    ),
    "the idle timeout leaves a durable transcript failure, not only a stderr line",
  );
  assert.match(await readFileText(marker, "utf8"), /abort/, "RunnerHost sent the authoritative abort frame");
  assert.equal((await room.state()).pendingTurn, undefined);
  await service.dispose();
});

test("a message sent the instant a busy turn settles cannot jump ahead of an earlier durably-queued message", async () => {
  // settleTask clears activeTask SYNCHRONOUSLY, then emits task-end/task-error
  // (also synchronous — see Bus.emit) BEFORE it ever calls drain() (deferred
  // behind an async emitSnapshot). A listener on that very event is therefore
  // the one place a test can land a new sendMessage() call deterministically
  // inside that gap — exactly where a live message send raced a settling
  // /compact and got lost behind a later one (see room-service settleTask's
  // `draining` field).
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let turn = 0;
  const factory = (agent: AgentDef): AgentRuntime => ({
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    async *send() {
      turn += 1;
      if (turn === 1) await gate;
      yield { type: "text-delta", delta: `reply ${turn}` } as AgentEvent;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
  });
  const { service, root } = await makeService({ runtimeFactory: factory });

  await service.sendMessage("first"); // running, gated open
  const queuedBehindFirst = await service.sendMessage("queued behind first");
  assert.equal(queuedBehindFirst.status, "queued");

  let interloper: ReturnType<typeof service.sendMessage> | undefined;
  const unsubscribe = service.subscribe((event) => {
    if (event.type !== "task-end" && event.type !== "task-error") return;
    unsubscribe();
    interloper = service.sendMessage("interloper"); // fired synchronously, inside the gap
  });

  release();
  await service.waitForIdle(); // resolves on "first"'s settle — the same event that fired the listener above
  const interloperTask = await interloper!;
  assert.equal(interloperTask.status, "queued", "a message sent in the settle→drain gap must still queue behind the earlier message");

  // Drain until everything ran, then check strict FIFO order.
  for (let i = 0; i < 10 && (await RoomHandle.open(root, "default").then((r) => r.state().then((s) => s.queue?.length ?? 0))) > 0; i++) {
    await service.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  const userTexts = transcript.filter((event) => event.author === "user").map((event) => event.text);
  assert.deepEqual(userTexts, ["first", "queued behind first", "interloper"]);
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

test("cancel aborts the runtime, preserves partial output, and keeps the durable queue", async () => {
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
    // The REAL runner shape: abort() makes the runner report turn-error (or
    // dies under SIGKILL), which FAILS the event channel — the stream THROWS
    // out of the for-await, it does not end cleanly. The fake must die the
    // same way, or the test passes while production loses the turn.
    async *send() {
      yield { type: "text-delta", delta: "partial before cancel" } as AgentEvent;
      yield { type: "tool-start", toolName: "Bash", toolCallId: "t1", args: { command: "sleep 99" } } as AgentEvent;
      sawDelta();
      await hold;
      throw new Error("agent runner exited (signal SIGKILL).");
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
  // Stop targets the RUNNING turn only: queued messages are the user's own
  // work and survive it (they run next, via settle's drain).
  assert.notEqual(queued.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  // Cancel is a deliberate stop — but progress is never discarded: the text
  // AND the in-flight tool call both commit, with the tool settled (no
  // eternal spinner on a committed event).
  const committed = transcript.find((event) => event.author === "gaia" && event.text.startsWith("partial before cancel"));
  assert.ok(committed, "stopped turn's streamed text committed");
  assert.match(committed?.text ?? "", /turn ended without completion .*partial output preserved/);
  assert.equal(committed?.details?.tools?.length, 1, "stopped turn's tool call committed");
  assert.equal(committed?.details?.tools?.[0].status, "error", "interrupted tool settled, not left running");
  // The queued message ran after the stop instead of being dropped.
  assert.ok(transcript.some((event) => event.author === "user" && event.text === "queued behind"));
  assert.equal((await room.state()).queue, undefined, "queue drained by running, not by deletion");
});

test("stop during the tool/thinking phase (no prose yet) still commits the progress", async () => {
  // The exact shape that vanished: the agent had streamed thinking + tool
  // calls but no reply text, the user hit stop, and the WHOLE turn evaporated
  // (nothing flushed — the partial flush only carried text). The accumulator
  // must commit with its details plus the visible abnormal-end notice.
  let sawTool: () => void = () => {};
  const firstTool = new Promise<void>((resolve) => {
    sawTool = resolve;
  });
  let releaseHold: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  const root = await mkdtemp(join(tmpdir(), "gaia-cancel-tools-"));
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
  const runtime = {
    agent: agents.gaia,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    async *send() {
      yield { type: "thinking-delta", delta: "planning the image run" } as AgentEvent;
      yield { type: "tool-start", toolName: "Bash", toolCallId: "t1", args: { command: "imagegen" } } as AgentEvent;
      sawTool();
      await hold;
      throw new Error("agent runner exited (signal SIGKILL).");
    },
    async abort() {
      releaseHold();
    },
    dispose() {},
    resetRoom() {},
  } as unknown as AgentRuntime;

  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    memoryStore: new MemoryStore(),
    runtimeFactory: () => runtime,
  });
  await service.sendMessage("make me a portrait");
  await firstTool;
  const cancelled = await service.cancelActiveTask();
  assert.equal(cancelled?.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  const committed = transcript.find((event) => event.author === "gaia");
  assert.ok(committed, "tool-phase progress committed as an event");
  assert.equal(committed?.details?.tools?.length, 1);
  assert.equal(committed?.details?.tools?.[0].status, "error");
  assert.equal(committed?.details?.thinking, "planning the image run");
  assert.match(committed?.text ?? "", /turn ended without completion .*partial output preserved/);
  // No pendingTurn left behind — the stop settled the turn durably.
  assert.equal((await room.state()).pendingTurn, undefined);
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

test("/refresh invalidates every agent context without resetting sessions or transcript", async () => {
  const { service, root, runtimes } = await makeService();
  await service.sendMessage("keep this history");
  await service.waitForIdle();

  const task = await service.sendMessage("/refresh");
  assert.equal(task.status, "complete");
  assert.deepEqual(
    [...runtimes.values()].map((runtime) => runtime.refreshes),
    [1, 1],
  );
  assert.deepEqual(
    [...runtimes.values()].map((runtime) => runtime.resets),
    [0, 0],
  );

  const room = await RoomHandle.open(root, "default");
  const { events } = await room.eventsFrom(0);
  assert.equal(events[0].text, "keep this history");
  assert.equal(events.at(-1)?.text, "context refreshed — fresh soul/AGENTS.md/skills apply from each agent's next turn");
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
    (runtime as unknown as { compact: (roomId: string) => Promise<{ compacted: boolean; message: string }> }).compact = async () => {
      compactCalls += 1;
      const snapshot = await serviceRef!.getSnapshot();
      statusDuringCompact = snapshot.agents.find((agent) => agent.id === "gaia")?.status;
      return { compacted: true, message: "session compacted (999 tokens before)." };
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
  const compactEvent = transcript.find((event) => event.author === "system" && /session compacted \(999 tokens before\)/.test(event.text));
  assert.ok(compactEvent, "compaction reply is written to the transcript");
  assert.equal(compactEvent.kind, "compact-complete", "compaction completion is persisted with a structured transcript marker");
});

test("/compact streams live progress (token counts + start time) into the snapshot", async () => {
  let serviceRef: RoomService | undefined;
  let midPass: Snapshot | undefined;
  const factory = (agent: AgentDef) => {
    const runtime = scriptedRuntime(agent, () => [{ type: "text-delta", delta: "hi" } as AgentEvent]);
    runtime.capabilities = { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsCompact: true };
    (
      runtime as unknown as {
        compact: (roomId: string, onProgress?: (u: { outputTokens?: number }) => void) => Promise<{ compacted: boolean; message: string }>;
      }
    ).compact = async (_roomId, onProgress) => {
      // The harness reports the summary growing; it must reach the snapshot.
      onProgress?.({ outputTokens: 512 });
      midPass = await serviceRef!.getSnapshot();
      return { compacted: true, message: "session compacted." };
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
    (runtime as unknown as { compact: (roomId: string) => Promise<{ compacted: boolean; message: string }> }).compact = async () => {
      compacted.push(agent.id);
      return { compacted: true, message: "session compacted." };
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

test("durable compaction: a compacted agent that LOSES its session reloads [summary + tail], not the full raw transcript", async () => {
  let sessionAlive = true;
  let lastInput: AgentInput | undefined;
  const factory = (agent: AgentDef): AgentRuntime => {
    const rt = scriptedRuntime(agent, () => [{ type: "text-delta", delta: "ok" } as AgentEvent]);
    const original = rt.send.bind(rt);
    rt.send = async function* (input: AgentInput) {
      lastInput = input;
      yield* original(input);
    } as typeof rt.send;
    (rt as unknown as { hasDurableSession: () => boolean }).hasDurableSession = () => sessionAlive;
    (rt.capabilities as { supportsCompact?: boolean }).supportsCompact = true;
    (rt as unknown as { compact: () => Promise<{ compacted: boolean; message: string; summary: string }> }).compact = async () => ({
      compacted: true,
      message: "session compacted (999 tokens before).",
      summary: "COMPACTED-SUMMARY-XYZ: the earlier chapter, distilled.",
    });
    return rt as unknown as AgentRuntime;
  };
  const { service, root } = await makeService({ agents: ["gaia"], runtimeFactory: factory });

  // Build history, then compact: the floor lands at the current end and the
  // harness's own summary is persisted keyed to that floor.
  await service.sendMessage("first thing");
  await service.waitForIdle();
  await service.sendMessage("second thing");
  await service.waitForIdle();
  await service.sendMessage("/compact");
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "default");
  const floor = (await room.state()).contextFloors?.gaia;
  assert.ok(floor && floor > 0, "compaction set a context floor");
  const stored = await room.readCompaction("gaia");
  assert.equal(stored?.summary, "COMPACTED-SUMMARY-XYZ: the earlier chapter, distilled.", "the harness summary is persisted durably");
  assert.equal(stored?.floorIdx, floor, "the summary is keyed to the floor");

  // A live turn AFTER compaction advances the cursor past the floor (still resumed).
  await service.sendMessage("after compaction");
  await service.waitForIdle();

  // Now the harness session is LOST. The next turn must replay [summary + tail
  // after the floor], NOT silently revert to the full transcript from event 0.
  sessionAlive = false;
  await service.sendMessage("post-loss message");
  await service.waitForIdle();

  assert.ok(lastInput, "the post-loss turn ran");
  assert.match(lastInput!.recall ?? "", /COMPACTED-SUMMARY-XYZ/, "the durable summary is fed as context on the lost-session replay");
  const texts = lastInput!.transcript.map((event) => event.text);
  assert.ok(!texts.includes("first thing"), "pre-compaction history is NOT re-fed as raw transcript (the compaction survived)");
  assert.ok(texts.includes("post-loss message"), "the recent tail after the floor IS fed");
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

  // The steer itself is not queued. The active message may still occupy its
  // queue→WAL custody slot until its pendingTurn write completes.
  const state = (await readJson(workspacePaths.roomState(root, "default"))) as { queue?: QueuedMessage[] };
  assert.equal(state.queue?.some((entry) => entry.text === "/steer focus only on the tests") ?? false, false);

  release();
  await service.waitForIdle();

  // The guidance is recorded in the transcript as a user event.
  const { events: transcript } = await service.room.eventsFrom(0);
  const steerEvent = transcript.find((event) => event.text === "focus only on the tests");
  assert.ok(steerEvent, "steer text recorded for history");
  assert.equal(steerEvent?.author, "user");
});

test("steer-by-default: a plain message to the busy agent injects; @other and queue:true still queue", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const steerCalls: string[] = [];
  const factory = (agent: AgentDef): AgentRuntime => ({
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsMcp: false, supportsSteer: true },
    async *send() {
      await gate;
      yield { type: "text-delta", delta: "done" } as AgentEvent;
    },
    async steer(_roomId: string, message: string) {
      steerCalls.push(message);
      return true;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
  });
  const { service, root } = await makeService({ agents: ["gaia", "terry"], runtimeFactory: factory });

  await service.sendMessage("start a long task"); // gaia now running (gated open)

  // A bare message aimed at the busy agent steers its running turn — no queue.
  const steered = await service.sendMessage("also check the logs");
  assert.equal(steered.status, "complete", "steer settles while the turn still runs");
  assert.deepEqual(steerCalls, ["also check the logs"]);

  // An explicit @other isn't for the running agent → durable queue.
  const toOther = await service.sendMessage("@terry take a look");
  assert.equal(toOther.status, "queued");

  // queue:true (the Cmd/Ctrl+Enter opt-out) queues even for the running agent.
  const forcedQueue = await service.sendMessage("do this afterwards", { queue: true });
  assert.equal(forcedQueue.status, "queued");

  const state = (await readJson(workspacePaths.roomState(root, "default"))) as { queue?: QueuedMessage[] };
  assert.deepEqual(
    state.queue?.filter((entry) => entry.text !== "start a long task").map((entry) => entry.text),
    ["@terry take a look", "do this afterwards"],
    "only @other and the queue:true message joined the active message's custody entry",
  );

  release();
  await service.waitForIdle();

  // The steered guidance was recorded in the transcript as a user event.
  const { events: transcript } = await service.room.eventsFrom(0);
  assert.ok(
    transcript.some((event) => event.text === "also check the logs" && event.author === "user"),
    "steered message recorded for history",
  );
});

test("steer-by-default: a message WITH attachments steers too — breadcrumb lines ride the steer text", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const steerCalls: string[] = [];
  const factory = (agent: AgentDef): AgentRuntime => ({
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsMcp: false, supportsSteer: true },
    async *send() {
      await gate;
      yield { type: "text-delta", delta: "done" } as AgentEvent;
    },
    async steer(_roomId: string, message: string) {
      steerCalls.push(message);
      return true;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
  });
  const { service, root } = await makeService({ agents: ["gaia"], runtimeFactory: factory });

  await service.sendMessage("start a long task"); // gaia now running (gated open)

  const attachment = { name: "shot.png", mime: "image/png", size: 2048, path: "/tmp/shot.png" };
  const steered = await service.sendMessage("look at this", { attachments: [attachment] });
  assert.equal(steered.status, "complete", "attachment message steers instead of queueing");
  assert.equal(steerCalls.length, 1);
  assert.match(steerCalls[0], /^look at this\n\n\[attached file: shot\.png \(image\/png, 2 kB\) at \/tmp\/shot\.png\]$/, "breadcrumb line rides the steer text");

  const state = (await readJson(workspacePaths.roomState(root, "default"))) as { queue?: QueuedMessage[] };
  assert.equal(state.queue?.some((entry) => entry.text === "look at this") ?? false, false, "the steered message did not join the queue");

  release();
  await service.waitForIdle();

  // The committed user event carries the attachments (chips render after commit).
  const { events: transcript } = await service.room.eventsFrom(0);
  const event = transcript.find((candidate) => candidate.text === "look at this" && candidate.author === "user");
  assert.ok(event, "steered message recorded for history");
  assert.equal((event as { attachments?: unknown[] }).attachments?.length, 1, "attachments committed on the user event");
});

test("a mid-turn steer pins its position in the reply's committed ordered blocks", async () => {
  let releaseTail!: () => void;
  const tail = new Promise<void>((resolve) => (releaseTail = resolve));
  let firstDelta!: () => void;
  const streamedFirst = new Promise<void>((resolve) => (firstDelta = resolve));
  // Mimics RunnerHost's channel: events injected mid-turn surface in the stream
  // at the position they were injected (here: after "before ", pinned by the
  // gate). The position fidelity itself is runner-host.test.ts territory.
  const injected: AgentEvent[] = [];
  const factory = (agent: AgentDef): AgentRuntime => ({
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsMcp: false, supportsSteer: true },
    async *send() {
      yield { type: "text-delta", delta: "before " } as AgentEvent;
      firstDelta();
      await tail;
      yield* injected;
      yield { type: "text-delta", delta: "after" } as AgentEvent;
    },
    async steer() {
      return true;
    },
    injectEvent(event: AgentEvent) {
      injected.push(event);
      return true;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
  });
  const { service } = await makeService({ runtimeFactory: factory });

  await service.sendMessage("start a long task");
  await streamedFirst;
  const steered = await service.sendMessage("go left instead");
  assert.equal(steered.status, "complete", "steer settles while the turn still runs");
  releaseTail();
  await service.waitForIdle();

  const { events: transcript } = await service.room.eventsFrom(0);
  const steerEvent = transcript.find((event) => event.author === "user" && event.text === "go left instead");
  assert.ok(steerEvent, "steer recorded as a user event");
  const reply = transcript.find((event) => event.author === "gaia");
  assert.ok(reply && "details" in reply, "reply committed with details");
  assert.deepEqual(
    (reply as { details?: { blocks?: unknown } }).details?.blocks,
    [
      { kind: "text", text: "before " },
      { kind: "steer", id: steerEvent!.id },
      { kind: "text", text: "after" },
    ],
    "the steer marker references the user event at the exact stream position (round-tripped from disk)",
  );
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

test("/cancel stops the running turn and keeps queued messages without queueing itself", async () => {
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
        // The host's abort is authoritative: the stream always ends after it
        // (cooperatively or by killing the runner). Mirror that here.
        release();
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
  assert.match((reply as { event: { text: string } }).event.text, /1 queued message kept/);

  assert.equal((runtimes.get("gaia") as unknown as { aborted: boolean }).aborted, true, "runtime abort requested");
  // Stop targets the running turn only — the queued message survives and runs.
  assert.notEqual(queued.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await service.waitForIdle();
  const { events: transcript } = await service.room.eventsFrom(0);
  assert.ok(
    transcript.some((event) => event.author === "user" && event.text === "this waits in the queue"),
    "queued message ran after the stop instead of being dropped",
  );
  const state = (await readJson(workspacePaths.roomState(root, "default"))) as { queue?: unknown[] };
  assert.ok(!state.queue || state.queue.length === 0, "durable queue drained by running");
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

function recordingMemory(): { memory: RoomMemoryHooks; autoRecallCalls: () => number; captures: () => string[] } {
  let autoRecallCalls = 0;
  const captures: string[] = [];
  const memory: RoomMemoryHooks = {
    async autoRecallBlock() {
      autoRecallCalls += 1;
      return "SECRET recalled context from another room";
    },
    async capture(agentId) {
      captures.push(agentId);
    },
    async consolidate() {
      return { ran: false, episodesSeen: 0, factsAdded: 0, factsInvalidated: 0, memoryEdits: 0, opsSkipped: 0 };
    },
    async search() {
      return { hits: [], degraded: [] };
    },
  };
  return { memory, autoRecallCalls: () => autoRecallCalls, captures: () => captures };
}

test("incognito room: captures no episodes and injects no auto-recall (daemon-side gates)", async () => {
  const { memory, autoRecallCalls, captures } = recordingMemory();
  const { service } = await makeService({
    incognito: true,
    tools: ["read", "memory", "recall", "summon"],
    memory,
  });

  // The immutable flag is read from disk at open, cached, and surfaced.
  assert.equal(service.incognito, true);
  assert.equal((await service.getSnapshot()).room.incognito, true);

  await service.sendMessage("remember my password is hunter2");
  await service.waitForIdle();

  assert.equal(autoRecallCalls(), 0, "auto-recall must not run in an incognito room");
  assert.deepEqual(captures(), [], "no episodes captured in an incognito room");
  // (The memory/recall TOOL strip happens in the runner subprocess — see the
  // stripIncognitoTools unit test in test/tools.test.ts and the runner-host env
  // test — because the runner re-loads the agent from disk.)
});

test("normal room DOES inject auto-recall and capture episodes (control for incognito gates)", async () => {
  const { memory, autoRecallCalls, captures } = recordingMemory();
  const { service } = await makeService({
    tools: ["read", "memory", "recall", "summon"],
    memory,
  });

  assert.equal(service.incognito, false);

  await service.sendMessage("what did we decide last week?");
  await service.waitForIdle();

  assert.equal(autoRecallCalls(), 1, "auto-recall runs for a normal room");
  assert.deepEqual(captures(), ["gaia"], "the completed turn is captured as an episode");
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

  const state = (await readJson(workspacePaths.roomState(root, "default"))) as {
    agentCursors: Record<string, number>;
    contextFloors?: Record<string, number>;
  };
  // Only agents whose cursor passed the cut are touched: gaia saw the dropped
  // exchange (reset + reseeded); terry never spoke (still a NEW agent later).
  assert.deepEqual(state.agentCursors, { gaia: 0 }, "cursor capped to the kept window so the next turn replays it");
  assert.equal(state.contextFloors?.gaia, 0, "floor matches the seed so the replay never trips the session-lost gate");
  assert.ok(resets.includes("gaia:default"), "harness sessions reset");
  assert.ok(!resets.some((entry) => entry.startsWith("terry:")), "uninvolved agents keep their sessions");

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
  // The fork MUST reset the harness session: a live claude --resume / codex
  // rollout keeps its own copy of the conversation, so leaving it alive would
  // let the rewound turn (reply 2) survive inside it — the model would still
  // "see" the dropped exchange and treat the retry as one more resend. Resetting
  // is what makes the regenerated reply actually forget what came after the fork.
  assert.ok((runtimes.get("gaia")?.resets ?? 0) >= 1, "retry resets the session so the rewound tail can't linger inside it");

  // No progress ever lost: the dropped exchange is preserved beside the transcript.
  const rewound = (await readFileText(join(root, ".gaia", "rooms", "default", "rewound.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { text: string });
  assert.deepEqual(rewound.map((event) => event.text), ["second question", "reply 2"]);
});

test("editMessage forks at the edited user message and re-sends the new text with kept routing", async () => {
  const { service, runtimes } = await makeService({ agents: ["gaia", "terry"] });
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
  // Editing rewinds for the MODEL too, not just the sidebar: the harness session
  // that answered "original question" is reset, so the edited turn re-runs on a
  // fresh session instead of appending after the pre-edit text.
  assert.ok((runtimes.get("terry")?.resets ?? 0) >= 1, "edit resets the answering agent's session");

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

test("editMessage(keepAttachmentPaths): can drop a message's own attachments, and only its own", async () => {
  const inputs: Array<{ attachments?: unknown }> = [];
  const { service } = await makeService({
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

  const keepMe = await service.storeAttachment("keep.png", Buffer.from("keep-bytes"), "image/png");
  const dropMe = await service.storeAttachment("drop.png", Buffer.from("drop-bytes"), "image/png");
  const both = await service.resolveAttachments([
    { id: keepMe.id, name: keepMe.name, mime: keepMe.mime },
    { id: dropMe.id, name: dropMe.name, mime: dropMe.mime },
  ]);

  await service.sendMessage("two attachments", { attachments: both });
  await service.waitForIdle();
  const [userEvent] = (await service.room.eventsFrom(0)).events;

  // Omitting keepAttachmentPaths keeps default (unchanged) behavior: both ride along.
  await service.editMessage(userEvent.id, "still two", undefined);
  await service.waitForIdle();
  assert.deepEqual(inputs.at(-1)?.attachments, both);
  const [afterUnchanged] = (await service.room.eventsFrom(0)).events;

  // Passing only the kept path drops the other one.
  await service.editMessage(afterUnchanged.id, "now one", [keepMe.path]);
  await service.waitForIdle();
  assert.deepEqual(inputs.at(-1)?.attachments, [both[0]]);

  // An explicit empty array drops them all.
  const [afterOne] = (await service.room.eventsFrom(0)).events;
  await service.editMessage(afterOne.id, "now none", []);
  await service.waitForIdle();
  assert.equal(inputs.at(-1)?.attachments, undefined);

  // A path the message never had is silently ignored (never adds an attachment
  // the edit didn't already carry) — it can only narrow, not widen.
  const [afterNone] = (await service.room.eventsFrom(0)).events;
  await service.editMessage(afterNone.id, "still none", ["/etc/passwd"]);
  await service.waitForIdle();
  assert.equal(inputs.at(-1)?.attachments, undefined);
});

test("/model rewrites agent.json AND fires the settings reload that reaches live runners", async () => {
  const reloads: string[] = [];
  const { service, workspace, root } = await makeService({
    settingsChanged: async (scope) => {
      reloads.push(scope);
    },
  });
  await service.init();

  // A bare name with no current provider and no spec-declared default is
  // REJECTED — never silently defaulted to one hardcoded provider's world.
  // (runModelCommand surfaces the error as its reply text.)
  const rejected = await service.runModelCommand(undefined, "opus");
  assert.match(rejected, /Use <provider\/name>/);

  const reply = await service.runModelCommand(undefined, "anthropic/opus");
  assert.match(reply, /Set @gaia model to anthropic\/opus/);
  assert.match(reply, /next turn/);

  // Persisted to agent.json…
  const config = (await readJson(join(root, "agents", "gaia", "agent.json"))) as { model?: { provider?: string; name?: string } };
  assert.deepEqual(config.model, { provider: "anthropic", name: "opus" });
  // …mirrored in-process for the snapshot chip…
  assert.deepEqual(workspace.agents.gaia.model, { provider: "anthropic", name: "opus" });

  // …and the daemon reload fired: runners snapshot agent.json at spawn, so
  // ONLY a service rebuild makes the next turn actually run the new model.
  assert.deepEqual(reloads, ["global"]);

  // With a provider now on record, a bare name keeps it.
  const kept = await service.runModelCommand(undefined, "haiku");
  assert.match(kept, /Set @gaia model to anthropic\/haiku/);

  // Clearing the override goes through the same reload.
  const cleared = await service.runModelCommand(undefined, "none");
  assert.match(cleared, /Cleared @gaia model override/);
  const after = (await readJson(join(root, "agents", "gaia", "agent.json"))) as { model?: unknown };
  assert.equal(after.model, undefined);
  assert.deepEqual(reloads, ["global", "global", "global"]);
});

test("setAgentThinking (the global-default write path, e.g. the agent-config editor) rewrites agent.json and fires the settings reload", async () => {
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

test("/thinking (runThinkingCommand, no active call) is room-scoped: it does NOT touch agent.json or fire a settings reload", async () => {
  const reloads: string[] = [];
  const { service, root } = await makeService({
    settingsChanged: async (scope) => {
      reloads.push(scope);
    },
  });
  await service.init();

  const reply = await service.runThinkingCommand("gaia", "high");
  assert.match(reply, /Set @gaia thinking to high for this room/);
  assert.deepEqual(reloads, []); // no agent.json write → no reload

  // Nothing landed in the effective agent.json — it doesn't even exist yet.
  assert.equal(await readJson(join(root, "agents", "gaia", "agent.json")), undefined);

  // Room state carries the override directly.
  const state = await (await RoomHandle.open(root, "default")).state();
  assert.equal(state.thinkingOverrides.gaia, "high");

  // "" clears the override, reverting to the (unset) global default. (The
  // slash command's own `!level` guard means /thinking with no argument shows
  // usage instead — unchanged pre-existing UX; clearing is reached directly,
  // e.g. from the composer chip / HTTP route, via setRoomThinking itself.)
  const cleared = await service.setRoomThinking("gaia", "");
  assert.match(cleared, /Cleared @gaia room thinking \(using global default off\)/);
  const clearedState = await (await RoomHandle.open(root, "default")).state();
  assert.equal(clearedState.thinkingOverrides.gaia, undefined);
});

test("room-scoped thinking never leaks across rooms (mirrors role isolation) and never mutates the shared in-memory agent object", async () => {
  const { service: roomA, workspace, root } = await makeService({ roomId: "room-a" });
  await roomA.init();
  const roomB = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    roomId: "room-b",
    memoryStore: new MemoryStore(),
    runtimeFactory: (agent) => scriptedRuntime(agent, () => [{ type: "text-delta", delta: "hi from b" } as AgentEvent]),
  });
  await roomB.init();

  const reply = await roomA.runThinkingCommand("gaia", "high");
  assert.match(reply, /Set @gaia thinking to high for this room/);

  // Room A's snapshot shows the override; room B's does not — genuinely
  // isolated, not just "hasn't refreshed yet".
  const snapA = await roomA.getSnapshot();
  const snapB = await roomB.getSnapshot();
  assert.equal(snapA.agents.find((a) => a.id === "gaia")?.thinking, "high");
  assert.equal(snapB.agents.find((a) => a.id === "gaia")?.thinking, undefined);

  // The shared in-memory agent object (workspace.agents.gaia, read by every
  // room service on this workspace) is untouched — this is the actual bug:
  // a room-scoped change must never mutate shared agent state.
  assert.equal(workspace.agents.gaia.thinking, undefined);

  // A turn run in room B does NOT inherit room A's override.
  const inputsB: (string | undefined)[] = [];
  const bRuntime = {
    agent: workspace.agents.gaia,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    async *send(input: AgentInput) {
      inputsB.push(input.thinking);
      yield { type: "text-delta", delta: "hi" } as AgentEvent;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
  } as unknown as AgentRuntime;
  // Swap room B's runtime for one that records the thinking it was fed.
  (roomB as unknown as { runtimes: Record<string, AgentRuntime> }).runtimes.gaia = bRuntime;
  await roomB.sendMessage("hello", { targets: ["gaia"] });
  await roomB.waitForIdle();
  assert.equal(inputsB[0], undefined);

  // agent.json was never written by the room-scoped path.
  assert.equal(await readJson(join(root, "agents", "gaia", "agent.json")), undefined);
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
  // The agent whose session read the original text got a fresh session and a
  // capped cursor; agents that never spoke have no session holding the
  // original, so they are untouched (resetting them was always a no-op).
  assert.ok((runtimes.get("gaia")?.resets ?? 0) >= 1, "the exposed session resets");
  assert.equal(runtimes.get("terry")?.resets ?? 0, 0, "uninvolved agents keep their sessions");
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

test("a parse-error / no-suggestion review is never surfaced as pending (no re-pop on reload)", async () => {
  // Dario's turn came back as non-JSON (e.g. an empty "(no output)" reply). It
  // degrades to a proposal with a parseError and 0 suggestions — nothing to
  // apply, so it can never be marked applied. It must NOT sit pending on the
  // snapshot, or the popup re-pops on every reload forever.
  const host = fakeSummonHost(() => "(no output)");
  const { service, workspace, root } = await makeService({ agents: ["gaia", "terry", "dario"], summonHost: host });
  await service.sendMessage("hello there");
  await service.waitForIdle();

  const proposal = await service.sanitizePreview();
  assert.ok(proposal.parseError, "non-JSON degrades to a parseError proposal");
  assert.equal(proposal.suggestions.length, 0);
  // Not advertised as pending on the snapshot — the popup has nothing to open.
  assert.equal((await service.getSnapshot()).room.sanitize, undefined);
  // But the file is preserved, so a manual re-open still shows his raw notes.
  assert.equal((await service.getSanitizeProposal())?.parseError, proposal.parseError);
  assert.equal(((await readJson(join(root, ".gaia", "rooms", "default", "sanitize.json"))) as SanitizeProposal).raw, "(no output)");

  // A fresh process (restart) must not restore it as pending either.
  const reopened = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    memoryStore: new MemoryStore(),
    runtimeFactory: (agent) => scriptedRuntime(agent, () => [{ type: "text-delta", delta: "hi" } as AgentEvent]),
  });
  assert.equal((await reopened.getSnapshot()).room.sanitize, undefined);
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

test("no automatic truncation: a new agent joining a big room loads the FULL transcript, never gated", async () => {
  const captured = new Map<string, AgentInput[]>();
  const { service, runtimes } = await makeService({
    agents: ["gaia", "nyari"],
    // A threshold may be configured, but it is never acted on: nothing automatic
    // shrinks context. Only an explicit /compact the user types ever does.
    config: { contextGate: { warnAboveTokens: 60 } },
    runtimeFactory: (agent) => {
      const sink: AgentInput[] = [];
      captured.set(agent.id, sink);
      return capturingRuntime(agent, sink);
    },
  });

  // gaia opens, then piles on — the room grows well past the old threshold.
  await service.sendMessage("@gaia hi");
  await service.waitForIdle();
  for (let i = 0; i < 4; i++) {
    await service.sendMessage(`@gaia message ${i} ${PAD}`);
    await service.waitForIdle();
  }
  assert.equal(runtimes.get("gaia")!.sends, 5);

  // Address the NEW agent → it runs IMMEDIATELY with the whole history. No gate
  // is ever opened; the full transcript replays into its first turn.
  await service.sendMessage("@nyari please catch up");
  await service.waitForIdle();
  assert.equal(runtimes.get("nyari")!.sends, 1, "new agent ran at once — nothing held it");
  assert.equal((await service.getSnapshot()).room.contextGate, undefined, "no context gate is ever opened");
  assert.equal(captured.get("nyari")!.at(-1)!.transcript.length, 11, "the FULL transcript (10 prior + this message) replayed — nothing truncated");
  assert.equal(runtimes.get("gaia")!.sends, 5);
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

test("no automatic truncation: a lost session in a BIG room replays everything, never gated", async () => {
  const captured: AgentInput[] = [];
  let alive = true;
  const { service, runtimes } = await makeService({
    agents: ["gaia"],
    config: { contextGate: { warnAboveTokens: 60 } },
    runtimeFactory: (agent) => capturingRuntime(agent, captured, () => alive),
  });

  // Grow the room well past the old threshold with a live session.
  await service.sendMessage("@gaia hi");
  await service.waitForIdle();
  for (let i = 0; i < 4; i++) {
    await service.sendMessage(`@gaia message ${i} ${PAD}`);
    await service.waitForIdle();
  }
  assert.equal(runtimes.get("gaia")!.sends, 5);

  // Session gone + big replay ⇒ heals exactly like a small room: it replays the
  // WHOLE transcript at once. No gate, no truncation, no held turn.
  alive = false;
  await service.sendMessage("@gaia what happened so far?");
  await service.waitForIdle();
  assert.equal(runtimes.get("gaia")!.sends, 6, "ran at once — nothing held it");
  assert.equal((await service.getSnapshot()).room.contextGate, undefined, "no gate for a big lost-session replay");
  assert.equal(captured.at(-1)!.transcript.length, 11, "full reload from event 0 — 10 prior + the new message");
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

test("an upstream-stall notice appends exactly one throttled system_stall room event, even with 3 in one turn", async () => {
  const { service, root, events } = await makeService({
    script: () => [
      { type: "notice", kind: "upstream-stall", text: "gateway 502" } as AgentEvent,
      { type: "notice", kind: "upstream-stall", text: "gateway 502" } as AgentEvent,
      { type: "notice", kind: "upstream-stall", text: "gateway 502" } as AgentEvent,
      { type: "text-delta", delta: "done" } as AgentEvent,
    ],
  });
  await service.sendMessage("hi @gaia");
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  const stallNotices = transcript.filter((event) => event.author === "system" && event.text.includes("harness retrying"));
  assert.equal(stallNotices.length, 1, "three notices within the 60s throttle window collapse to one visible line");
  assert.match(stallNotices[0].text, /upstream stall \(@gaia\): gateway 502 — harness retrying/);

  // The notice never rides the reply text (wave 1 already excluded it from toUiEvent).
  const reply = transcript.find((event) => event.author === "gaia");
  assert.equal(reply?.text, "done");
  assert.equal(
    events.some((event) => (event as { type: string }).type === "notice"),
    false,
    "notice is never emitted as a UI transport event",
  );
});

test("liveTurn.stalled mirrors an upstream stall on the snapshot and clears on recovery", async () => {
  let serviceRef: RoomService | undefined;
  let stalledDuringStall: boolean | undefined;
  let stalledAfterRecovery: boolean | undefined;
  const factory = (agent: AgentDef): AgentRuntime => {
    const runtime = {
      agent,
      modelLabel: "test/model",
      capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
      async *send(): AsyncGenerator<AgentEvent> {
        yield { type: "notice", kind: "upstream-stall", text: "gateway 502" } as AgentEvent;
        // runAgentTurn ran onEvent → applyLiveTurn for the notice BEFORE pulling
        // the next event (turns.ts for-await), so the mirror must now read as
        // reconnecting — this is exactly what a mid-stall (re)subscribe sees.
        stalledDuringStall = (await serviceRef!.getSnapshot()).room.liveTurn?.stalled;
        yield { type: "text-delta", delta: "back" } as AgentEvent;
        // Real output proved recovery — the flag must be cleared again.
        stalledAfterRecovery = (await serviceRef!.getSnapshot()).room.liveTurn?.stalled;
      },
      async abort() {},
      dispose() {},
      resetRoom() {},
    };
    return runtime as unknown as AgentRuntime;
  };
  const { service } = await makeService({ runtimeFactory: factory });
  serviceRef = service;

  await service.sendMessage("hi @gaia");
  await service.waitForIdle();

  assert.equal(stalledDuringStall, true, "an upstream-stall notice marks the live turn reconnecting on the snapshot");
  assert.equal(stalledAfterRecovery, false, "the next real output clears the reconnecting flag");
  // Ephemeral: nothing survives the commit (the committed reply is never "stalled").
  assert.equal((await service.getSnapshot()).room.liveTurn, undefined, "the live mirror is gone once the turn commits");
});

/** A runtime whose every send() fails the way RunnerHost's hard stall
 * deadline fails an active channel: a named UpstreamStallError, no events
 * streamed first — the same shape a real wedged-upstream turn produces. */
function stallingRuntime(agent: AgentDef): AgentRuntime & { sends: number } {
  const runtime = {
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    sends: 0,
    async *send(): AsyncGenerator<AgentEvent> {
      runtime.sends += 1;
      const err = new Error("upstream stalled — no recovery within 1s; aborted the wedged turn (partial progress, if any, is kept)");
      err.name = "UpstreamStallError";
      throw err;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
  };
  return runtime as AgentRuntime & { sends: number };
}

test("a stalled turn with no partial reply requeues ONCE (stallRetried), then fails normally on a second stall", async () => {
  const { service, root } = await makeService({
    runtimeFactory: (agent) => stallingRuntime(agent),
  });

  await service.sendMessage("hi @gaia");
  await service.waitForIdle(); // first attempt: stalls, requeues, settles "error"

  // Let the requeued retry drain and run (also fails — this time for good).
  await waitFor(async () => ((await RoomHandle.open(root, "default").then((r) => r.state())).queue?.length ?? 0) === 0);
  await sleep(50);
  await service.waitForIdle().catch(() => {});

  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  const userMessages = transcript.filter((event) => event.author === "user");
  assert.equal(userMessages.length, 1, "the retry replays the ORIGINAL prompt without re-recording it");

  const requeueNotices = transcript.filter((event) => event.text.includes("requeued, retrying once"));
  assert.equal(requeueNotices.length, 1, "requeue happens exactly once");
  assert.match(requeueNotices[0].text, /turn aborted after upstream stall \(@gaia\)/);

  const noOutputFailures = transcript.filter((event) => event.text.includes("turn died without output"));
  assert.equal(noOutputFailures.length, 2, "both abnormal no-output attempts leave a durable failure; only the first requeues");

  const finalState = await room.state();
  assert.equal(finalState.queue ?? undefined, undefined, "no further requeue — the queue is empty again");
  assert.equal(finalState.pendingTurn, undefined);
});

function transientAuthRuntime(agent: AgentDef): AgentRuntime & { sends: number } {
  const runtime = {
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    sends: 0,
    async *send(): AsyncGenerator<AgentEvent> {
      runtime.sends += 1;
      const error = new Error("Not logged in · Please run /login");
      error.name = "TransientAuthError";
      throw error;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
  };
  return runtime as AgentRuntime & { sends: number };
}

test("a transient auth failure requeues with authRetries and notBefore instead of terminal failure", async () => {
  const { service, root } = await makeService({ runtimeFactory: (agent) => transientAuthRuntime(agent) });

  await service.sendMessage("hi @gaia");
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "default");
  const state = await room.state();
  assert.equal(state.queue?.length, 1);
  assert.equal(state.queue?.[0].authRetries, 1);
  assert.ok(Date.parse(state.queue?.[0].notBefore ?? "") > Date.now(), "retry has a future notBefore");

  const { events: transcript } = await room.eventsFrom(0);
  assert.equal(transcript.some((event) => event.text.includes("transient auth")), true);
  assert.equal(
    transcript.some((event) => event.text.includes("turn died without output (Not logged in · Please run /login)")),
    true,
    "the retry policy does not erase the failed no-output attempt's durable trace",
  );
  await service.dispose();
});

test("drain waits until a queued entry's notBefore before dispatching it", async () => {
  const notBefore = new Date(Date.now() + 75).toISOString();
  const { service, runtimes } = await makeService({
    agents: ["gaia"],
    queued: [{ taskId: "task_auth_wait", text: "retry me", targets: ["gaia"], authRetries: 1, notBefore, queuedAt: new Date().toISOString() }],
  });

  await service.init();
  assert.equal(runtimes.get("gaia")?.sends ?? 0, 0, "future queue head is not dispatched immediately");
  await waitFor(() => (runtimes.get("gaia")?.sends ?? 0) === 1);
  await service.waitForSettled();
  assert.ok(Date.now() >= Date.parse(notBefore), "dispatch happened only once the entry was due");
});

test("a sixth transient auth failure falls through to the normal terminal failure", async () => {
  const { service, root } = await makeService({
    agents: ["gaia"],
    queued: [{ taskId: "task_auth_sixth", text: "retry me", targets: ["gaia"], authRetries: 5, queuedAt: new Date().toISOString() }],
    runtimeFactory: (agent) => transientAuthRuntime(agent),
  });

  await service.waitForSettled();
  const room = await RoomHandle.open(root, "default");
  const { events: transcript } = await room.eventsFrom(0);
  assert.equal(transcript.some((event) => event.text.startsWith("⚠ turn failed (@gaia)")), true);
  assert.equal(transcript.some((event) => event.text.includes("transient auth") && event.text.includes("requeued")), false);
  assert.equal((await room.state()).queue, undefined);
});

// `gaia resume <roomId> "<message>"` (server/http.ts's /api/harness/resume
// branch) is a thin, inlined call: validate room+message, resolve the target
// room's service via daemon.serviceFor(claims.workspaceId, room), then
// service.sendMessage(message, { recordUserMessage: true }). `resumeDispatch`
// below mirrors that exact control flow (same validation, same lookup-or-fail,
// same sendMessage call) against two REAL RoomService instances so the
// invariant that matters — the message reaches the TARGET room's service and
// no other — is exercised against the real steer/queue/commit machinery, not
// a mock.
async function resumeDispatch(
  services: Map<string, RoomService>,
  room: string | undefined,
  message: string | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!room?.trim() || !message?.trim()) return { status: 400, body: { error: "Missing room or message" } };
  const service = services.get(room);
  if (!service) return { status: 400, body: { error: `Unknown workspace: room '${room}' not found` } };
  await service.sendMessage(message, { recordUserMessage: true });
  return { status: 200, body: { roomId: room, result: `Resumed room '${room}' with a follow-up message.` } };
}

test("resume: rejects a missing room or message without touching any service", async () => {
  const a = await makeService({ roomId: "room-a" });
  const services = new Map([["room-a", a.service]]);

  assert.deepEqual(await resumeDispatch(services, undefined, "keep going"), { status: 400, body: { error: "Missing room or message" } });
  assert.deepEqual(await resumeDispatch(services, "room-a", ""), { status: 400, body: { error: "Missing room or message" } });
  assert.deepEqual(await resumeDispatch(services, "room-a", "   "), { status: 400, body: { error: "Missing room or message" } });
  assert.equal((await resumeDispatch(services, "no-such-room", "hi")).status, 400);

  await a.service.waitForIdle();
  const room = await RoomHandle.open(a.root, "room-a");
  const { events: transcript } = await room.eventsFrom(0);
  assert.equal(transcript.length, 0, "none of the rejected calls reached sendMessage");
});

test("resume: routes the message to sendMessage on the TARGET room's service, never a different room's", async () => {
  const a = await makeService({ roomId: "room-a" });
  const b = await makeService({ roomId: "room-b" });
  const services = new Map([
    ["room-a", a.service],
    ["room-b", b.service],
  ]);

  const result = await resumeDispatch(services, "room-b", "keep going, worker");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { roomId: "room-b", result: "Resumed room 'room-b' with a follow-up message." });

  await b.service.waitForIdle();
  await a.service.waitForIdle();

  const roomB = await RoomHandle.open(b.root, "room-b");
  const { events: bTranscript } = await roomB.eventsFrom(0);
  assert.equal(bTranscript[0]?.author, "user");
  assert.equal(bTranscript[0]?.text, "keep going, worker");
  assert.equal(bTranscript[1]?.author, "gaia", "the target room's own agent actually ran the resumed turn");

  const roomA = await RoomHandle.open(a.root, "room-a");
  const { events: aTranscript } = await roomA.eventsFrom(0);
  assert.equal(aTranscript.length, 0, "resume must never leak the message into a different room");
});

test("resume: a message that arrives while the target room is mid-turn STEERS it instead of queuing (steer-by-default)", async () => {
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let first = true;
  const { service, root } = await makeService({
    roomId: "worker-room",
    runtimeFactory: (agent) => {
      const runtime = {
        agent,
        modelLabel: "test/model",
        capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsSteer: true },
        async *send(): AsyncIterable<AgentEvent> {
          if (first) {
            first = false;
            await gate;
          }
          yield { type: "text-delta", delta: "done" };
        },
        async abort() {},
        dispose() {},
        async steer(_roomId: string, text: string): Promise<boolean> {
          steeredWith.push(text);
          return true;
        },
      };
      return runtime as unknown as AgentRuntime;
    },
  });
  const steeredWith: string[] = [];
  const services = new Map([["worker-room", service]]);

  const first_ = service.sendMessage("start the task");
  await sleep(20); // let the turn become active before resuming

  const resumeResult = await resumeDispatch(services, "worker-room", "also check the edge case");
  assert.equal(resumeResult.status, 200);
  assert.deepEqual(steeredWith, ["also check the edge case"]);

  releaseFirst();
  await first_;
  await service.waitForIdle();

  const room = await RoomHandle.open(root, "worker-room");
  const { events: transcript } = await room.eventsFrom(0);
  // The steered guidance is recorded for history (runSteerCommand/
  // steerRunningTurn's documented contract) but never queued as its OWN
  // pending task — it rode straight into the ALREADY-RUNNING turn, so there
  // is exactly one such user event, and only one agent reply total (the
  // resumed turn never forked into a second run).
  assert.equal(
    transcript.filter((event) => event.author === "user" && event.text === "also check the edge case").length,
    1,
  );
  assert.equal(transcript.filter((event) => event.author === "gaia").length, 1, "the steer rode into the single running turn, not a second one");
  const finalState = await room.state();
  assert.equal(finalState.queue ?? undefined, undefined, "resume-as-steer never lands in the durable queue");
});
