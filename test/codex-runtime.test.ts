// v2 port of test/codex-runtime.test.ts — every v1 scenario, driven through
// the injectable JSON-RPC client factory (scriptable notification sequences).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryStore } from "../src/domain/memory.js";
import { findHarness } from "../src/harness/spec.js";
import {
  CODEX_SANDBOX_MODE,
  CodexRuntime,
  type CodexClient,
  type CodexClientFactory,
} from "../src/harness/codex.js";
import { collect, harnessFixture } from "./helpers/fixture.js";
import { createTempDir } from "./helpers/temp.js";

// ---------------------------------------------------------------------------
// Fake JSON-RPC client – scriptable notification sequences
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
  /** Exposed for tests to drive server-initiated requests (item/tool/call). */
  requestHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  requests: Array<{ method: string; params: unknown }> = [];
  private pending = new Map<string, PendingRequest>();
  private methodCounters = new Map<string, number>();
  private _closed = false;
  stderr = "";

  /** Pre-scripted responses keyed by (method, invocation-index). */
  private responses = new Map<string, Map<number, unknown>>();

  /** Pre-scripted notification sequences. */
  private notifications: ScriptedNotification[][] = [];

  setNotificationHandler(handler: ((msg: { method: string; params: unknown }) => void) | null): void {
    this.notifHandler = handler;
  }

  setRequestHandler(handler: ((method: string, params: unknown) => Promise<unknown>) | null): void {
    this.requestHandler = handler;
  }

  /** Script a response for the next call to `method`. */
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

    // turn/start and thread/compact/start each complete via a deferred
    // notification sequence — release the next sequence.
    if (method === "turn/start" || method === "thread/compact/start") {
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

const fixture = () => harnessFixture({ tools: [], harness: "codex", model: { provider: "openai", name: "gpt-5-codex" } });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("codex defers confinement to the host sandbox (always danger-full-access)", () => {
  assert.equal(CODEX_SANDBOX_MODE, "danger-full-access");
});

test("CodexRuntime runs the thread at danger-full-access regardless of agent.tools", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });

    const writeAgent = { ...fx.agent, tools: ["read", "write", "edit"] };
    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: writeAgent, memoryStore: new MemoryStore(), clientFactory: factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    assert.equal((threadStart?.params as { sandbox?: string }).sandbox, "danger-full-access");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime enables native web_search on thread/start when the agent has the web tool", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });

    const webAgent = { ...fx.agent, tools: ["read", "web"] };
    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: webAgent, memoryStore: new MemoryStore(), clientFactory: factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    const config = (threadStart?.params as { config?: { tools?: { web_search?: boolean } } }).config;
    assert.equal(config?.tools?.web_search, true);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime omits web_search config without the web tool", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });

    const noWebAgent = { ...fx.agent, tools: ["read", "write"] };
    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: noWebAgent, memoryStore: new MemoryStore(), clientFactory: factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    const config = (threadStart?.params as { config?: { tools?: { web_search?: boolean } } }).config;
    assert.equal(config?.tools?.web_search, undefined);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime declares gaia dynamic tools on thread/start and answers item/tool/call", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });

    const factory: CodexClientFactory = async () => fake;
    const store = new MemoryStore();
    const toolAgent = { ...fx.agent, tools: ["read", "memory", "recall"] };
    await store.init(toolAgent.memoryDir, toolAgent.displayName);
    const runtime = new CodexRuntime({
      workspace: fx.workspace,
      agent: toolAgent,
      memoryStore: store,
      clientFactory: factory,
      recallSearch: async () => [{ kind: "fact" as const, text: "walrus-9 runs FreeBSD", ts: "2026-07-01T00:00:00Z", score: 1, source: "user_stated" }],
    });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    // The same tool factories Pi wires in-process, declared as dynamicTools.
    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    const dynamicTools = (threadStart?.params as { dynamicTools?: Array<{ type: string; name: string; inputSchema?: { type?: string } }> }).dynamicTools;
    assert.deepEqual(dynamicTools?.map((tool) => tool.name).sort(), ["memory", "recall"]);
    assert.ok(dynamicTools?.every((tool) => tool.type === "function" && tool.inputSchema?.type === "object"));
    // No CLI pointer: dynamic tools are self-describing.
    assert.ok(!/gaia mem/.test((threadStart?.params as { baseInstructions: string }).baseInstructions));

    // Server-initiated item/tool/call executes the tool in-process.
    const result = (await fake.requestHandler?.("item/tool/call", {
      threadId: "th-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "recall",
      arguments: { query: "walrus" },
    })) as { success: boolean; contentItems: Array<{ type: string; text: string }> };
    assert.equal(result.success, true);
    assert.match(result.contentItems[0].text, /walrus-9 runs FreeBSD/);

    const unknown = (await fake.requestHandler?.("item/tool/call", {
      threadId: "th-1",
      turnId: "turn-1",
      callId: "call-2",
      tool: "nonexistent",
      arguments: {},
    })) as { success: boolean; contentItems: Array<{ type: string; text: string }> };
    assert.equal(unknown.success, false);
    assert.match(unknown.contentItems[0].text, /Unknown tool/);

    // Other server requests stay unsupported.
    await assert.rejects(() => fake.requestHandler!("applyPatchApproval", {}), /Unsupported server request/);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime inherits the runner env untouched; no dynamic tools without gaia tools", async () => {
  const fx = await fixture();
  // The gaia bridge env is composed ONCE by RunnerHost.buildEnv (see
  // runner-host-proxy.test.ts) and reaches this runtime as process.env inside
  // the runner subprocess — the app-server child must inherit it, never a
  // re-composed per-harness copy.
  const bridgeEnv = {
    GAIA_MEMORY_DIR: fx.agent.memoryDir,
    GAIA_AGENT_ID: "gaia",
    GAIA_DAEMON_URL: "http://127.0.0.1:9999",
    GAIA_DAEMON_TOKEN: "tok:gaia:default",
  };
  const previous = Object.fromEntries(Object.keys(bridgeEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, bridgeEnv);
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
    const memAgent = { ...fx.agent, tools: ["read", "write", "edit", "memory"] };
    const store = new MemoryStore();
    await store.init(memAgent.memoryDir, memAgent.displayName);
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: memAgent, memoryStore: store, clientFactory: factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    for (const [key, value] of Object.entries(bridgeEnv)) assert.equal(calls[0]?.env[key], value, `${key} inherited as-is`);
    runtime.dispose();

    // An agent without gaia tools declares no dynamicTools at all.
    const fake2 = new FakeCodexClient();
    fake2.addResponse("initialize", {});
    fake2.addResponse("thread/start", { thread: { id: "th-2" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake2.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake2.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const bare = new CodexRuntime({
      workspace: fx.workspace,
      agent: { ...fx.agent, tools: ["read"] },
      memoryStore: new MemoryStore(),
      clientFactory: async () => fake2,
    });
    await collect(bare.send({ roomId: "bare", message: "hi", transcript: [] }));
    const threadStart = fake2.requests.find((request) => request.method === "thread/start");
    assert.equal((threadStart?.params as { dynamicTools?: unknown[] }).dynamicTools, undefined);
    bare.dispose();
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : (process.env[key] = value);
    await fx.cleanup();
  }
});

test("CodexRuntime always requests detailed reasoning summaries — not a per-agent option", async () => {
  const fx = await fixture();
  try {
    // First life: thread/start.
    const fake1 = new FakeCodexClient();
    fake1.addResponse("initialize", {});
    fake1.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake1.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake1.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const first = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: async () => fake1 });
    await collect(first.send({ roomId: "default", message: "hi", transcript: [] }));
    const threadStart = fake1.requests.find((request) => request.method === "thread/start");
    assert.equal(
      (threadStart?.params as { config?: { model_reasoning_summary?: string } }).config?.model_reasoning_summary,
      "detailed",
    );
    first.dispose();

    // Second life: thread/resume must carry the same override — without it,
    // the Responses API returns reasoning items with an EMPTY summary (a live
    // rollout showed 28/28 empty), leaving the room with tool-call rows and
    // zero commentary in between.
    const fake2 = new FakeCodexClient();
    fake2.addResponse("initialize", {});
    fake2.addResponse("thread/resume", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake2.addResponse("turn/start", { turn: { id: "turn-2", status: "inProgress" } });
    fake2.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const second = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: async () => fake2 });
    await collect(second.send({ roomId: "default", message: "hi again", transcript: [] }));
    const resume = fake2.requests.find((request) => request.method === "thread/resume");
    assert.equal(
      (resume?.params as { config?: { model_reasoning_summary?: string } }).config?.model_reasoning_summary,
      "detailed",
    );
    second.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime maps agent.thinking to turn/start.effort, honoring a per-turn override", async () => {
  const fx = await harnessFixture({ tools: [], harness: "codex", model: { provider: "openai", name: "gpt-5-codex" }, thinking: "high" });
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: async () => fake });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const turnStart = fake.requests.find((request) => request.method === "turn/start");
    assert.equal((turnStart?.params as { effort?: string }).effort, "high");
    // Sent on every turn/start, not just thread/start's config override — a
    // live rollout showed the thread-level config alone doesn't stick (see
    // send()'s comment): turn_context.summary resolved to "auto" without this.
    assert.equal((turnStart?.params as { summary?: string }).summary, "detailed");

    // A per-turn override (e.g. voice forcing thinking off) wins over the
    // agent's configured level, exactly like claude.ts's thinkingOverride.
    fake.addResponse("turn/start", { turn: { id: "turn-2", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    await collect(runtime.send({ roomId: "default", message: "hi again", transcript: [], thinking: "low" }));
    const turnStart2 = fake.requests.filter((request) => request.method === "turn/start")[1];
    assert.equal((turnStart2?.params as { effort?: string }).effort, "low");
    assert.equal((turnStart2?.params as { summary?: string }).summary, "detailed");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime passes configured MCP servers as per-thread config overrides", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });

    fx.workspace.config.mcpServers = { linear: { url: "https://mcp.linear.app/sse" } };
    const mcpAgent = { ...fx.agent, mcpServers: { fs: { command: "npx", args: ["-y", "server-filesystem"], env: { ROOT: "/tmp" } } } };
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: mcpAgent, memoryStore: new MemoryStore(), clientFactory: async () => fake });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    const config = (threadStart?.params as { config?: { mcp_servers: Record<string, Record<string, unknown>> } }).config;
    assert.deepEqual(config?.mcp_servers, {
      linear: { url: "https://mcp.linear.app/sse" },
      fs: { command: "npx", args: ["-y", "server-filesystem"], env: { ROOT: "/tmp" } },
    });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime resumes a persisted thread after restart; failed resume starts fresh", async () => {
  const fx = await fixture();
  try {
    // First life: start a thread, run a turn, dispose (daemon/runner restart).
    const fake1 = new FakeCodexClient();
    fake1.addResponse("initialize", {});
    fake1.addResponse("thread/start", { thread: { id: "th-persist" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake1.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake1.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const first = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: async () => fake1 });
    await collect(first.send({ roomId: "default", message: "one", transcript: [] }));
    first.dispose();

    // Second life: the persisted thread is resumed, not restarted.
    const fake2 = new FakeCodexClient();
    fake2.addResponse("initialize", {});
    fake2.addResponse("thread/resume", { thread: { id: "th-persist" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake2.addResponse("turn/start", { turn: { id: "turn-2", status: "inProgress" } });
    fake2.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const second = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: async () => fake2 });
    await collect(second.send({ roomId: "default", message: "two", transcript: [] }));
    const resume = fake2.requests.find((request) => request.method === "thread/resume");
    assert.equal((resume?.params as { threadId: string }).threadId, "th-persist");
    assert.equal(fake2.requests.some((request) => request.method === "thread/start"), false);
    second.dispose();

    // Third life: the rollout is gone — resume fails, a fresh thread starts.
    const fake3 = new FakeCodexClient();
    fake3.addResponse("initialize", {});
    fake3.addResponse("thread/start", { thread: { id: "th-fresh" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake3.addResponse("turn/start", { turn: { id: "turn-3", status: "inProgress" } });
    fake3.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const origRequest = fake3.request.bind(fake3);
    fake3.request = async (method, params) => {
      if (method === "thread/resume") throw new Error("no rollout found for thread id th-persist");
      return origRequest(method, params);
    };
    const third = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: async () => fake3 });
    await collect(third.send({ roomId: "default", message: "three", transcript: [] }));
    const starts = fake3.requests.filter((request) => request.method === "thread/start");
    assert.equal(starts.length, 1);
    const turnStart = fake3.requests.find((request) => request.method === "turn/start");
    assert.equal((turnStart?.params as { threadId: string }).threadId, "th-fresh");
    third.dispose();

    // /clear forgets the persisted handle: the next life starts fresh.
    const fake4 = new FakeCodexClient();
    fake4.addResponse("initialize", {});
    fake4.addResponse("thread/start", { thread: { id: "th-clear" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake4.addResponse("turn/start", { turn: { id: "turn-4", status: "inProgress" } });
    fake4.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const fourth = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: async () => fake4 });
    fourth.resetRoom("default");
    await collect(fourth.send({ roomId: "default", message: "four", transcript: [] }));
    assert.equal(fake4.requests.some((request) => request.method === "thread/resume"), false);
    assert.equal(fake4.requests.some((request) => request.method === "thread/start"), true);
    fourth.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime.compact resumes a cold (unattached) persisted thread before compacting", async () => {
  const fx = await fixture();
  try {
    // First life: start a thread + run a turn, then dispose (daemon/runner restart).
    const fake1 = new FakeCodexClient();
    fake1.addResponse("initialize", {});
    fake1.addResponse("thread/start", { thread: { id: "th-persist" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake1.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake1.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const first = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: async () => fake1 });
    await collect(first.send({ roomId: "default", message: "one", transcript: [] }));
    first.dispose();

    // Second life: a cold process. /compact arrives with NO turn since restart,
    // so the thread is persisted-but-unattached. It must resume then compact —
    // not bail with "nothing to compact".
    const fake2 = new FakeCodexClient();
    fake2.addResponse("initialize", {});
    fake2.addResponse("thread/resume", { thread: { id: "th-persist" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake2.addResponse("thread/compact/start", {});
    fake2.addNotificationSequence(
      { method: "turn/started", params: { threadId: "th-persist", turn: { id: "compact-turn", status: "inProgress" } } },
      {
        method: "thread/tokenUsage/updated",
        params: { threadId: "th-persist", tokenUsage: { last: { totalTokens: 512 }, modelContextWindow: 258400 } },
      },
      { method: "item/completed", params: { threadId: "th-persist", item: { type: "contextCompaction" } } },
      { method: "turn/completed", params: { threadId: "th-persist", turn: { status: "completed" } } },
    );
    const second = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: async () => fake2 });
    const progress: number[] = [];
    const result = await second.compact("default", (update) => {
      if (typeof update.outputTokens === "number") progress.push(update.outputTokens);
    });

    assert.equal(result.compacted, true);
    assert.deepEqual(progress, [512], "codex compaction streams the post-compact token count");
    assert.equal(fake2.requests.some((request) => request.method === "thread/resume"), true);
    const compactReq = fake2.requests.find((request) => request.method === "thread/compact/start");
    assert.equal((compactReq?.params as { threadId: string }).threadId, "th-persist");
    second.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime.compact returns the no-op when the room has no persisted thread", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeCodexClient();
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: async () => fake });
    const result = await runtime.compact("never-used-room");
    assert.equal(result.compacted, false);
    // No app-server should have been spawned for an empty room.
    assert.equal(fake.requests.length, 0);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime yields model-info from thread/start response", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    assert.equal(events.length, 2); // model-info + text-delta
    assert.deepEqual(events[0], {
      type: "model-info",
      provider: "openai",
      modelId: "gpt-5-codex",
      subscription: true,
    });
    assert.deepEqual(events[1], { type: "text-delta", delta: "Hello" });
    // Live label = the shared liveModelLabel derivation (subscription:true ⇒
    // oauth suffix) — the same label RunnerHost derives from this model-info.
    assert.equal(runtime.modelLabel, "openai/gpt-5-codex (oauth)");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime maps reasoning deltas to thinking-start/delta/end", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

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
    await fx.cleanup();
  }
});

test("CodexRuntime maps tool lifecycle: commandExecution start, update, end", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

    const events = await collect(runtime.send({ roomId: "default", message: "list files", transcript: [] }));

    const relevant = events.filter((e) => e.type !== "model-info");
    assert.equal(relevant.length, 4);
    assert.deepEqual(relevant[0], { type: "tool-start", toolName: "ls -la", toolCallId: "cmd-1", args: { command: "ls -la" } });
    assert.deepEqual(relevant[1], { type: "tool-update", toolName: "ls -la", toolCallId: "cmd-1", partialResult: "file1.txt\nfile2.txt\n" });
    assert.deepEqual(relevant[2], { type: "tool-end", toolName: "ls -la", toolCallId: "cmd-1", result: "file1.txt\nfile2.txt\n", isError: false });
    assert.deepEqual(relevant[3], { type: "text-delta", delta: "Files listed." });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime preserves a failed command's diagnostic when app-server has no output", async () => {
  const fx = await fixture();
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
      { method: "item/started", params: { item: { id: "cmd-fail", type: "commandExecution", command: "gaia mem batch" } } },
      {
        method: "item/completed",
        params: {
          item: {
            id: "cmd-fail",
            type: "commandExecution",
            command: "gaia mem batch",
            aggregatedOutput: "",
            exitCode: 1,
            error: { message: "replacement target was not found" },
          },
        },
      },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    );

    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });
    const events = await collect(runtime.send({ roomId: "default", message: "update memory", transcript: [] }));
    const failed = events.find((event) => event.type === "tool-end");

    assert.deepEqual(failed, {
      type: "tool-end",
      toolName: "gaia mem batch",
      toolCallId: "cmd-fail",
      result: "replacement target was not found\nCommand exited with status 1.",
      isError: true,
    });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime maps tool lifecycle: mcpToolCall start, progress, end", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

    const events = await collect(runtime.send({ roomId: "default", message: "read file", transcript: [] }));

    const relevant = events.filter((e) => e.type !== "model-info");
    assert.equal(relevant.length, 3);
    assert.deepEqual(relevant[0], { type: "tool-start", toolName: "read_file", toolCallId: "mcp-1", args: { path: "/tmp/x" } });
    assert.deepEqual(relevant[1], { type: "tool-update", toolName: "read_file", toolCallId: "mcp-1", partialResult: "Reading..." });
    assert.deepEqual(relevant[2], { type: "tool-end", toolName: "read_file", toolCallId: "mcp-1", result: "content here", isError: false });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime handles turn/completed with status failed", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

    await assert.rejects(
      () => collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      /rate limit exceeded/,
    );
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime handles error notification", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

    await assert.rejects(
      () => collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      /connection lost/,
    );
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime abort sends turn/interrupt", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

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
    await fx.cleanup();
  }
});

