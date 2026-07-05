// MemoryService (src/services/memory-service.ts) as the daemon-side memory
// surface: mechanical episodic capture, the fenced/gated/budgeted auto-recall
// block over the v4 workspace index, structural self-match exclusion, loud
// degradation, and the RoomService wiring (RoomMemoryHooks) that carries a
// turn's recall into the runtime input and its settlement into an episode.
// Hooks are faked at the interface boundary; embeddings stay "off"/"auto"
// with no sidecar — no network ever.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_DEFAULTS } from "../src/core/config.js";
import type { AgentDef, AgentEvent, MemoryConfig, UiEvent, Workspace } from "../src/core/types.js";
import { appendFactOp } from "../src/domain/facts.js";
import { MemoryStore } from "../src/domain/memory.js";
import type { AgentInput, AgentRuntime } from "../src/harness/spec.js";
import { buildFileHints } from "../src/services/hints.js";
import type { FieldHint, HintSources } from "../src/services/hints.js";
import { MemoryService } from "../src/services/memory-service.js";
import type { EpisodeCapture } from "../src/services/memory-service.js";
import { RoomService } from "../src/services/room-service.js";
import type { RoomMemoryHooks } from "../src/services/room-service.js";

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

// --- MemoryService: capture + autoRecallBlock ---------------------------------

async function makeMemoryService(
  options: {
    config?: Partial<MemoryConfig>;
    rooms?: Array<{ roomId: string; events: Array<{ author: string; text: string; ts?: string }> }>;
    now?: () => Date;
    embedderDeps?: import("../src/services/embeddings.js").EmbedderDeps;
  } = {},
): Promise<{ service: MemoryService; agent: AgentDef; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "gaia-memsvc-"));
  const agent = makeAgent("gaia", root);
  await mkdir(agent.memoryDir, { recursive: true });
  const roomRefs: Array<{ roomId: string; transcriptPath: string }> = [];
  for (const room of options.rooms ?? []) {
    const dir = join(root, ".gaia", "rooms", room.roomId);
    await mkdir(dir, { recursive: true });
    const transcriptPath = join(dir, "transcript.jsonl");
    const lines = room.events.map((event, i) =>
      JSON.stringify({ id: `${room.roomId}_e${i}`, timestamp: event.ts ?? new Date().toISOString(), author: event.author, text: event.text }),
    );
    await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
    roomRefs.push({ roomId: room.roomId, transcriptPath });
  }
  const config: MemoryConfig = {
    autoRecall: true,
    autoRecallBudget: 1200,
    embeddings: "off",
    reranker: "off",
    consolidate: { enabled: false, idleMinutes: 30, maxPerDay: 8 },
    decayHalfLifeDays: 60,
    ...options.config,
  };
  const service = new MemoryService({
    workspaceRoot: root,
    workspaceMemory: () => config,
    agents: () => ({ gaia: agent }),
    memoryStore: new MemoryStore(),
    ...(roomRefs.length ? { roomsFor: () => roomRefs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.embedderDeps ? { embedderDeps: options.embedderDeps } : {}),
  });
  return { service, agent, root };
}

async function seedFact(memoryDir: string, text: string, ts = new Date().toISOString()): Promise<void> {
  const result = await appendFactOp(memoryDir, { op: "add", id: `fact_${Math.random().toString(36).slice(2, 8)}`, ts, text, source: "user_stated", validFrom: ts });
  assert.equal(result.ok, true, result.message);
}

