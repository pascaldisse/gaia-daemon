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
  /** Per-test fixture for PiSessionLike.getUserMessagesForForking. */
  userMessagesForForking: Array<{ entryId: string; text: string }> = [];
  /** Per-test fixture: entryId -> parentId (undefined entry = "no such
   * entry"; null parentId = "first message in the session"), consumed by
   * PiSessionLike.sessionManager.getEntry(). */
  entryParents = new Map<string, string | null>();
  /** PiSessionLike.sessionManager.getSessionFile() fixture. */
  sessionFile: string | undefined = "fake-session/original.jsonl";
  createBranchedSessionCalls: string[] = [];
  newSessionCalls: Array<{ parentSession?: string } | undefined> = [];
  /** Per-test override: what createBranchedSession/newSession "write" —
   * undefined simulates a non-persisted session (can't fork). */
  forkedSessionFile: string | undefined = "fake-session/branch.jsonl";

  readonly sessionManager = {
    getEntry: (id: string): { parentId: string | null | undefined } | undefined =>
      this.entryParents.has(id) ? { parentId: this.entryParents.get(id) ?? null } : undefined,
    getSessionFile: (): string | undefined => this.sessionFile,
    createBranchedSession: (targetLeafId: string): string | undefined => {
      this.createBranchedSessionCalls.push(targetLeafId);
      return this.forkedSessionFile;
    },
    newSession: (options?: { parentSession?: string }): string | undefined => {
      this.newSessionCalls.push(options);
      return this.forkedSessionFile;
    },
  };

  constructor(id: string) {
    this.sessionId = id;
  }

  getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
    return this.userMessagesForForking;
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