test("CodexRuntime modelLabel reports configured model before first turn", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

    // Before first send, modelLabel reports the configured model
    assert.equal(runtime.modelLabel, "openai/gpt-5-codex");

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    // After send, the live model label from thread/start (oauth suffix included).
    assert.equal(runtime.modelLabel, "openai/gpt-5-codex (oauth)");

    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime reuses thread across multiple turns", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

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
    await fx.cleanup();
  }
});

test("CodexRuntime keeps persistent threads scoped by room", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

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
    await fx.cleanup();
  }
});

test("CodexRuntime reports a clear error when codex app-server is unavailable", async () => {
  const fx = await fixture();
  try {
    const factory: CodexClientFactory = async () => {
      const error = new Error("spawn codex ENOENT") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    };
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

    await assert.rejects(
      () => collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      /Codex app-server is unavailable: the `codex` CLI was not found in PATH\./,
    );
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime ignores item/completed for non-tool items (userMessage, agentMessage)", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

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
    await fx.cleanup();
  }
});

test("CodexRuntime model/rerouted updates live model label", async () => {
  const fx = await fixture();
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
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: factory });

    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    assert.equal(runtime.modelLabel, "openai/gpt-5-mini (oauth)");
    const modelInfos = events.filter((e) => e.type === "model-info");
    assert.equal(modelInfos.length, 2); // initial + reroute
    assert.deepEqual(modelInfos[1], { type: "model-info", provider: "openai", modelId: "gpt-5-mini", subscription: true });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime sends memory in the turn prompt only when it changed", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    fake.addResponse("turn/start", { turn: { id: "turn-2", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });
    fake.addResponse("turn/start", { turn: { id: "turn-3", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });

    const store = new MemoryStore();
    const factory: CodexClientFactory = async () => fake;
    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: store, clientFactory: factory });

    const turnText = (index: number): string => {
      const turnStarts = fake.requests.filter((request) => request.method === "turn/start");
      return (turnStarts[index].params as { input: Array<{ text: string }> }).input[0].text;
    };

    await collect(runtime.send({ roomId: "default", message: "one", transcript: [] }));
    await collect(runtime.send({ roomId: "default", message: "two", transcript: [] }));
    assert.match(turnText(0), /# Your persistent memory/);
    assert.doesNotMatch(turnText(1), /# Your persistent memory/);

    // A memory write flows into the NEXT turn prompt on the same thread.
    await store.mutate(fx.agent.memoryDir, "MEMORY.md", "add", { content: "user prefers tabs" });
    await collect(runtime.send({ roomId: "default", message: "three", transcript: [] }));
    assert.match(turnText(2), /user prefers tabs/);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("CodexRuntime attaches pasted images as localImage input items", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeCodexClient();
    fake.addResponse("initialize", {});
    fake.addResponse("thread/start", { thread: { id: "th-1" }, model: "gpt-5-codex", modelProvider: "openai" });
    fake.addResponse("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
    fake.addNotificationSequence({ method: "turn/completed", params: { turn: { status: "completed" } } });

    const runtime = new CodexRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), clientFactory: async () => fake });
    await collect(
      runtime.send({
        roomId: "default",
        message: "look",
        transcript: [],
        attachments: [
          { name: "shot.png", mime: "image/png", size: 4, path: "/tmp/room-files/shot.png" },
          // Non-image files stay breadcrumb-only — codex has no file item type.
          { name: "notes.pdf", mime: "application/pdf", size: 9, path: "/tmp/room-files/notes.pdf" },
        ],
      }),
    );

    const turnStart = fake.requests.find((request) => request.method === "turn/start");
    const input = (turnStart?.params as { input: Array<Record<string, unknown>> }).input;
    assert.equal(input[0].type, "text");
    assert.match(String(input[0].text), /\[attached file: shot\.png/);
    assert.match(String(input[0].text), /\[attached file: notes\.pdf/);
    assert.deepEqual(input.slice(1), [{ type: "localImage", path: "/tmp/room-files/shot.png" }]);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// hasDurableSession — a persisted ThreadState is what thread/resume restores;
// without it a deep cursor's history is gone and the turn loop must replay it
// ---------------------------------------------------------------------------

test("hasDurableSession: true iff a thread handle is persisted for (room, agent)", async () => {
  const temp = await createTempDir();
  try {
    const spec = findHarness("codex")!;
    const roomDir = join(temp.path, ".gaia", "rooms", "default");
    await mkdir(roomDir, { recursive: true });

    assert.equal(spec.hasDurableSession!(temp.path, "default", "terry"), false, "no sessions file");

    await writeFile(
      join(roomDir, "harness-sessions.json"),
      JSON.stringify({ "codex:terry": { threadId: "t1", model: "gpt-5.2-codex", modelProvider: "openai-codex" } }),
      "utf8",
    );
    assert.equal(spec.hasDurableSession!(temp.path, "default", "terry"), true);
    assert.equal(spec.hasDurableSession!(temp.path, "default", "other"), false, "someone else's thread doesn't count");
    assert.equal(spec.hasDurableSession!(temp.path, "another-room", "terry"), false, "per room");
  } finally {
    await temp.cleanup();
  }
});