test("capture writes one episode line with id/ts/outcome/tools", async () => {
  const now = new Date("2026-07-01T12:00:00.000Z");
  const { service, agent } = await makeMemoryService({ now: () => now });
  await service.capture("gaia", { roomId: "default", task: "fix the tests", reply: "all green", outcome: "complete", tools: ["read", "bash"] });

  const raw = await readFile(join(agent.memoryDir, "episodes.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  const episode = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.match(String(episode.id), /^ep_/);
  assert.equal(episode.ts, now.toISOString());
  assert.equal(episode.roomId, "default");
  assert.equal(episode.agentId, "gaia");
  assert.equal(episode.task, "fix the tests");
  assert.equal(episode.reply, "all green");
  assert.equal(episode.outcome, "complete");
  assert.deepEqual(episode.tools, ["read", "bash"]);
  service.dispose();
});

test("autoRecallBlock: autoRecall off → '' even with a matching fact", async () => {
  const { service, agent } = await makeMemoryService({ config: { autoRecall: false } });
  await seedFact(agent.memoryDir, "the daemon port is 8787");
  assert.equal(await service.autoRecallBlock("gaia", "daemon port"), "");
  service.dispose();
});

test("autoRecallBlock: no matches → ''", async () => {
  const { service } = await makeMemoryService();
  assert.equal(await service.autoRecallBlock("gaia", "completely unrelated query"), "");
  service.dispose();
});

test("autoRecallBlock: a matching fact yields the fenced header + text within budget; embeddings 'off' adds no degradation noise", async () => {
  const { service, agent } = await makeMemoryService();
  const text = "The deploy pipeline runs on fly.io in region fra";
  await seedFact(agent.memoryDir, text);

  const block = await service.autoRecallBlock("gaia", "deploy pipeline");
  assert.notEqual(block, "");
  const [header] = block.split("\n");
  assert.ok(header.includes("Possibly relevant memories"), `fenced header present (got: ${header})`);
  assert.ok(block.includes(text), "fact text injected");
  assert.ok(!block.includes("degraded"), "explicit 'off' is a chosen mode, not a degradation");
  assert.ok(block.length <= 1200 + header.length + 5, `block within budget (${block.length})`);
  service.dispose();
});

test("self-match exclusion: the asking room is dropped; other rooms and compacted-away content come back", async () => {
  const oldTs = new Date(Date.now() - 3 * 86_400_000).toISOString();
  // Pad the old event past the chunk max so the compaction floor falls on a
  // chunk boundary (a straddling chunk is conservatively in-context).
  const padding = " we debated the rollout order and the naming for quite some time back then.".repeat(15);
  const { service } = await makeMemoryService({
    rooms: [
      {
        roomId: "current",
        events: [
          { author: "user", ts: oldTs, text: `the zephyr protocol was archived long ago in this room.${padding}` },
          { author: "user", text: "hey, what do you know about the zephyr protocol?" },
        ],
      },
      { roomId: "june-room", events: [{ author: "nyari", ts: oldTs, text: "the zephyr protocol discussion also lives in another room" }] },
    ],
  });

  // Active context = the whole current room (floor 0): only june-room returns.
  const block = await service.autoRecallBlock("gaia", "zephyr protocol", { roomId: "current", floorIdx: 0 });
  assert.ok(block.includes("another room"), `other-room hit included (got: ${block})`);
  assert.ok(!block.includes("archived long ago"), "current-room content is a self-match while in context");

  // After compaction the floor rises past the old event — it's recallable again.
  const compacted = await service.autoRecallBlock("gaia", "zephyr protocol", { roomId: "current", floorIdx: 1 });
  assert.ok(compacted.includes("archived long ago"), `compacted-away content reachable (got: ${compacted})`);
  service.dispose();
});

test("search surfaces degradation honestly: 'auto' without a sidecar reports lexical-only", async () => {
  // A dead fetch — a REAL llama-server may be listening on this machine, and
  // this test is about the sidecar-missing story.
  const deadFetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const { service, agent } = await makeMemoryService({ config: { embeddings: "auto" }, embedderDeps: { fetchImpl: deadFetch } });
  await seedFact(agent.memoryDir, "the daemon port is 8787");
  const { hits, degraded } = await service.search("gaia", "daemon port");
  assert.ok(hits.length >= 1);
  assert.ok(degraded.some((note) => note.includes("lexical-only")), `lexical-only degradation stated (got: ${JSON.stringify(degraded)})`);
  assert.ok(degraded.some((note) => note.includes("never uses cloud")), "and the auto-never-cloud rule is spelled out");
  const chips = await service.healthChips();
  assert.ok(chips.some((chip) => chip.startsWith("embedder")), `embedder chip visible (got: ${JSON.stringify(chips)})`);
  service.dispose();
});

test("autoRecallBlock: a broken source returns '' instead of throwing", async () => {
  const { service, agent } = await makeMemoryService();
  // facts.jsonl as a DIRECTORY forces a read error inside the sync path.
  await mkdir(join(agent.memoryDir, "facts.jsonl"), { recursive: true });
  const block = await service.autoRecallBlock("gaia", "anything at all");
  assert.equal(block, "");
  service.dispose();
});

// --- RoomService integration (RoomMemoryHooks) --------------------------------

interface HookCalls {
  recall: Array<{ agentId: string; query: string; context?: { roomId: string; floorIdx: number } }>;
  captures: Array<{ agentId: string } & EpisodeCapture>;
  consolidations: Array<{ agentId: string; options?: { force?: boolean } }>;
}

function fakeHooks(calls: HookCalls, recallBlock = "MEMBLOCK"): RoomMemoryHooks {
  return {
    async autoRecallBlock(agentId, query, context) {
      calls.recall.push({ agentId, query, ...(context ? { context } : {}) });
      return recallBlock;
    },
    async capture(agentId, capture) {
      calls.captures.push({ agentId, ...capture });
    },
    async consolidate(agentId, options) {
      calls.consolidations.push({ agentId, ...(options ? { options } : {}) });
      return { ran: true, episodesSeen: 3, factsAdded: 2, factsInvalidated: 1, memoryEdits: 1, opsSkipped: 4 };
    },
    async search() {
      return { hits: [], degraded: [] };
    },
  };
}

async function makeRoomService(options: { memory: RoomMemoryHooks; script?: () => AgentEvent[]; throwAfterStream?: boolean }): Promise<{
  service: RoomService;
  events: UiEvent[];
  inputs: AgentInput[];
}> {
  const root = await mkdtemp(join(tmpdir(), "gaia-svc-"));
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
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20, memory: MEMORY_DEFAULTS },
    contextFiles: [],
    agents,
  };

  const script = options.script ?? (() => [{ type: "text-delta", delta: "hello from agent" } as AgentEvent]);
  const inputs: AgentInput[] = [];
  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    memoryStore: new MemoryStore(),
    memory: options.memory,
    runtimeFactory: (agent) =>
      ({
        agent,
        modelLabel: "test/model",
        capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
        async *send(input: AgentInput) {
          inputs.push(input);
          for (const event of script()) yield event;
          if (options.throwAfterStream) throw new Error("boom mid-stream");
        },
        async abort() {},
        dispose() {},
        resetRoom() {},
      }) as AgentRuntime,
  });
  const events: UiEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { service, events, inputs };
}

