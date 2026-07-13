// v2 port of test/pi-runtime.test.ts — every v1 scenario, driven through the
// injectable sessionFactory against the REAL MemoryStore + prompt assembly.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryStore } from "../src/domain/memory.js";
import { findHarness, type SummonCreate } from "../src/harness/spec.js";
import { PiRuntime, piRoomSessionDir, type PiRuntimeSessionFactory, type PiSessionLike } from "../src/harness/pi.js";
import { collect, harnessFixture } from "./helpers/fixture.js";
import { createTempDir } from "./helpers/temp.js";

class FakeSession implements PiSessionLike {
  readonly sessionId: string;
  model: { provider: string; id: string } | undefined;
  listeners: Array<(event: any) => void> = [];
  prompts: string[] = [];
  promptOptions: Array<{ source?: string; images?: { type: string; data: string; mimeType: string }[] } | undefined> = [];
  disposed = false;
  reloads = 0;
  aborts = 0;
  thinkingLevel = "medium";
  thinkingChanges: string[] = [];
  /** Optional per-test native compaction (PiSessionLike.compact). */
  compact?: (customInstructions?: string) => Promise<{ summary: string; tokensBefore: number; estimatedTokensAfter?: number }>;

  constructor(id: string) {
    this.sessionId = id;
  }

  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
    this.thinkingChanges.push(level);
  }

  subscribe(listener: (event: any) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }

  async prompt(text: string, options?: { source?: "interactive"; images?: { type: "image"; data: string; mimeType: string }[] }): Promise<void> {
    this.prompts.push(text);
    this.promptOptions.push(options);
    for (const listener of this.listeners) {
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
    }
  }

  async reload(): Promise<void> {
    this.reloads += 1;
  }

  async abort(): Promise<void> {
    this.aborts += 1;
  }

  dispose(): void {
    this.disposed = true;
  }
}

test("pi room session directory is scoped by room and agent", async () => {
  const temp = await createTempDir();
  try {
    assert.equal(
      piRoomSessionDir({ rootDir: temp.path }, "default", "gaia"),
      join(temp.path, ".gaia", "rooms", "default", "pi-sessions", "gaia"),
    );
  } finally {
    await temp.cleanup();
  }
});

