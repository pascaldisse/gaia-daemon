import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition } from "../src/agents/types.ts";
import { MemoryStore } from "../src/memory/memory-store.ts";
import {
  codexSandboxFor,
  CodexRuntime,
  type CodexClient,
  type CodexClientFactory,
} from "../src/runtime/codex-runtime.ts";
import type { AgentEvent } from "../src/runtime/types.ts";
import type { Workspace } from "../src/workspace/types.ts";
import { createTempDir } from "./helpers/temp.ts";

// ---------------------------------------------------------------------------
// Fake JSON‑RPC client – scriptable notification sequences
// ---------------------------------------------------------------------------

type PendingRequest = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

interface ScriptedNotification {
  method: string;
  params: unknown;
}

class FakeCodexClient implements CodexClient {
  /** Exposed for tests to inject notifications after the handler is set. */
  notifHandler: ((msg: { method: string; params: unknown }) => void) | null = null;
  requests: Array<{ method: string; params: unknown }> = [];
  private pending = new Map<string, PendingRequest>();
  private methodCounters = new Map<string, number>();
  private _closed = false;
  stderr = "";

  /** Pre‑scripted responses keyed by (method, invocation‑index). */
  private responses = new Map<string, Map<number, unknown>>();

  /** Pre‑scripted notification sequences. */
  private notifications: ScriptedNotification[][] = [];

  setNotificationHandler(handler: ((msg: { method: string; params: unknown }) => void) | null): void {
    this.notifHandler = handler;
  }

  /** Script a response for the next call to `method`. Returns the count of scripts added. */
  addResponse(method: string, result: unknown): void {
    let map = this.responses.get(method);
    if (!map) {
      map = new Map();
      this.responses.set(method, map);
    }
    const idx = map.size;
    map.set(idx, result);
  }

  /** Add a sequence of notifications to be delivered during the next `send()`. */
  addNotificationSequence(...notifs: ScriptedNotification[]): void {
    this.notifications.push(notifs);
  }

  /** Emit the next queued notification sequence after a tick. */
  emitNextSequence(): void {
    const seq = this.notifications.shift();
    if (!seq) return;
    // Defer emission so the notification handler is already registered.
    setTimeout(() => {
      if (!this.notifHandler) return;
      for (const n of seq) {
        this.notifHandler({ method: n.method, params: n.params });
      }
    }, 0);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this._closed) throw new Error("closed");
    this.requests.push({ method, params });

    // intercept turn/interrupt to track
    if (method === "turn/interrupt") {
      // Let the caller verify via an assertion helper
      (this as Record<string, unknown>)._lastInterrupt = params;
      return {};
    }

    const map = this.responses.get(method);
    if (!map) {
      // For script-less methods (like initialize), return a default
      return {};
    }
    const count = this.methodCounters.get(method) ?? 0;
    this.methodCounters.set(method, count + 1);
    const result = map.get(count);
    if (result === undefined) {
      // No more scripted – return fallback
      return {};
    }

    // If this is turn/start, schedule the next notification sequence
    if (method === "turn/start") {
      this.emitNextSequence();
    }