test("a message turn: auto-recall (with the room's context ref) reaches the runtime input; the settled turn is captured complete", async () => {
  const calls: HookCalls = { recall: [], captures: [], consolidations: [] };
  const { service, inputs } = await makeRoomService({ memory: fakeHooks(calls) });

  await service.sendMessage("what is the port?");
  await service.waitForIdle();

  assert.deepEqual(calls.recall, [{ agentId: "gaia", query: "what is the port?", context: { roomId: "default", floorIdx: 0 } }]);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].recall, "MEMBLOCK", "the hook's block rode into the runtime input");

  assert.equal(calls.captures.length, 1);
  const capture = calls.captures[0];
  assert.equal(capture.agentId, "gaia");
  assert.equal(capture.roomId, "default");
  assert.equal(capture.task, "what is the port?");
  assert.equal(capture.reply, "hello from agent");
  assert.equal(capture.outcome, "complete");
});

test("a runtime that throws after streaming a partial is captured with outcome error", async () => {
  const calls: HookCalls = { recall: [], captures: [], consolidations: [] };
  const { service } = await makeRoomService({
    memory: fakeHooks(calls),
    script: () => [{ type: "text-delta", delta: "partial before boom" } as AgentEvent],
    throwAfterStream: true,
  });

  await service.sendMessage("do something risky");
  await service.waitForIdle();

  assert.equal(calls.captures.length, 1);
  assert.equal(calls.captures[0].outcome, "error");
  assert.equal(calls.captures[0].reply, "partial before boom", "the preserved partial is the captured reply");
});

test("/consolidate forces a run and reports the numbers; unknown agent is rejected", async () => {
  const calls: HookCalls = { recall: [], captures: [], consolidations: [] };
  const { service, events } = await makeRoomService({ memory: fakeHooks(calls) });

  const task = await service.sendMessage("/consolidate");
  assert.equal(task.status, "complete");
  assert.deepEqual(calls.consolidations, [{ agentId: "gaia", options: { force: true } }]);
  const system = events.find((event) => event.type === "room-event" && event.event.author === "system");
  assert.ok(system && system.type === "room-event");
  const text = (system.event as { text: string }).text;
  for (const piece of ["@gaia", "3 episodes reviewed", "2 facts added", "1 superseded", "1 core-memory edits", "4 ops skipped"]) {
    assert.ok(text.includes(piece), `reply carries "${piece}" (got: ${text})`);
  }

  const unknown = await service.sendMessage("/consolidate nosuch");
  assert.equal(unknown.status, "complete");
  const replies = events.filter((event) => event.type === "room-event" && event.event.author === "system");
  const last = (replies[replies.length - 1] as { event: { text: string } }).event.text;
  assert.match(last, /Unknown agent/);
  assert.equal(calls.consolidations.length, 1, "no consolidation attempted for an unknown agent");
});

// --- settings hints ------------------------------------------------------------

