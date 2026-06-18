import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition } from "../src/agents/types.ts";
import { MemoryStore } from "../src/memory/memory-store.ts";
import {
  ClaudeRuntime,
  type ClaudeProcessFactory,
  type ClaudeProcessOptions,
} from "../src/runtime/claude-runtime.ts";
import type { AgentEvent } from "../src/runtime/types.ts";
import type { Workspace } from "../src/workspace/types.ts";
import { createTempDir } from "./helpers/temp.ts";

// ---------------------------------------------------------------------------
// Fake process factory – scriptable NDJSON message sequences (one per turn)
// ---------------------------------------------------------------------------

interface Script {
  messages: unknown[];
  exit?: { code: number | null; signal: string | null };
  spawnError?: Error;
  /** When false, the fake emits messages but does not exit (drive it manually). */
  autoExit?: boolean;
}

class FakeClaude {
  readonly factory: ClaudeProcessFactory;
  readonly calls: ClaudeProcessOptions[] = [];
  killCount = 0;
  lastOptions: ClaudeProcessOptions | null = null;
  private readonly scripts: Script[] = [];

  constructor() {
    this.factory = (options) => {
      this.calls.push(options);
      this.lastOptions = options;
      const script = this.scripts.shift() ?? { messages: [], exit: { code: 0, signal: null } };
      setTimeout(() => {
        if (script.spawnError) {
          options.onError(script.spawnError);
          return;
        }
        for (const m of script.messages) options.onMessage(m);
        if (script.autoExit !== false) {
          options.onExit({ code: script.exit?.code ?? 0, signal: script.exit?.signal ?? null, stderr: "" });
        }
      }, 0);
      return {
        kill: () => {
          this.killCount++;
        },
      };
    };
  }

  script(messages: unknown[], exit?: { code: number | null; signal: string | null }): void {
    this.scripts.push({ messages, exit });
  }

  scriptOpen(messages: unknown[]): void {
    this.scripts.push({ messages, autoExit: false });
  }

  scriptSpawnError(error: Error): void {
    this.scripts.push({ messages: [], spawnError: error });
  }
}

const initMsg = (model = "claude-opus-4-8", apiKeySource = "none") => ({
  type: "system",
  subtype: "init",
  model,
  apiKeySource,
  session_id: "sess-x",
});

const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
});

const resultSuccess = (result = "ok") => ({ type: "result", subtype: "success", is_error: false, result });

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
    harness: "claude",
    model: { provider: "anthropic", name: "claude-opus-4-8" },
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