    return result;
  }

  notify(_method: string, _params: unknown): void {
    // No-op in fake
  }

  async close(): Promise<void> {
    this._closed = true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function fixture() {
  const temp = await createTempDir();
  const project = join(temp.path, "project");
  const gaiaDir = join(temp.path, "home", "agents", "gaia");
  const personaDir = join(gaiaDir, "persona");
  await mkdir(personaDir, { recursive: true });
  await mkdir(join(project, ".gaia"), { recursive: true });
  await writeFile(join(personaDir, "SOUL.md"), "Soul", "utf8");
  await mkdir(join(personaDir, "memory"), { recursive: true });
  await writeFile(join(personaDir, "memory", "MEMORY.md"), "# Memory\n", "utf8");

  const agent: AgentDefinition = {
    id: "gaia",
    displayName: "Gaia",
    icon: "☀️",
    dir: gaiaDir,
    configPath: join(gaiaDir, "agent.json"),
    personaDir,
    rolesDir: join(personaDir, "roles"),
    soulPath: join(personaDir, "SOUL.md"),
    memoryDir: join(personaDir, "memory"),
    tools: [],
    harness: "codex",
    model: { provider: "openai", name: "gpt-5-codex" },
  };

  const workspace: Workspace = {
    rootDir: project,
    dir: join(project, ".gaia"),
    configPath: join(project, ".gaia", "config.json"),
    agentsOverrideDir: join(project, ".gaia", "agents"),
    roomsDir: join(project, ".gaia", "rooms"),
    globalAgentsDir: join(temp.path, "home", "agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20 },
    contextFiles: [],
    agents: { gaia: agent },
  };

  return { temp, project, workspace, agent };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("codexSandboxFor: read-only unless the agent can modify the workspace", () => {
  assert.equal(codexSandboxFor([]), "read-only");
  assert.equal(codexSandboxFor(["read"]), "read-only");
  assert.equal(codexSandboxFor(["read", "memory", "recall"]), "read-only");
  assert.equal(codexSandboxFor(["read", "write"]), "workspace-write");
  assert.equal(codexSandboxFor(["read", "edit"]), "workspace-write");
  assert.equal(codexSandboxFor(["read", "bash"]), "workspace-write");
});

test("CodexRuntime derives the thread sandbox from agent.tools", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });

    const writeAgent = { ...agent, tools: ["read", "write", "edit"] };
    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, writeAgent, new MemoryStore(), undefined, undefined, factory);
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    assert.equal((threadStart?.params as { sandbox?: string }).sandbox, "workspace-write");
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime injects room-independent memory env + token and a gaia mem pointer", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });

    const calls: Array<{ cwd: string; env: NodeJS.ProcessEnv }> = [];
    const factory: CodexClientFactory = async (cwd, env) => {
      calls.push({ cwd, env });
      return fake;
    };
    const host = {
      baseUrl: "http://127.0.0.1:9999",
      mintToken: ({ agentId, roomId }: { agentId: string; roomId: string }) => `tok:${agentId}:${roomId}`,
    };
    const memAgent = { ...agent, tools: ["read", "write", "edit", "memory"] };
    const runtime = new CodexRuntime(workspace, memAgent, new MemoryStore(), undefined, undefined, factory, host);
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    assert.equal(calls[0]?.env.GAIA_MEMORY_DIR, memAgent.memoryDir);
    assert.equal(calls[0]?.env.GAIA_AGENT_ID, "gaia");
    assert.equal(calls[0]?.env.GAIA_DAEMON_URL, "http://127.0.0.1:9999");
    // Token carries no room (room-independent memory only).
    assert.equal(calls[0]?.env.GAIA_DAEMON_TOKEN, "tok:gaia:");
    // No room env: recall/summon are intentionally unavailable under Codex.
    assert.equal(calls[0]?.env.GAIA_ROOM_DIR, undefined);

    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    assert.match((threadStart?.params as { baseInstructions: string }).baseInstructions, /gaia mem/);
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime adds no daemon token when the agent lacks the memory tool", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });

    const calls: Array<{ env: NodeJS.ProcessEnv }> = [];
    const factory: CodexClientFactory = async (_cwd, env) => {
      calls.push({ env });
      return fake;
    };
    const host = { baseUrl: "http://127.0.0.1:9999", mintToken: () => "tok" };
    const runtime = new CodexRuntime(workspace, { ...agent, tools: ["read"] }, new MemoryStore(), undefined, undefined, factory, host);
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    assert.equal(calls[0]?.env.GAIA_DAEMON_TOKEN, undefined);
    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    assert.ok(!/gaia mem/.test((threadStart?.params as { baseInstructions: string }).baseInstructions));
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime yields model-info from thread/start response", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-1" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "item/agentMessage/delta", params: { delta: "Hello" } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    assert.equal(events.length, 2); // model-info + text-delta
    assert.deepEqual(events[0], {
      type: "model-info",
      provider: "openai",
      modelId: "gpt-5-codex",
      subscription: true,
    });
    assert.deepEqual(events[1], { type: "text-delta", delta: "Hello" });
    assert.equal(runtime.modelLabel, "openai/gpt-5-codex");
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime maps reasoning deltas to thinking-start/delta/end", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-1" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "item/reasoning/textDelta", params: { itemId: "r1", delta: "Let me think...", contentIndex: 0 } },
      { method: "item/reasoning/textDelta", params: { itemId: "r1", delta: " about this.", contentIndex: 0 } },
      { method: "item/completed", params: { item: { id: "r1", type: "reasoning", summary: ["Let me think... about this."], content: [] } } },
      { method: "item/agentMessage/delta", params: { delta: "Done." } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const relevant = events.filter((e) => e.type !== "model-info");
    assert.equal(relevant.length, 5);
    assert.deepEqual(relevant[0], { type: "thinking-start" });
    assert.deepEqual(relevant[1], { type: "thinking-delta", delta: "Let me think..." });
    assert.deepEqual(relevant[2], { type: "thinking-delta", delta: " about this." });
    assert.deepEqual(relevant[3], { type: "thinking-end", content: "Let me think... about this." });
    assert.deepEqual(relevant[4], { type: "text-delta", delta: "Done." });
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime maps tool lifecycle: commandExecution start, update, end", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-1" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "item/started", params: { item: { id: "cmd-1", type: "commandExecution", command: "ls -la" }, threadId: "th-1", turnId: "turn-1", startedAtMs: 100 } },
      { method: "item/commandExecution/outputDelta", params: { itemId: "cmd-1", delta: "file1.txt\nfile2.txt\n", threadId: "th-1", turnId: "turn-1" } },
      { method: "item/completed", params: { item: { id: "cmd-1", type: "commandExecution", command: "ls -la", aggregatedOutput: "file1.txt\nfile2.txt\n", exitCode: 0, status: "completed" }, threadId: "th-1", turnId: "turn-1", completedAtMs: 200 } },
      { method: "item/agentMessage/delta", params: { delta: "Files listed." } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    const events = await collect(runtime.send({ roomId: "default", message: "list files", transcript: [] }));

    const relevant = events.filter((e) => e.type !== "model-info");
    assert.equal(relevant.length, 4);
    assert.deepEqual(relevant[0], { type: "tool-start", toolName: "ls -la", toolCallId: "cmd-1", args: { command: "ls -la" } });
    assert.deepEqual(relevant[1], { type: "tool-update", toolName: "ls -la", toolCallId: "cmd-1", partialResult: "file1.txt\nfile2.txt\n" });
    assert.deepEqual(relevant[2], { type: "tool-end", toolName: "ls -la", toolCallId: "cmd-1", result: "file1.txt\nfile2.txt\n", isError: false });
    assert.deepEqual(relevant[3], { type: "text-delta", delta: "Files listed." });
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime maps tool lifecycle: mcpToolCall start, progress, end", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-1" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "item/started", params: { item: { id: "mcp-1", type: "mcpToolCall", server: "filesystem", tool: "read_file", arguments: { path: "/tmp/x" } }, threadId: "th-1", turnId: "turn-1", startedAtMs: 100 } },
      { method: "item/mcpToolCall/progress", params: { itemId: "mcp-1", message: "Reading...", threadId: "th-1", turnId: "turn-1" } },
      { method: "item/completed", params: { item: { id: "mcp-1", type: "mcpToolCall", server: "filesystem", tool: "read_file", result: "content here", status: "completed" }, threadId: "th-1", turnId: "turn-1", completedAtMs: 200 } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    const events = await collect(runtime.send({ roomId: "default", message: "read file", transcript: [] }));

    const relevant = events.filter((e) => e.type !== "model-info");
    assert.equal(relevant.length, 3);
    assert.deepEqual(relevant[0], { type: "tool-start", toolName: "read_file", toolCallId: "mcp-1", args: { path: "/tmp/x" } });
    assert.deepEqual(relevant[1], { type: "tool-update", toolName: "read_file", toolCallId: "mcp-1", partialResult: "Reading..." });
    assert.deepEqual(relevant[2], { type: "tool-end", toolName: "read_file", toolCallId: "mcp-1", result: "content here", isError: false });
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime handles turn/completed with status failed", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-1" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "turn/completed", params: { turn: { status: "failed", error: { message: "rate limit exceeded" } } } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    await assert.rejects(
      () => collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      /rate limit exceeded/,
    );
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime handles error notification", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-1" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "error", params: { error: { message: "connection lost" }, willRetry: false, threadId: "th-1", turnId: "turn-1" } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    await assert.rejects(
      () => collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      /connection lost/,
    );
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime abort sends turn/interrupt", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-1" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    // turn/start responds but does NOT schedule turn/completed – the send() will hang
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });

    // Intercept request() to capture turn/interrupt calls
    let interruptParams: unknown = null;
    const origRequest = fake.request.bind(fake);
    fake.request = async (method, params) => {
      if (method === "turn/interrupt") {
        interruptParams = params;
        return {};
      }
      return origRequest(method, params);
    };

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    // Start send() - it will hang waiting for turn/completed
    const sendPromise = collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    // Let the turn/start call finish and the iterator enter its wait loop
    await new Promise((r) => setTimeout(r, 30));
    await runtime.abort();

    // Now complete the turn so the iterator unwinds
    if (fake.notifHandler) {
      fake.notifHandler({ method: "turn/completed", params: { turn: { status: "interrupted" } } });
    }
    await sendPromise;

    assert.ok(interruptParams, "turn/interrupt should have been called");
    assert.equal((interruptParams as Record<string, string>).threadId, "th-1");
    assert.equal((interruptParams as Record<string, string>).turnId, "turn-1");

    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime modelLabel reports configured model before first turn", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-1" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "item/agentMessage/delta", params: { delta: "ok" } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    // Before first send, modelLabel reports the configured model
    assert.equal(runtime.modelLabel, "openai/gpt-5-codex");

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    // After send, the live model label from thread/start should match
    assert.equal(runtime.modelLabel, "openai/gpt-5-codex");

    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime reuses thread across multiple turns", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-1" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    // Turn 1
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "item/agentMessage/delta", params: { delta: "First" } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );
    // Turn 2 – same thread
    fake.addResponse("turn/start", { turn: { id: "turn-2", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "item/agentMessage/delta", params: { delta: "Second" } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    const events1 = await collect(runtime.send({ roomId: "default", message: "one", transcript: [] }));
    assert.equal(events1.length, 2); // model-info + text-delta
    assert.equal(events1[1].type, "text-delta");
    assert.equal((events1[1] as { delta: string }).delta, "First");

    const events2 = await collect(runtime.send({ roomId: "default", message: "two", transcript: [] }));
    // Second turn should NOT have model-info
    assert.equal(events2.length, 1);
    assert.equal(events2[0].type, "text-delta");
    assert.equal((events2[0] as { delta: string }).delta, "Second");

    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime keeps persistent threads scoped by room", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-default" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    fake.addResponse("thread/start", {
      thread: { id: "th-other" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "item/agentMessage/delta", params: { delta: "Default one" } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );
    fake.addResponse("turn/start", { turn: { id: "turn-2", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "item/agentMessage/delta", params: { delta: "Other" } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );
    fake.addResponse("turn/start", { turn: { id: "turn-3", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "item/agentMessage/delta", params: { delta: "Default two" } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    const first = await collect(runtime.send({ roomId: "default", message: "one", transcript: [] }));
    const other = await collect(runtime.send({ roomId: "other", message: "two", transcript: [] }));
    const secondDefault = await collect(runtime.send({ roomId: "default", message: "three", transcript: [] }));

    assert.equal(first.some((event) => event.type === "model-info"), true);
    assert.equal(other.some((event) => event.type === "model-info"), true);
    assert.equal(secondDefault.some((event) => event.type === "model-info"), false);

    const threadStarts = fake.requests.filter((request) => request.method === "thread/start");
    assert.equal(threadStarts.length, 2);

    const turnStarts = fake.requests.filter((request) => request.method === "turn/start");
    assert.deepEqual(
      turnStarts.map((request) => (request.params as { threadId: string }).threadId),
      ["th-default", "th-other", "th-default"],
    );

    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime reports a clear error when codex app-server is unavailable", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const factory: CodexClientFactory = async () => {
      const error = new Error("spawn codex ENOENT") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    };
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    await assert.rejects(
      () => collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      /Codex app-server is unavailable: the `codex` CLI was not found in PATH\./,
    );
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime ignores item/completed for non-tool items (userMessage, agentMessage)", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-1" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "item/started", params: { item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] } } },
      { method: "item/completed", params: { item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] } } },
      { method: "item/started", params: { item: { type: "agentMessage", id: "a1", text: "" } } },
      { method: "item/agentMessage/delta", params: { delta: "pong" } },
      { method: "item/completed", params: { item: { type: "agentMessage", id: "a1", text: "pong" } } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    // Should contain text-delta "pong" and model-info, but NO tool events
    const toolEvents = events.filter((e) => e.type === "tool-start" || e.type === "tool-end" || e.type === "tool-update");
    assert.equal(toolEvents.length, 0, "userMessage/agentMessage item/completed must not emit tool events");

    const textDeltas = events.filter((e) => e.type === "text-delta");
    assert.equal(textDeltas.length, 1);
    assert.equal((textDeltas[0] as { delta: string }).delta, "pong");

    // Model info for initial thread + clean completion
    assert.ok(events.some((e) => e.type === "model-info"), "expected model-info event");
    assert.equal(events.length, 2); // model-info + text-delta

    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("CodexRuntime model/rerouted updates live model label", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", {
      thread: { id: "th-1" },
      model: "gpt-5-codex",
      modelProvider: "openai",
    });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence(
      { method: "model/rerouted", params: { fromModel: "gpt-5-codex", toModel: "gpt-5-mini", reason: "rate_limit", threadId: "th-1", turnId: "turn-1" } },
      { method: "item/agentMessage/delta", params: { delta: "rerouted ok" } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime(workspace, agent, new MemoryStore(), undefined, undefined, factory);

    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    assert.equal(runtime.modelLabel, "openai/gpt-5-mini");
    const modelInfos = events.filter((e) => e.type === "model-info");
    assert.equal(modelInfos.length, 2); // initial + reroute
    assert.deepEqual(modelInfos[1], { type: "model-info", provider: "openai", modelId: "gpt-5-mini", subscription: true });
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});