test("PiRuntime reuses one persistent session for repeated room-agent turns", async () => {
  const fx = await harnessFixture();
  try {
    const sessions: FakeSession[] = [];
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession(`s${sessions.length + 1}`);
      sessions.push(session);
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    assert.deepEqual(await collect(runtime.send({ roomId: "default", message: "one", transcript: [] })), [{ type: "text-delta", delta: "ok" }]);
    assert.deepEqual(await collect(runtime.send({ roomId: "default", message: "two", transcript: [] })), [{ type: "text-delta", delta: "ok" }]);

    assert.equal(sessions.length, 1);
    runtime.dispose();
    assert.equal(sessions[0].disposed, true);
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime exposes summon as a custom tool when enabled", async () => {
  const fx = await harnessFixture({ tools: ["summon"] });
  try {
    let customTools: any[] = [];
    const calls: Array<{ roomId: string; agentId: string; task: string }> = [];
    const factory: PiRuntimeSessionFactory = async (options) => {
      customTools = options.customTools as any[];
      return { session: new FakeSession("s1") };
    };
    // The live summon tool (services/tools-pi.ts) calls summonCreate with
    // { roomId, agentId, task } and renders the result as a string.
    const summonCreate: SummonCreate = async (params) => {
      calls.push(params);
      return "summon complete";
    };
    const worker = { ...fx.agent, id: "sidia", displayName: "Sidia" };
    const workspace = { ...fx.workspace, agents: { gaia: fx.agent, sidia: worker } };
    const runtime = new PiRuntime({
      workspace,
      agent: fx.agent,
      memoryStore: new MemoryStore(),
      sessionFactory: factory,
      summonCreate,
    });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    assert.equal(customTools.length, 1);
    assert.equal(customTools[0].name, "summon");
    assert.match(customTools[0].description, /Available agents: gaia, sidia/);
    assert.deepEqual(customTools[0].parameters.properties.agent.enum, ["gaia", "sidia"]);
    assert.deepEqual(customTools[0].parameters.properties.whales.items.properties.agent.enum, ["gaia", "sidia"]);
    const result = await customTools[0].execute("call_1", { agent: "sidia", task: "map routes" });
    assert.deepEqual(calls, [{ roomId: "default", agentId: "sidia", task: "map routes" }]);
    assert.deepEqual(result.content, [{ type: "text", text: "summon complete" }]);
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime surfaces provider failures encoded as error-final messages", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession("s1");
      session.prompt = async () => {
        for (const listener of session.listeners) {
          listener({
            type: "message_end",
            message: { role: "assistant", content: [], stopReason: "error", errorMessage: "You have hit your usage limit." },
          });
        }
      };
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await assert.rejects(
      () => collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      /usage limit/,
    );
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime treats aborted-final messages as non-fatal", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession("s1");
      session.prompt = async () => {
        for (const listener of session.listeners) {
          listener({
            type: "message_end",
            message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted." },
          });
        }
      };
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    assert.deepEqual(await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })), []);
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime reloads an existing session when prompt changes but skills do not", async () => {
  const fx = await harnessFixture();
  try {
    const sessions: FakeSession[] = [];
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession(`s${sessions.length + 1}`);
      sessions.push(session);
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "one", transcript: [], activeRole: { name: "plan", prompt: "A", skills: [], diagnostics: [] } }));
    await collect(runtime.send({ roomId: "default", message: "two", transcript: [], activeRole: { name: "plan", prompt: "B", skills: [], diagnostics: [] } }));

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].reloads, 1);
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime reports the session's actual model as a model-info event", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession("s1");
      session.model = { provider: "fake-provider", id: "fake-model" };
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    const events = await collect(runtime.send({ roomId: "default", message: "one", transcript: [] }));
    assert.deepEqual(events[0], { type: "model-info", provider: "fake-provider", modelId: "fake-model", subscription: false });
    assert.equal(runtime.modelLabel, "fake-provider/fake-model");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime applies a per-turn thinking override and restores the base level after", async () => {
  const fx = await harnessFixture();
  try {
    let created: FakeSession | undefined;
    const factory: PiRuntimeSessionFactory = async () => {
      created = new FakeSession("s1");
      return { session: created };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    // Voice turn forces thinking off.
    await collect(runtime.send({ roomId: "default", message: "one", transcript: [], channel: "voice", thinking: "off" }));
    assert.equal(created?.thinkingLevel, "off");

    // The next plain turn restores the session's own level.
    await collect(runtime.send({ roomId: "default", message: "two", transcript: [] }));
    assert.equal(created?.thinkingLevel, "medium");
    assert.deepEqual(created?.thinkingChanges, ["off", "medium"]);

    // No redundant set calls when the level already matches.
    await collect(runtime.send({ roomId: "default", message: "three", transcript: [] }));
    assert.deepEqual(created?.thinkingChanges, ["off", "medium"]);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime recreates a session when active role skill paths change", async () => {
  const fx = await harnessFixture();
  try {
    await mkdir(join(fx.home, "skills", "a"), { recursive: true });
    await mkdir(join(fx.home, "skills", "b"), { recursive: true });
    await writeFile(join(fx.home, "skills", "a", "SKILL.md"), "# A\n", "utf8");
    await writeFile(join(fx.home, "skills", "b", "SKILL.md"), "# B\n", "utf8");

    const sessions: FakeSession[] = [];
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession(`s${sessions.length + 1}`);
      sessions.push(session);
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "one", transcript: [], activeRole: { name: "a", prompt: "A", skills: ["a"], diagnostics: [] } }));
    await collect(runtime.send({ roomId: "default", message: "two", transcript: [], activeRole: { name: "b", prompt: "B", skills: ["b"], diagnostics: [] } }));

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].disposed, true);
    assert.equal(sessions[1].disposed, false);
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime sends memory in the turn prompt only when it changed", async () => {
  const fx = await harnessFixture();
  try {
    const sessions: FakeSession[] = [];
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession(`s${sessions.length + 1}`);
      sessions.push(session);
      return { session };
    };
    const store = new MemoryStore();
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: store, sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "one", transcript: [] }));
    await collect(runtime.send({ roomId: "default", message: "two", transcript: [] }));
    assert.match(sessions[0].prompts[0], /# Your persistent memory/);
    assert.doesNotMatch(sessions[0].prompts[1], /# Your persistent memory/);

    // A memory write flows into the NEXT turn prompt without a session reload.
    await store.mutate(fx.agent.memoryDir, "MEMORY.md", "add", { content: "user prefers tabs" });
    await collect(runtime.send({ roomId: "default", message: "three", transcript: [] }));
    assert.match(sessions[0].prompts[2], /user prefers tabs/);
    assert.equal(sessions.length, 1);

    // The diff dies with the session: a reset room re-receives memory.
    runtime.resetRoom("default");
    await collect(runtime.send({ roomId: "default", message: "four", transcript: [] }));
    assert.equal(sessions.length, 2);
    assert.match(sessions[1].prompts[0], /# Your persistent memory/);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.compact surfaces the SDK's summary for durable compaction", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession("s1");
      session.compact = async () => ({ summary: "the story so far", tokensBefore: 1000, estimatedTokensAfter: 100 });
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    // No session yet: the uniform clean no-op, no summary.
    assert.deepEqual(await runtime.compact("default"), { compacted: false, message: "nothing to compact — no active session for this room." });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const result = await runtime.compact("default");
    assert.equal(result.compacted, true);
    assert.match(result.message, /1000 tokens before → ~100/);
    // The SDK summary rides back on CompactResult so the daemon persists it
    // (durable compaction) — pi's session.compact() always returns one.
    assert.equal(result.summary, "the story so far");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime feeds pasted images to the SDK's native channel and breadcrumbs every file", async () => {
  const fx = await harnessFixture();
  try {
    const imagePath = join(fx.project, "shot.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(imagePath, bytes);

    const sessions: FakeSession[] = [];
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession("s1");
      sessions.push(session);
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });
    await collect(
      runtime.send({
        roomId: "default",
        message: "what is this?",
        transcript: [],
        attachments: [
          { name: "shot.png", mime: "image/png", size: bytes.length, path: imagePath },
          // Non-image: breadcrumb only, no native channel.
          { name: "notes.csv", mime: "text/csv; charset=utf-8", size: 5, path: join(fx.project, "notes.csv") },
        ],
      }),
    );

    const session = sessions[0];
    assert.deepEqual(session.promptOptions[0]?.images, [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }]);
    // The uniform prompt breadcrumbs list BOTH files with their on-disk paths.
    assert.match(session.prompts[0], /\[attached file: shot\.png \(image\/png, 4 B\) at /);
    assert.match(session.prompts[0], /\[attached file: notes\.csv /);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// hasDurableSession — pi self-persists sessions as files under the room's
// pi-sessions/<agent>/ dir; any file there is what continueRecent resumes
// ---------------------------------------------------------------------------

test("hasDurableSession: true iff the room's pi session dir holds a session file", async () => {
  const temp = await createTempDir();
  try {
    const spec = findHarness("pi")!;
    assert.equal(spec.hasDurableSession!(temp.path, "default", "gaia"), false, "no session dir yet");

    const dir = piRoomSessionDir({ rootDir: temp.path }, "default", "gaia");
    await mkdir(dir, { recursive: true });
    assert.equal(spec.hasDurableSession!(temp.path, "default", "gaia"), false, "empty dir ⇒ nothing to resume");

    await writeFile(join(dir, "session-1.jsonl"), "{}\n", "utf8");
    assert.equal(spec.hasDurableSession!(temp.path, "default", "gaia"), true);
    assert.equal(spec.hasDurableSession!(temp.path, "default", "sidia"), false, "per agent");
  } finally {
    await temp.cleanup();
  }
});