test("ClaudeRuntime yields model-info from init and text-delta from stream_event", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("Hello"), resultSuccess()]);

    const runtime = new ClaudeRuntime(workspace, agent, new MemoryStore(), undefined, undefined, fake.factory);
    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { type: "model-info", provider: "anthropic", modelId: "claude-opus-4-8", subscription: true });
    assert.deepEqual(events[1], { type: "text-delta", delta: "Hello" });
    assert.equal(runtime.modelLabel, "anthropic/claude-opus-4-8");
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("ClaudeRuntime reports subscription:false when an API key is the source", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg("claude-opus-4-8", "ANTHROPIC_API_KEY"), textDelta("hi"), resultSuccess()]);

    const runtime = new ClaudeRuntime(workspace, agent, new MemoryStore(), undefined, undefined, fake.factory);
    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const info = events.find((e) => e.type === "model-info");
    assert.deepEqual(info, { type: "model-info", provider: "anthropic", modelId: "claude-opus-4-8", subscription: false });
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("ClaudeRuntime maps thinking blocks to thinking-start/delta/end", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([
      initMsg(),
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " about it." } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } } },
      resultSuccess(),
    ]);

    const runtime = new ClaudeRuntime(workspace, agent, new MemoryStore(), undefined, undefined, fake.factory);
    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const relevant = events.filter((e) => e.type !== "model-info");

    assert.deepEqual(relevant, [
      { type: "thinking-start" },
      { type: "thinking-delta", delta: "Let me think" },
      { type: "thinking-delta", delta: " about it." },
      { type: "thinking-end" },
      { type: "text-delta", delta: "Done." },
    ]);
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("ClaudeRuntime maps tool_use (assistant) and tool_result (user) to tool-start/tool-end", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([
      initMsg(),
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/tmp/x" } }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file body", is_error: false }] },
      },
      textDelta("Read it."),
      resultSuccess(),
    ]);

    const runtime = new ClaudeRuntime(workspace, agent, new MemoryStore(), undefined, undefined, fake.factory);
    const events = await collect(runtime.send({ roomId: "default", message: "read", transcript: [] }));
    const relevant = events.filter((e) => e.type !== "model-info");

    assert.deepEqual(relevant[0], { type: "tool-start", toolName: "Read", toolCallId: "tu-1", args: { file_path: "/tmp/x" } });
    assert.deepEqual(relevant[1], { type: "tool-end", toolName: "Read", toolCallId: "tu-1", result: "file body", isError: false });
    assert.deepEqual(relevant[2], { type: "text-delta", delta: "Read it." });
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("ClaudeRuntime rejects on an error result", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), { type: "result", subtype: "error_during_execution", is_error: true, result: "rate limit exceeded" }]);

    const runtime = new ClaudeRuntime(workspace, agent, new MemoryStore(), undefined, undefined, fake.factory);
    await assert.rejects(
      () => collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      /rate limit exceeded/,
    );
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("ClaudeRuntime reports a clear error when the claude CLI is missing", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeClaude();
    const enoent = new Error("spawn claude ENOENT") as Error & { code: string };
    enoent.code = "ENOENT";
    fake.scriptSpawnError(enoent);

    const runtime = new ClaudeRuntime(workspace, agent, new MemoryStore(), undefined, undefined, fake.factory);
    await assert.rejects(
      () => collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      /Claude Code is unavailable: the `claude` CLI was not found in PATH\./,
    );
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("ClaudeRuntime uses --session-id on the first turn and --resume after, with the same id", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("one"), resultSuccess()]);
    fake.script([initMsg(), textDelta("two"), resultSuccess()]);

    const runtime = new ClaudeRuntime(workspace, agent, new MemoryStore(), undefined, undefined, fake.factory);
    await collect(runtime.send({ roomId: "default", message: "one", transcript: [] }));
    await collect(runtime.send({ roomId: "default", message: "two", transcript: [] }));

    const sessionFlagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

    const first = fake.calls[0].args;
    const second = fake.calls[1].args;
    assert.ok(first.includes("--session-id"), "first turn passes --session-id");
    assert.ok(!first.includes("--resume"), "first turn does not resume");
    assert.ok(second.includes("--resume"), "second turn passes --resume");
    assert.ok(!second.includes("--session-id"), "second turn does not pass --session-id");
    assert.equal(sessionFlagValue(first, "--session-id"), sessionFlagValue(second, "--resume"));

    // Phase 1 invariants: safe-mode isolation, custom system prompt, read-only tools, model.
    assert.ok(first.includes("--safe-mode"));
    assert.ok(first.includes("--system-prompt"));
    assert.equal(sessionFlagValue(first, "--tools"), "Read,Grep,Glob");
    assert.equal(sessionFlagValue(first, "--model"), "claude-opus-4-8");

    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("ClaudeRuntime keeps a separate session per room and restarts after a failed first turn", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeClaude();
    // room A ok, room B ok, then a failing first turn for room C, then a retry for C.
    fake.script([initMsg(), textDelta("A"), resultSuccess()]);
    fake.script([initMsg(), textDelta("B"), resultSuccess()]);
    fake.script([initMsg(), { type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }]);
    fake.script([initMsg(), textDelta("C"), resultSuccess()]);

    const runtime = new ClaudeRuntime(workspace, agent, new MemoryStore(), undefined, undefined, fake.factory);
    await collect(runtime.send({ roomId: "a", message: "x", transcript: [] }));
    await collect(runtime.send({ roomId: "b", message: "x", transcript: [] }));
    await assert.rejects(() => collect(runtime.send({ roomId: "c", message: "x", transcript: [] })), /boom/);
    await collect(runtime.send({ roomId: "c", message: "x", transcript: [] }));

    const flagValue = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const idA = flagValue(fake.calls[0].args, "--session-id");
    const idB = flagValue(fake.calls[1].args, "--session-id");
    assert.notEqual(idA, idB, "rooms get distinct session ids");

    // The failed first turn for C dropped its session, so the retry is a fresh
    // --session-id, not a --resume of a session that may not exist.
    assert.ok(fake.calls[3].args.includes("--session-id"), "retry after failed first turn starts fresh");
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("ClaudeRuntime abort kills the active process", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeClaude();
    // Open turn: emits init but never sends a result, so send() hangs.
    fake.scriptOpen([initMsg()]);

    const runtime = new ClaudeRuntime(workspace, agent, new MemoryStore(), undefined, undefined, fake.factory);
    const sendPromise = collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    await new Promise((r) => setTimeout(r, 20));
    await runtime.abort();
    assert.equal(fake.killCount, 1);

    // Unwind the iterator by completing the process.
    fake.lastOptions?.onExit({ code: 0, signal: null, stderr: "" });
    await sendPromise;
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("ClaudeRuntime modelLabel reports the configured model before the first turn", async () => {
  const { temp, workspace, agent } = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);

    const runtime = new ClaudeRuntime(workspace, agent, new MemoryStore(), undefined, undefined, fake.factory);
    assert.equal(runtime.modelLabel, "anthropic/claude-opus-4-8");
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    assert.equal(runtime.modelLabel, "anthropic/claude-opus-4-8");
    runtime.dispose();
  } finally {
    await temp.cleanup();
  }
});