test("PiRuntime reloads an existing session after context refresh when the prompt changed", async () => {
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
    assert.equal(sessions[0].reloads, 0, "same-role prompt changes stay frozen mid-session");

    runtime.refreshContext("default");
    await collect(runtime.send({ roomId: "default", message: "three", transcript: [], activeRole: { name: "plan", prompt: "B", skills: [], diagnostics: [] } }));

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].reloads, 1);
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime appends gaia's assembled prompt onto pi's own base instead of replacing it", async () => {
  const fx = await harnessFixture();
  try {
    await mkdir(join(fx.home, "skills", "a"), { recursive: true });
    await writeFile(join(fx.home, "skills", "a", "SKILL.md"), "---\ndescription: test skill A\n---\n# A\n", "utf8");

    let seenSystemPrompt: string | undefined;
    let seenAppendSystemPrompt: string[] = [];
    let seenSkillNames: string[] = [];
    let seenSystemPromptRef: { current: string } | undefined;
    const factory: PiRuntimeSessionFactory = async (options) => {
      // Mirrors what createAgentSession does with a real resourceLoader: reload it,
      // then read back exactly what the SDK's own buildSystemPrompt will consume
      // (system-prompt.js: customPrompt undefined ⇒ pi's own default base is
      // built, THEN appendSystemPrompt joined on, THEN skills — proven by
      // reading the SDK source directly, not re-testing pi's own logic here).
      await options.loader.reload();
      seenSystemPrompt = options.loader.getSystemPrompt();
      seenAppendSystemPrompt = options.loader.getAppendSystemPrompt();
      seenSkillNames = options.loader.getSkills().skills.map((skill) => skill.name);
      seenSystemPromptRef = options.systemPromptRef;
      return { session: new FakeSession("s1") };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(
      runtime.send({
        roomId: "default",
        message: "one",
        transcript: [],
        activeRole: { name: "a", prompt: "A", skills: ["a"], diagnostics: [] },
      }),
    );

    // Pi's own base system prompt (tool usage, conventions, docs pointers)
    // stays untouched — no customPrompt override, so buildSystemPrompt falls
    // through to pi's hardcoded default base instead of gaia's assembly.
    assert.equal(seenSystemPrompt, undefined);
    // Gaia's assembled layer (soul+AGENTS.md+role+style law) rides as the
    // APPENDED section, verbatim, not folded into/replacing the base.
    assert.deepEqual(seenAppendSystemPrompt, [seenSystemPromptRef?.current]);
    assert.match(seenSystemPromptRef?.current ?? "", /A/);
    // The skills block keeps working (system-prompt.js only appends it when
    // the read tool is present, independent of customPrompt vs default).
    assert.deepEqual(seenSkillNames, ["a"]);
    runtime.dispose();
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

test("PiRuntime.compact turns pi-ai's 'session too small' throw into a clean no-op instead of a scary failure", async () => {
  const fx = await harnessFixture();
  try {
    // pi-ai's own session.compact() (agent-session.js) THROWS rather than
    // returning a result when prepareCompaction finds nothing outside the
    // always-kept "recent" window (default keepRecentTokens: 20000 tokens) —
    // this fires even on a small-but-real, freshly-restored session, and is
    // NOT the session-loss/restore bug fixed by 64cff59. Before this fix,
    // compact() let the throw propagate; room-service's catch then rendered
    // it as "Compaction failed for @agent: Nothing to compact (session too
    // small)" — indistinguishable from a real crash, even though ctx% can be
    // legitimately small (e.g. 8%) at the same time (both are honest signals
    // of the same small session, not a contradiction).
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession("s1");
      session.compact = async () => {
        throw new Error("Nothing to compact (session too small)");
      };
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const result = await runtime.compact("default");
    assert.deepEqual(result, { compacted: false, message: "nothing to compact — nothing to compact (session too small)." });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.compact lets an unrelated session.compact() failure propagate as a real error", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession("s1");
      session.compact = async () => {
        throw new Error("network error contacting provider");
      };
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    await assert.rejects(runtime.compact("default"), /network error contacting provider/);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.compact lazily restores a persisted session after a daemon restart (fresh runtime, no prior turn in this process)", async () => {
  const fx = await harnessFixture();
  try {
    // Simulate what's on disk after a prior process ran a turn: a non-empty
    // pi session dir (hasDurableSession's own on-disk truth) with nothing yet
    // in THIS process's in-memory SessionMap — the daemon-restart / cold-runner
    // shape host.ts's hasDurableSession gate already lets through to compact().
    const dir = piRoomSessionDir(fx.workspace, "default", fx.agent.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session-1.jsonl"), "{}\n", "utf8");

    const sessions: FakeSession[] = [];
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession(`restored${sessions.length + 1}`);
      session.compact = async () => ({ summary: "resumed history", tokensBefore: 500, estimatedTokensAfter: 50 });
      sessions.push(session);
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    // No send() ever ran on this runtime instance — compact() alone must
    // restore the session (the bug: it used to see the empty live SessionMap
    // and report "nothing to compact" despite the resumable file above).
    const result = await runtime.compact("default");
    assert.equal(result.compacted, true);
    assert.match(result.message, /500 tokens before → ~50/);
    assert.equal(result.summary, "resumed history");
    assert.equal(sessions.length, 1, "exactly one session restored, not recreated per compact call");

    // The restored session stays live for a following turn — no second create.
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    assert.equal(sessions.length, 1);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.compact stays a clean no-op when the session dir is truly empty (nothing to restore)", async () => {
  const fx = await harnessFixture();
  try {
    // Dir exists but holds no session file — hasDurableSession's own "empty ⇒
    // nothing to resume" case; compact must not fabricate a session for it.
    const dir = piRoomSessionDir(fx.workspace, "default", fx.agent.id);
    await mkdir(dir, { recursive: true });

    let factoryCalls = 0;
    const factory: PiRuntimeSessionFactory = async () => {
      factoryCalls += 1;
      return { session: new FakeSession("s1") };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    assert.deepEqual(await runtime.compact("default"), { compacted: false, message: "nothing to compact — no active session for this room." });
    assert.equal(factoryCalls, 0, "no session should be created for a no-op compact");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage maps the gaia origin to pi's matching entry and branches the persisted session at its parent", async () => {
  const fx = await harnessFixture();
  try {
    const sessions: FakeSession[] = [];
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession(`s${sessions.length + 1}`);
      sessions.push(session);
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const session = sessions[0];
    // buildTurnPrompt always renders the raw origin text verbatim after its
    // "Newest user message:" header — a stand-in for what pi actually
    // recorded as this prompt's user-entry text (see forkAtMessage's doc
    // comment in pi.ts).
    session.userMessagesForForking = [
      { entryId: "entry-1", text: "Room: default\n\nNewest user message:\n\nfirst question" },
      { entryId: "entry-2", text: "Room: default\n\nNewest user message:\n\nsecond question" },
    ];
    session.entryParents.set("entry-1", null);
    session.entryParents.set("entry-2", "entry-1");

    const result = await runtime.forkAtMessage("default", "evt_2", "second question");
    assert.deepEqual(result, { ok: true, message: "forked pi session to a new branch before entry entry-2" });
    // "before" position: branches at the TARGET's PARENT, dropping the
    // target (and everything after) from the new branch.
    assert.deepEqual(session.createBranchedSessionCalls, ["entry-1"]);
    assert.deepEqual(session.newSessionCalls, []);
    // The stale session handle is disposed — the branch is a NEW durable
    // file, so the room's session is rebuilt (lazily, same as a cold
    // restore) around SessionManager.continueRecent() picking up that file,
    // never left rewound in place.
    assert.equal(session.disposed, true);
    assert.equal(sessions.length, 2, "the room's session was rebuilt around the new branch");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage forks 'before' the very first message via newSession (no parent entry to branch to)", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => ({ session: new FakeSession("s1") });
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const meta = (runtime as unknown as { sessions: { get(id: string): { session: FakeSession } | undefined } }).sessions.get("default");
    const session = meta!.session;
    session.userMessagesForForking = [{ entryId: "entry-1", text: "Newest user message:\n\nonly question" }];
    session.entryParents.set("entry-1", null);
    session.sessionFile = "fake-session/original.jsonl";

    const result = await runtime.forkAtMessage("default", "evt_1", "only question");
    assert.equal(result.ok, true);
    assert.deepEqual(session.createBranchedSessionCalls, []);
    assert.deepEqual(session.newSessionCalls, [{ parentSession: "fake-session/original.jsonl" }]);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage disambiguates duplicate-text entries by picking the most recent occurrence", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => ({ session: new FakeSession("s1") });
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const meta = (runtime as unknown as { sessions: { get(id: string): { session: FakeSession } | undefined } }).sessions.get("default");
    const session = meta!.session;
    session.userMessagesForForking = [
      { entryId: "entry-1", text: "Newest user message:\n\nsame text" },
      { entryId: "entry-2", text: "Newest user message:\n\nsame text" },
    ];
    session.entryParents.set("entry-1", null);
    session.entryParents.set("entry-2", "entry-1");

    const result = await runtime.forkAtMessage("default", "evt_x", "same text");
    assert.equal(result.ok, true);
    assert.deepEqual(session.createBranchedSessionCalls, ["entry-1"], "the most recent match (entry-2) forks at ITS parent (entry-1)");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage fails cleanly (ok:false) when no pi entry matches the origin text", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => ({ session: new FakeSession("s1") });
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const result = await runtime.forkAtMessage("default", "evt_missing", "never sent this");
    assert.equal(result.ok, false);
    assert.match(result.message, /no pi session entry matches/);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage fails cleanly when the session isn't persisted (fork write returns nothing)", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => ({ session: new FakeSession("s1") });
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const meta = (runtime as unknown as { sessions: { get(id: string): { session: FakeSession } | undefined } }).sessions.get("default");
    const session = meta!.session;
    session.userMessagesForForking = [{ entryId: "entry-1", text: "hello" }];
    session.entryParents.set("entry-1", "entry-0");
    session.entryParents.set("entry-0", null);
    session.forkedSessionFile = undefined;

    const result = await runtime.forkAtMessage("default", "evt_1", "hello");
    assert.deepEqual(result, { ok: false, message: "pi session is not persisted to disk — cannot fork" });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage lazily restores a persisted session after a daemon restart, same as compact()", async () => {
  const fx = await harnessFixture();
  try {
    const dir = piRoomSessionDir(fx.workspace, "default", fx.agent.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session-1.jsonl"), "{}\n", "utf8");

    const sessions: FakeSession[] = [];
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession(`restored${sessions.length + 1}`);
      session.userMessagesForForking = [{ entryId: "entry-1", text: "resumed question" }];
      session.entryParents.set("entry-1", null);
      sessions.push(session);
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    // No send() ever ran on this runtime instance.
    const result = await runtime.forkAtMessage("default", "evt_1", "resumed question");
    assert.equal(result.ok, true);
    // One session restored to read/branch from, one more rebuilt around the
    // fresh branch — never recreated beyond that.
    assert.equal(sessions.length, 2, "restored once, then rebuilt once around the new branch");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage stays a clean no-op when there is no session to restore", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => ({ session: new FakeSession("s1") });
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    const result = await runtime.forkAtMessage("default", "evt_1", "anything");
    assert.deepEqual(result, { ok: false, message: "no active pi session for this room" });
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

test("PiRuntime resolves short model aliases to canonical registry ids (anthropic/fable → claude-fable-5)", async () => {
  const fx = await harnessFixture({ model: { provider: "anthropic", name: "fable" } });
  try {
    let resolvedModel: { id?: string } | undefined;
    const factory: PiRuntimeSessionFactory = async (options) => {
      resolvedModel = options.model as { id?: string } | undefined;
      return { session: new FakeSession("s1") };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    assert.equal(resolvedModel?.id, "claude-fable-5");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// resolveModel() loud-failure — a CONFIGURED-but-unresolvable model must
// never silently fall back to the pi CLI default (the OpenAI-agent-on-a-
// Claude-subscription-model footgun); only the "no model configured" case
// legitimately reaches the default.
// ---------------------------------------------------------------------------

test("PiRuntime throws a loud, actionable error when the configured model doesn't resolve in the registry", async () => {
  const fx = await harnessFixture({ model: { provider: "totally-not-a-real-provider", name: "nope-9000" } });
  try {
    const factory: PiRuntimeSessionFactory = async () => {
      throw new Error("session factory should never be reached — resolveModel must throw first");
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });
    await assert.rejects(
      collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      (error: Error) => {
        assert.match(error.message, /gaia/); // names the agent
        assert.match(error.message, /totally-not-a-real-provider\/nope-9000/); // names the unresolved provider/name
        assert.match(error.message, /anthropic/); // names an available provider, for actionability
        return true;
      },
    );
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime still resolves a configured, registry-known model (unchanged)", async () => {
  const fx = await harnessFixture({ model: { provider: "anthropic", name: "claude-sonnet-5" } });
  try {
    let resolvedModel: { id?: string } | undefined;
    const factory: PiRuntimeSessionFactory = async (options) => {
      resolvedModel = options.model as { id?: string } | undefined;
      return { session: new FakeSession("s1") };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    assert.equal(resolvedModel?.id, "claude-sonnet-5");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime with NO configured model still passes undefined through to the pi default (unchanged)", async () => {
  const fx = await harnessFixture({ model: undefined });
  try {
    let resolvedModel: unknown = "unset";
    const factory: PiRuntimeSessionFactory = async (options) => {
      resolvedModel = options.model;
      return { session: new FakeSession("s1") };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    assert.equal(resolvedModel, undefined);
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
