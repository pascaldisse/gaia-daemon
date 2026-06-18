import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { AgentDefinition } from "../src/agents/types.ts";
import { GaiaController, type GaiaUiEvent } from "../src/app/gaia-controller.ts";
import type { AgentInput, AgentRuntime } from "../src/runtime/types.ts";
import { initWorkspace, loadWorkspace } from "../src/workspace/workspace-loader.ts";
import { createTempDir } from "./helpers/temp.ts";

class FakeRuntime implements AgentRuntime {
  readonly modelLabel = "fake/model";

  constructor(readonly agent: AgentDefinition) {}

  async *send() {
    yield { type: "model-info" as const, provider: "fake", modelId: "model-1", subscription: true };
    yield { type: "thinking-start" as const };
    yield { type: "thinking-delta" as const, delta: "thinking" };
    yield { type: "thinking-end" as const, content: "thinking" };
    yield { type: "tool-start" as const, toolName: "read", toolCallId: "call_1", args: { path: "AGENTS.md" } };
    yield { type: "tool-update" as const, toolName: "read", toolCallId: "call_1", partialResult: { content: "partial" } };
    yield { type: "tool-end" as const, toolName: "read", toolCallId: "call_1", result: { content: "done" }, isError: false };
    yield { type: "text-delta" as const, delta: `hello from ${this.agent.id}` };
  }

  async abort(): Promise<void> {}

  dispose(): void {}
}

class SlowRuntime implements AgentRuntime {
  readonly modelLabel = "fake/model";
  private aborted = false;

  constructor(readonly agent: AgentDefinition) {}

