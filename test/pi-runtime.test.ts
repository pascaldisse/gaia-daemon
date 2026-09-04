// v2 port of test/pi-runtime.test.ts — every v1 scenario, driven through the
// injectable sessionFactory against the REAL MemoryStore + prompt assembly.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryStore } from "../src/domain/memory.js";
import { findHarness, type SummonCreate } from "../src/harness/spec.js";
import { mechanicalCompactionFallback, newestContentEntryId, PiRuntime, piRoomSessionDir, type PiRuntimeSessionFactory, type PiSessionLike } from "../src/harness/pi.js";
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
  /** Optional per-test SettingsManager slice — mirrors the read-only manager
   * gaia passes the real AgentSession. Records applyOverrides so a test can
   * assert compact()'s forced recent-keep window is applied then restored. */
  settingsManager?: {
    getCompactionKeepRecentTokens(): number;
    applyOverrides(overrides: { compaction?: { keepRecentTokens?: number } }): void;
  };
  /** keepRecentTokens history recorded by the fixture settingsManager below. */
  keepRecentHistory: number[] = [];
  /** Per-test fixture for PiSessionLike.getUserMessagesForForking. */
  userMessagesForForking: Array<{ entryId: string; text: string }> = [];
  /** Calls recorded against PiSessionLike.navigateTree. */
  navigateTreeCalls: string[] = [];
  /** Per-test override: what navigateTree returns for the NEXT call. */
  navigateTreeResult: { cancelled: boolean; editorText?: string } = { cancelled: false };

  constructor(id: string) {
    this.sessionId = id;
  }

  getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
    return this.userMessagesForForking;
  }

  async navigateTree(targetEntryId: string): Promise<{ cancelled: boolean; editorText?: string }> {
    this.navigateTreeCalls.push(targetEntryId);
    return this.navigateTreeResult;
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

test("PiRuntime dynamically aliases a loaded terse skill command into Pi's native skill pipeline", async () => {
  const fx = await harnessFixture();
  try {
    await mkdir(join(fx.home, "skills", "stoner-mode"), { recursive: true });
    await writeFile(
      join(fx.home, "skills", "stoner-mode", "SKILL.md"),
      "---\nname: stoner-mode\ndescription: native skill command fixture\n---\n# stoner\n",
      "utf8",
    );
    const agent = { ...fx.agent, skills: ["stoner-mode"] };
    const workspace = { ...fx.workspace, agents: { gaia: agent } };
    let session: FakeSession | undefined;
    const factory: PiRuntimeSessionFactory = async (options) => {
      // This is the real Pi ResourceLoader path; the runtime must ask its
      // loaded skills rather than carrying a daemon-side command registry.
      await options.loader.reload();
      session = new FakeSession("s1");
      session.prompt = async (text, promptOptions) => {
        session?.prompts.push(text);
        session?.promptOptions.push(promptOptions);
        const skill = options.loader.getSkills().skills.find((candidate) => text.startsWith(`/skill:${candidate.name}`));
        if (skill) {
          const body = (await readFile(skill.filePath, "utf8")).replace(/^---[\s\S]*?---\s*/, "").trim();
          for (const listener of session?.listeners ?? []) {
            listener({
              type: "message_start",
              message: { role: "user", content: [{ type: "text", text: `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>\n\n7` }] },
            });
            listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
          }
        }
      };
      return { session };
    };
    const runtime = new PiRuntime({ workspace, agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    const expanded = await collect(runtime.send({ roomId: "default", message: "/stoner-mode 7", transcript: [], nativeCommand: true }));
    assert.equal(session?.prompts[0], "/skill:stoner-mode 7");
    assert.deepEqual(expanded, [
      {
        type: "skill-invocation",
        skill: {
          name: "stoner-mode",
          location: join(fx.home, "skills", "stoner-mode", "SKILL.md"),
          content: `References are relative to ${join(fx.home, "skills", "stoner-mode")}.\n\n# stoner`,
        },
      },
      { type: "text-delta", delta: "ok" },
    ]);

    // Unknown/template-shaped tokens stay verbatim for AgentSession.prompt(),
    // whose native template and unknown-command behavior remains authoritative.
    await collect(runtime.send({ roomId: "default", message: "/not-a-daemon-command", transcript: [], nativeCommand: true }));
    assert.equal(session?.prompts[1], "/not-a-daemon-command");
    runtime.dispose();
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

test("PiRuntime replaces pi's base with the daemon prompt when promptLaw is set", async () => {
  const fx = await harnessFixture();
  try {
    let seenSystemPrompt: string | undefined;
    let seenAppendSystemPrompt: string[] = [];
    let seenSystemPromptRef: { current: string } | undefined;
    const factory: PiRuntimeSessionFactory = async (options) => {
      await options.loader.reload();
      seenSystemPrompt = options.loader.getSystemPrompt();
      seenAppendSystemPrompt = options.loader.getAppendSystemPrompt();
      seenSystemPromptRef = options.systemPromptRef;
      return { session: new FakeSession("s1") };
    };
    const runtime = new PiRuntime({
      workspace: fx.workspace,
      agent: { ...fx.agent, promptLaw: "思開→即閉" },
      memoryStore: new MemoryStore(),
      sessionFactory: factory,
    });

    await collect(runtime.send({ roomId: "default", message: "one", transcript: [] }));

    // Replace mode: loader's customPrompt IS the daemon-built prompt — pi's
    // hardcoded default base never gets built — and the law sits at char 0.
    assert.equal(seenSystemPrompt, seenSystemPromptRef?.current);
    assert.match(seenSystemPrompt ?? "", /^思開→即閉/);
    // Append channel stays empty — nothing rides above or duplicates the prompt.
    assert.deepEqual(seenAppendSystemPrompt, []);
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

test("PiRuntime.compactClean uses only an explicitly registered summary and leaves ordinary compact untouched", async () => {
  const fx = await harnessFixture();
  try {
    const indexPath = join(fx.temp.path, "clean-summaries", "index.json");
    await mkdir(join(fx.temp.path, "clean-summaries"), { recursive: true });
    await writeFile(
      indexPath,
      JSON.stringify({ default: { agents: { gaia: "REGISTERED-CLEAN-SUMMARY" } } }),
      "utf8",
    );
    let cleanFloor: string | undefined;
    let keepRecent = 20_000;
    const keepRecentHistory: number[] = [];
    const factory: PiRuntimeSessionFactory = async ({ loader }) => {
      await loader.reload();
      const session = new FakeSession("s1");
      session.settingsManager = {
        getCompactionKeepRecentTokens: () => keepRecent,
        applyOverrides: (overrides) => {
          const next = overrides.compaction?.keepRecentTokens;
          if (next !== undefined) {
            keepRecent = next;
            keepRecentHistory.push(next);
          }
        },
      };
      const hook = loader.getExtensions().extensions[0]!.handlers.get("session_before_compact")![0]!;
      const preparation = {
        firstKeptEntryId: "pi-cut",
        tokensBefore: 9_000,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        retainedTail: [],
        fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      };
      session.compact = async () => {
        const result = await hook(
          { preparation },
          {
            model: undefined,
            modelRegistry: {},
            sessionManager: {
              getEntries: () => [
                { id: "user-1", type: "message", message: { role: "user" } },
                { id: "assistant-final", type: "message", message: { role: "assistant" } },
                { id: "tool-tail", type: "tool_result", message: { role: "tool" } },
                { id: "meta-tail", type: "model_change" },
              ],
            },
          },
        );
        if (result?.compaction) {
          cleanFloor = result.compaction.firstKeptEntryId;
          return { summary: result.compaction.summary, tokensBefore: preparation.tokensBefore };
        }
        return { summary: "ORDINARY-SDK-SUMMARY", tokensBefore: preparation.tokensBefore };
      };
      return { session };
    };
    const runtime = new PiRuntime({
      workspace: fx.workspace,
      agent: fx.agent,
      memoryStore: new MemoryStore(),
      sessionFactory: factory,
      cleanCompactionIndexPath: indexPath,
    });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const clean = await runtime.compactClean("default");
    assert.equal(clean.compacted, true);
    assert.equal(clean.summary, "REGISTERED-CLEAN-SUMMARY");
    assert.equal(cleanFloor, "assistant-final", "clean floor uses 30de282 newest-content semantics");
    assert.deepEqual(keepRecentHistory, [0, 20_000], "clean pass alone forces a zero tail then restores settings");

    const ordinary = await runtime.compact("default");
    assert.equal(ordinary.summary, "ORDINARY-SDK-SUMMARY", "registered clean summary never intercepts ordinary /compact");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.compactClean is a true no-op when the room has no explicit registration", async () => {
  const fx = await harnessFixture();
  try {
    const indexPath = join(fx.temp.path, "clean-summaries.json");
    await writeFile(indexPath, "{}", "utf8");
    let factoryCalls = 0;
    const runtime = new PiRuntime({
      workspace: fx.workspace,
      agent: fx.agent,
      memoryStore: new MemoryStore(),
      cleanCompactionIndexPath: indexPath,
      sessionFactory: async () => {
        factoryCalls += 1;
        return { session: new FakeSession("unexpected") };
      },
    });

    assert.deepEqual(await runtime.compactClean("default"), {
      compacted: false,
      message: "nothing to compact — no clean summary registered for this room and agent.",
    });
    assert.equal(factoryCalls, 0, "an unregistered clean request neither creates nor compacts a session");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.compactClean reports an already-minimal registered session as completed", async () => {
  const fx = await harnessFixture();
  try {
    const indexPath = join(fx.temp.path, "clean-summaries.json");
    await writeFile(indexPath, JSON.stringify({ default: { default: "CLEAN-NOOP-SUMMARY" } }), "utf8");
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession("s1");
      let keepRecent = 20_000;
      session.settingsManager = {
        getCompactionKeepRecentTokens: () => keepRecent,
        applyOverrides: (overrides) => {
          if (overrides.compaction?.keepRecentTokens !== undefined) keepRecent = overrides.compaction.keepRecentTokens;
        },
      };
      session.compact = async () => {
        throw new Error("Session already compacted");
      };
      return { session };
    };
    const runtime = new PiRuntime({
      workspace: fx.workspace,
      agent: fx.agent,
      memoryStore: new MemoryStore(),
      sessionFactory: factory,
      cleanCompactionIndexPath: indexPath,
    });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    assert.deepEqual(await runtime.compactClean("default"), {
      compacted: true,
      message: "clean compaction: pi session already minimal; advanced room floor+cursor.",
      summary: "CLEAN-NOOP-SUMMARY",
    });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.compactDraft captures a summary without evicting, then compactApply commits the edited text", async () => {
  const fx = await harnessFixture();
  try {
    let evictions = 0;
    let committedSummary: string | undefined;
    const factory: PiRuntimeSessionFactory = async ({ loader }) => {
      await loader.reload();
      const session = new FakeSession("s1");
      const hook = loader.getExtensions().extensions[0]!.handlers.get("session_before_compact")![0]!;
      const preparation = {
        firstKeptEntryId: "fresh-cut",
        tokensBefore: 900,
        messagesToSummarize: [], turnPrefixMessages: [], retainedTail: [],
        fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      };
      session.compact = async () => {
        const result = await hook({ preparation }, { model: undefined });
        if (result?.cancel) throw new Error("Compaction cancelled");
        evictions += 1;
        committedSummary = result?.compaction?.summary ?? "generated summary";
        return { summary: committedSummary, tokensBefore: preparation.tokensBefore };
      };
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const draft = await runtime.compactDraft("default");
    assert.equal(draft.compacted, false);
    assert.match(draft.summary ?? "", /Mechanical compaction/);
    assert.equal(evictions, 0, "draft cancellation leaves Pi's live session intact");
    const applied = await runtime.compactApply("default", "OWNER-EDITED-SUMMARY");
    assert.equal(applied.compacted, true);
    assert.equal(applied.summary, "OWNER-EDITED-SUMMARY");
    assert.equal(committedSummary, "OWNER-EDITED-SUMMARY", "apply must not reuse the draft prose");
    assert.equal(evictions, 1);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});
test("PiRuntime.compactApply rejects clearly without a pending draft", async () => {
  const fx = await harnessFixture();
  try {
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore() });
    await assert.rejects(runtime.compactApply("default", "edited"), /no draft — run \/compact --edit first/);
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

test("PiRuntime.compact forces a smaller recent-keep window and retries when the session is under pi's 20000-token floor", async () => {
  const fx = await harnessFixture();
  try {
    // An EXPLICIT /compact on a session that fits under pi's default
    // keepRecentTokens floor must still shrink it (the poisoned/heavy tail case)
    // — pi throws "too small" on the first pass, so compact() retries once with
    // a forced small recent-keep window, then restores the real floor.
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession("s1");
      let keepRecent = 20000;
      session.settingsManager = {
        getCompactionKeepRecentTokens: () => keepRecent,
        applyOverrides: (overrides) => {
          if (overrides.compaction?.keepRecentTokens !== undefined) {
            keepRecent = overrides.compaction.keepRecentTokens;
            session.keepRecentHistory.push(keepRecent);
          }
        },
      };
      session.compact = async () => {
        // Refuse until the recent-keep floor is lowered (mirrors findCutPoint
        // finding nothing to cut above the default floor).
        if (keepRecent >= 20000) throw new Error("Nothing to compact (session too small)");
        return { summary: "trimmed the heavy tail", tokensBefore: 8000, estimatedTokensAfter: 2000 };
      };
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const result = await runtime.compact("default");
    assert.equal(result.compacted, true);
    assert.match(result.message, /8000 tokens before → ~2000/);
    assert.equal(result.summary, "trimmed the heavy tail");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.compact still no-ops cleanly when even the forced window finds nothing", async () => {
  const fx = await harnessFixture();
  try {
    // A genuinely tiny session (one short turn under the forced floor): both the
    // default pass AND the forced retry throw "too small". The floor must be
    // restored and the clean no-op surfaced — never a scary failure.
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession("s1");
      let keepRecent = 20000;
      session.settingsManager = {
        getCompactionKeepRecentTokens: () => keepRecent,
        applyOverrides: (overrides) => {
          if (overrides.compaction?.keepRecentTokens !== undefined) {
            keepRecent = overrides.compaction.keepRecentTokens;
            session.keepRecentHistory.push(keepRecent);
          }
        },
      };
      session.compact = async () => {
        throw new Error("Nothing to compact (session too small)");
      };
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const session = (runtime as unknown as { sessions: Map<string, { session: FakeSession }> }).sessions.get("default")!.session;
    const result = await runtime.compact("default");
    assert.deepEqual(result, { compacted: false, message: "nothing to compact — nothing to compact (session too small)." });
    // The floor was lowered for the retry, then restored to its original value.
    assert.equal(session.keepRecentHistory[0], 2000);
    assert.equal(session.keepRecentHistory[session.keepRecentHistory.length - 1], 20000);
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

test("PiRuntime.forkAtMessage maps the gaia origin to pi's Kth user entry BY ORDINAL (never text) and calls navigateTree with its entryId", async () => {
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
    // pi records the buildTurnPrompt-WRAPPED prompt (room header, agent line,
    // mention prefix stripped, …), NEVER gaia's raw event text — so these
    // texts deliberately share NO substring with any gaia origin text. The
    // mapping is purely positional: userOrdinal=2 → entries[1] (entry-2).
    session.userMessagesForForking = [
      { entryId: "entry-1", text: "Room: default\nCurrent agent: @echo\n\nNewest user message:\nfirst" },
      { entryId: "entry-2", text: "Room: default\nCurrent agent: @echo\n\nNewest user message:\nsecond" },
    ];

    const result = await runtime.forkAtMessage("default", "evt_2", 2);
    assert.deepEqual(result, { ok: true, message: "forked pi session at user message 2 (entry entry-2)" });
    // navigateTree is called with the TARGET entry itself — pi's own
    // navigateTree rewinds to that entry's parent internally.
    assert.deepEqual(session.navigateTreeCalls, ["entry-2"]);
    // The session stays LIVE — no dispose/rebuild for the native fork path.
    assert.equal(session.disposed, false);
    assert.equal(sessions.length, 1, "no session rebuild — navigateTree rewinds the SAME live session");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage K=1 (first user message) calls navigateTree with the first entry's id", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => ({ session: new FakeSession("s1") });
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const meta = (runtime as unknown as { sessions: { get(id: string): { session: FakeSession } | undefined } }).sessions.get("default");
    const session = meta!.session;
    session.userMessagesForForking = [
      { entryId: "entry-1", text: "wrapped prompt A" },
      { entryId: "entry-2", text: "wrapped prompt B" },
    ];

    const result = await runtime.forkAtMessage("default", "evt_1", 1);
    assert.equal(result.ok, true);
    assert.deepEqual(session.navigateTreeCalls, ["entry-1"]);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage picks strictly by position even when entry texts are identical", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => ({ session: new FakeSession("s1") });
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const meta = (runtime as unknown as { sessions: { get(id: string): { session: FakeSession } | undefined } }).sessions.get("default");
    const session = meta!.session;
    // Identical text: text matching couldn't tell these apart, ordinal can.
    session.userMessagesForForking = [
      { entryId: "entry-1", text: "same text" },
      { entryId: "entry-2", text: "same text" },
      { entryId: "entry-3", text: "same text" },
    ];

    const result = await runtime.forkAtMessage("default", "evt_x", 3);
    assert.equal(result.ok, true);
    assert.deepEqual(session.navigateTreeCalls, ["entry-3"], "ordinal 3 → entries[2] (entry-3)");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage fails cleanly (ok:false) when the ordinal is out of range", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => ({ session: new FakeSession("s1") });
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const meta = (runtime as unknown as { sessions: { get(id: string): { session: FakeSession } | undefined } }).sessions.get("default");
    const session = meta!.session;
    session.userMessagesForForking = [{ entryId: "entry-1", text: "only one" }];

    // Beyond the end (session has 1 user entry, asking for the 2nd).
    const tooHigh = await runtime.forkAtMessage("default", "evt_missing", 2);
    assert.equal(tooHigh.ok, false);
    assert.match(tooHigh.message, /out of range/);
    // Below the start.
    const tooLow = await runtime.forkAtMessage("default", "evt_missing", 0);
    assert.equal(tooLow.ok, false);
    assert.match(tooLow.message, /out of range/);
    assert.deepEqual(session.navigateTreeCalls, [], "no fork attempted on an out-of-range ordinal");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage fails cleanly when the session build lacks native-fork support", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => ({ session: new FakeSession("s1") });
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const meta = (runtime as unknown as { sessions: { get(id: string): { session: FakeSession } | undefined } }).sessions.get("default");
    const session = meta!.session;
    session.userMessagesForForking = [{ entryId: "entry-1", text: "hello" }];
    // Simulate an older pi build: no navigateTree on the session at all.
    // navigateTree is a prototype method, so it must be shadowed with an own
    // `undefined` property rather than `delete`d (delete leaves the
    // prototype's method reachable).
    (session as unknown as { navigateTree?: unknown }).navigateTree = undefined;

    const result = await runtime.forkAtMessage("default", "evt_1", 1);
    assert.deepEqual(result, { ok: false, message: "this pi session build does not support native forking" });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("PiRuntime.forkAtMessage fails cleanly when navigateTree reports cancelled", async () => {
  const fx = await harnessFixture();
  try {
    const factory: PiRuntimeSessionFactory = async () => ({ session: new FakeSession("s1") });
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const meta = (runtime as unknown as { sessions: { get(id: string): { session: FakeSession } | undefined } }).sessions.get("default");
    const session = meta!.session;
    session.userMessagesForForking = [{ entryId: "entry-1", text: "hello" }];
    session.navigateTreeResult = { cancelled: true };

    const result = await runtime.forkAtMessage("default", "evt_1", 1);
    assert.equal(result.ok, false);
    assert.match(result.message, /cancelled/);
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
      session.userMessagesForForking = [{ entryId: "entry-1", text: "wrapped resumed prompt" }];
      sessions.push(session);
      return { session };
    };
    const runtime = new PiRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), sessionFactory: factory });

    // No send() ever ran on this runtime instance.
    const result = await runtime.forkAtMessage("default", "evt_1", 1);
    assert.equal(result.ok, true);
    // The lazily-restored session is reused directly — no rebuild.
    assert.equal(sessions.length, 1, "restored once, forked in place");
    assert.deepEqual(sessions[0].navigateTreeCalls, ["entry-1"]);
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

    const result = await runtime.forkAtMessage("default", "evt_1", 1);
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

// ---------------------------------------------------------------------------
// /dsc-compact floor selection — a single oversized prompt entry can itself be
// Pi's calculated cut point. The clean summary must instead retain only the
// newest content-bearing entry, skipping tool and session metadata entries.
// ---------------------------------------------------------------------------

test("newestContentEntryId skips trailing tool and metadata entries", () => {
  assert.equal(
    newestContentEntryId(
      [
        { id: "user-1", type: "message", message: { role: "user" } },
        { id: "assistant-1", type: "message", message: { role: "assistant" } },
        { id: "tool-1", type: "tool_result", message: { role: "tool" } },
        { id: "meta-1", type: "model_change" },
      ],
      "pi-cut",
    ),
    "assistant-1",
  );
});

test("newestContentEntryId falls back to Pi's cut when no content entry exists", () => {
  assert.equal(
    newestContentEntryId(
      [
        { id: "tool-1", type: "tool_result" },
        { id: "meta-1", type: "compaction" },
      ],
      "pi-cut",
    ),
    "pi-cut",
  );
});

// ---------------------------------------------------------------------------
// mechanicalCompactionFallback — 08-25 fix: when the room's own model IS the
// compact-fallback model (Solas compacting Solas), a failed LLM summarize
// has no diversity left to retry with (see compactionFallbackExtension's
// comment). This is the deterministic non-LLM degrade path that keeps the
// room compactable instead of deadlocking at >100% context forever.
// ---------------------------------------------------------------------------

test("mechanicalCompactionFallback carries forward the load-bearing compaction fields untouched", () => {
  const result = mechanicalCompactionFallback(
    {
      firstKeptEntryId: "entry-42",
      tokensBefore: 1_350_670,
      previousSummary: undefined,
      messagesToSummarize: [1, 2, 3],
      turnPrefixMessages: [],
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    },
    "Summarization failed: The model refused to complete the request",
  );
  assert.equal(result.firstKeptEntryId, "entry-42", "cut point must be preserved or the compaction can't be applied");
  assert.equal(result.tokensBefore, 1_350_670);
  assert.match(result.summary, /The model refused to complete the request/, "failure reason must be visible, not swallowed");
  assert.match(result.summary, /3 message/, "honest about how much history got no narrative summary");
});

test("mechanicalCompactionFallback preserves the prior compaction chain verbatim", () => {
  const result = mechanicalCompactionFallback(
    {
      firstKeptEntryId: "entry-9",
      tokensBefore: 500,
      previousSummary: "## Goal\nFix the ps5-jb WebKit UAF chain.",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    },
    "refused",
  );
  assert.match(result.summary, /Fix the ps5-jb WebKit UAF chain\./, "dropping the summary chain silently loses prior context");
});

test("mechanicalCompactionFallback splits file ops the same way the real summarizer does (modified wins over read)", () => {
  const result = mechanicalCompactionFallback(
    {
      firstKeptEntryId: "entry-1",
      tokensBefore: 100,
      previousSummary: undefined,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      fileOps: {
        read: new Set(["a.ts", "b.ts"]),
        written: new Set(["b.ts"]),
        edited: new Set(["c.ts"]),
      },
    },
    "refused",
  );
  assert.deepEqual(result.details, { readFiles: ["a.ts"], modifiedFiles: ["b.ts", "c.ts"] });
});

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