test("memory knobs surface as field hints in config.json and agent.json (optional there)", () => {
  const sources: HintSources = { agentIds: ["gaia"], roomIds: ["default"], toolNames: ["read"], thinkingLevels: ["off", "medium"], models: [] };

  const configHints = buildFileHints({ label: ".gaia/config.json", kind: "json" }, sources);
  assert.ok(configHints);
  const autoRecall = configHints["memory.autoRecall"] as FieldHint;
  assert.equal(autoRecall.input, "boolean");
  assert.ok(!autoRecall.optional, "workspace defaults are not optional");
  const embeddings = configHints["memory.embeddings"] as FieldHint;
  assert.equal(embeddings.input, "select");
  assert.deepEqual(embeddings.options?.map((option) => option.value), ["auto", "off"]);

  const agentHints = buildFileHints({ label: "agents/gaia/agent.json", kind: "json" }, sources);
  assert.ok(agentHints);
  assert.equal((agentHints["memory.autoRecall"] as FieldHint).input, "boolean");
  assert.equal((agentHints["memory.autoRecall"] as FieldHint).optional, true, "per-agent overrides are optional");
  assert.equal((agentHints["memory.embeddings"] as FieldHint).optional, true);
  assert.equal((agentHints["memory.consolidate.maxPerDay"] as FieldHint).input, "number");
});

// --- deep path (P3, §8) ---------------------------------------------------------------

test("deepSearch: the local reranker reorders the head — a poor-fusion true match rises above lexical noise", async () => {
  const pad = " filler words to give this event enough mass to close a chunk cleanly.".repeat(10);
  const { service } = await makeMemoryService({
    config: { reranker: "auto" },
    rooms: [
      { roomId: "noise", events: [{ author: "user", text: `pineapple pizza pineapple pizza pineapple opinions all day long.${pad}` }] },
      { roomId: "truth", events: [{ author: "user", text: `the daemon restart procedure: stop it, then pineapple start detached.${pad}` }] },
    ],
    embedderDeps: {
      // Embedder unreachable → lexical-only fused list; the reranker decides.
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("/rerank")) {
          const documents = JSON.parse(init!.body as string).documents as string[];
          const results = documents.map((doc, index) => ({ index, relevance_score: doc.includes("restart procedure") ? 5.0 : -5.0 }));
          return new Response(JSON.stringify({ results }), { status: 200 });
        }
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
      ensureLocalReranker: async () => ({ baseUrl: "http://127.0.0.1:4245/v1", model: "bge-reranker-v2-m3" }),
    },
  });
  // "pineapple" matches the noise room 3× and the truth room once — fusion
  // alone ranks noise first; the fake reranker knows better.
  const { hits } = await service.deepSearch("gaia", "pineapple restart");
  assert.ok(hits.length >= 2, `expected both rooms (got ${hits.length})`);
  assert.equal(hits[0].roomId, "truth", `reranker should put the true match first (got ${hits[0].roomId})`);
});

test("deepSearch kill switch: reranker unavailable → fused order survives with a LOUD note (§8)", async () => {
  const pad = " filler words to give this event enough mass to close a chunk cleanly.".repeat(10);
  const { service } = await makeMemoryService({
    config: { reranker: "auto" },
    rooms: [{ roomId: "solo", events: [{ author: "user", text: `the marker phrase lives here.${pad}` }] }],
    embedderDeps: {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
      ensureLocalReranker: async () => undefined,
    },
  });
  const { hits, degraded } = await service.deepSearch("gaia", "marker phrase");
  assert.ok(hits.length >= 1, "fusion-order results still come back");
  assert.ok(degraded.some((note) => note.includes("fusion order")), `expected a fusion-order note (got ${JSON.stringify(degraded)})`);
});

test("deepSearch: explicit reranker 'off' is a chosen mode — no degradation note", async () => {
  const pad = " filler words to give this event enough mass to close a chunk cleanly.".repeat(10);
  const { service } = await makeMemoryService({
    rooms: [{ roomId: "solo", events: [{ author: "user", text: `the marker phrase lives here.${pad}` }] }],
  });
  const { hits, degraded } = await service.deepSearch("gaia", "marker phrase");
  assert.ok(hits.length >= 1);
  assert.ok(!degraded.some((note) => note.includes("rerank")), `off is not degraded (got ${JSON.stringify(degraded)})`);
});

test("summarizeSearch without an LLM: raw listing + a loud unavailable note", async () => {
  const pad = " filler words to give this event enough mass to close a chunk cleanly.".repeat(10);
  const { service } = await makeMemoryService({
    rooms: [{ roomId: "solo", events: [{ author: "user", text: `the marker phrase lives here.${pad}` }] }],
  });
  const { text, degraded } = await service.summarizeSearch("gaia", "marker phrase");
  assert.ok(text.includes("marker phrase"), "raw results still delivered");
  assert.ok(degraded.some((note) => note.includes("summarize unavailable")));
});