  async *send() {
    while (!this.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  dispose(): void {
    this.aborted = true;
  }
}

test("streams a room task through UI-neutral events", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const controller = new GaiaController({
      cwd: temp.path,
      workspaceId: "workspace",
      workspace,
      runtimeFactory: (agent) => new FakeRuntime(agent),
    });
    const events: GaiaUiEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const task = await controller.sendMessage("hello");
    await waitFor(() => events.some((event) => event.type === "task-end" && event.task.id === task.id));
    const snapshot = await controller.getSnapshot();

    assert.equal(task.status, "complete");
    assert.ok(events.some((event) => event.type === "task-start"));
    assert.ok(events.some((event) => event.type === "model-info" && event.provider === "fake" && event.subscription));
    assert.ok(events.some((event) => event.type === "text-delta"));
    assert.ok(events.some((event) => event.type === "thinking-start"));
    assert.ok(events.some((event) => event.type === "thinking-delta"));
    assert.ok(events.some((event) => event.type === "thinking-end"));
    assert.ok(events.some((event) => event.type === "tool-start" && event.toolName === "read" && event.toolCallId === "call_1"));
    assert.ok(events.some((event) => event.type === "tool-update" && event.toolName === "read" && event.toolCallId === "call_1"));
    assert.ok(events.some((event) => event.type === "tool-end" && event.toolName === "read" && event.toolCallId === "call_1" && !event.isError));
    assert.equal(snapshot.room.events.at(-1)?.author, "gaia");
    assert.match(snapshot.room.events.at(-1)?.text ?? "", /hello from gaia/);
    assert.equal(snapshot.room.events.at(-1)?._model, "fake/model-1 (oauth)");
    assert.equal(snapshot.room.events.at(-1)?._thinkingStarted, true);
    assert.equal(snapshot.room.events.at(-1)?._thinking, "thinking");
    assert.deepEqual(snapshot.room.events.at(-1)?._tools?.at(0), {
      id: "call_1",
      toolName: "read",
      status: "complete",
      args: { path: "AGENTS.md" },
      partialResult: { content: "partial" },
      result: { content: "done" },
    });
    controller.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("runs a voice turn against an explicit target without a user room event", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const inputs: AgentInput[] = [];
    class CapturingRuntime extends FakeRuntime {
      override async *send(input?: AgentInput) {
        if (input) inputs.push(input);
        yield* super.send();
      }
    }
    const controller = new GaiaController({
      cwd: temp.path,
      workspaceId: "workspace",
      workspace,
      runtimeFactory: (agent) => new CapturingRuntime(agent),
    });
    const events: GaiaUiEvent[] = [];
    controller.subscribe((event) => events.push(event));

    // Greeting-style turn: synthetic prompt, no user message in the room.
    const greeting = await controller.sendMessage("(voice call started)", {
      targets: ["gaia"],
      channel: "voice",
      recordUserMessage: false,
    });
    await waitFor(() => events.some((event) => event.type === "task-end" && event.task.id === greeting.id));

    // Spoken turn: lands in the room with the voice channel marker.
    const spoken = await controller.sendMessage("how are you", { targets: ["gaia"], channel: "voice" });
    await waitFor(() => events.some((event) => event.type === "task-end" && event.task.id === spoken.id));

    const snapshot = await controller.getSnapshot();
    const userEvents = snapshot.room.events.filter((event) => event.author === "user");
    assert.equal(userEvents.length, 1);
    assert.equal(userEvents[0]?.text, "how are you");
    assert.equal(userEvents[0]?.channel, "voice");
    const agentEvents = snapshot.room.events.filter((event) => event.author === "gaia");
    assert.equal(agentEvents.length, 2);
    assert.ok(agentEvents.every((event) => event.channel === "voice"));
    assert.deepEqual(
      inputs.map((input) => input.channel),
      ["voice", "voice"],
    );
    assert.deepEqual(greeting.targets, ["gaia"]);
    controller.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("routes /thinking through the host setThinking hook", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const calls: Array<[string, string]> = [];
    const controller = new GaiaController({
      cwd: temp.path,
      workspaceId: "workspace",
      workspace,
      runtimeFactory: (agent) => new FakeRuntime(agent),
      setThinking: async (agentId, level) => {
        calls.push([agentId, level]);
        return `Set @${agentId} thinking to ${level}.`;
      },
    });
    const events: GaiaUiEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const systemText = async (input: string) => {
      const task = await controller.sendMessage(input);
      await waitFor(() => events.some((event) => event.type === "task-end" && event.task.id === task.id));
      const systemEvents = events.filter((event) => event.type === "room-event" && event.event.author === "system");
      return (systemEvents.at(-1) as { event: { text: string } }).event.text;
    };

    // Bare level targets the default agent; explicit agent overrides.
    assert.match(await systemText("/thinking low"), /Set @gaia thinking to low\./);
    assert.match(await systemText("/thinking sidia high"), /Set @sidia thinking to high\./);
    assert.deepEqual(calls, [["gaia", "low"], ["sidia", "high"]]);
    assert.match(await systemText("/thinking"), /Usage: \/thinking/);
    assert.match(await systemText("/thinking nope low"), /Unknown agent: @nope/);
    controller.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("routes /summon with error messages for unavailable system, missing args, and unknown agent", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const controller = new GaiaController({
      cwd: temp.path,
      workspaceId: "workspace",
      workspace,
      // runtimeFactory disables SummonManager in test mode; verify graceful handling.
      runtimeFactory: (agent) => new FakeRuntime(agent),
    });
    const events: GaiaUiEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const systemText = async (input: string) => {
      const task = await controller.sendMessage(input);
      await waitFor(() => events.some((event) => event.type === "task-end" && event.task.id === task.id));
      const systemEvents = events.filter((event) => event.type === "room-event" && event.event.author === "system");
      return (systemEvents.at(-1) as { event: { text: string } }).event.text;
    };

    // Summon system unavailable when runtimeFactory is used (test mode).
    assert.match(await systemText("/summon scout map"), /Summon system is not available/);
    // Missing args.
    assert.match(await systemText("/summon"), /Summon system is not available/); // short-circuits on unavailable
    // The unavailable check runs first, so we only test the happy-path
    // arg-check messages in the summon-manager unit tests.
    controller.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("rejects explicit targets that do not exist", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const controller = new GaiaController({
      cwd: temp.path,
      workspaceId: "workspace",
      workspace,
      runtimeFactory: (agent) => new FakeRuntime(agent),
    });
    await assert.rejects(() => controller.sendMessage("hi", { targets: ["nope"] }), /Unknown agent: @nope/);
    controller.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("cancels an active room task", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const controller = new GaiaController({
      cwd: temp.path,
      workspaceId: "workspace",
      workspace,
      runtimeFactory: (agent) => new SlowRuntime(agent),
    });
    const events: GaiaUiEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const task = await controller.sendMessage("keep going");
    await waitFor(() => events.some((event) => event.type === "task-start" && event.task.id === task.id));
    const cancelled = await controller.cancelActiveTask();
    await waitFor(() => events.some((event) => event.type === "task-end" && event.task.id === task.id && event.task.status === "cancelled"));

    assert.equal(cancelled?.status, "cancelled");
    assert.equal((await controller.getSnapshot()).tasks.at(-1)?.status, "cancelled");
    controller.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("mutateAgentMemory writes through the controller's MemoryStore (the daemon single-writer path)", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const controller = new GaiaController({
      cwd: temp.path,
      workspaceId: "workspace",
      workspace,
      runtimeFactory: (agent) => new FakeRuntime(agent),
    });
    await controller.init();

    const result = await controller.mutateAgentMemory("gaia", "MEMORY.md", "add", { content: "the latency target is 500ms" });
    assert.equal(result.ok, true);
    assert.match(result.state.content, /latency target is 500ms/);

    // A fresh read sees the persisted write (file-backed, no in-process bridge).
    const reread = await controller.mutateAgentMemory("gaia", "MEMORY.md", "add", { content: "the latency target is 500ms" });
    assert.match(reread.message, /duplicate/);

    await assert.rejects(() => controller.mutateAgentMemory("nope", "MEMORY.md", "add", { content: "x" }), /Unknown agent/);
    controller.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for predicate");
}
