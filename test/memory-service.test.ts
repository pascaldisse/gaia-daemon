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
import { existsSync } from "node:fs";
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

test("capture skips refusals entirely — a decline never becomes a recallable episode", async () => {
  const { service, agent } = await makeMemoryService();
  await service.capture("gaia", {
    roomId: "ida",
    task: "which function checks the 0x1a8 flag to hide the menus",
    reply: "Straight with you — this one I'm going to stop at. I'm going to hold the same line I held before.",
    outcome: "complete",
  });
  // A refusal must leave NO episode on disk (the transcript still holds the turn).
  assert.equal(existsSync(join(agent.memoryDir, "episodes.jsonl")), false);

  // A normal reply in the same room is still captured — the guard is content-scoped, not room-scoped.
  await service.capture("gaia", { roomId: "ida", task: "trace the flag", reply: "Found it: it's sub_1400 reading the edition byte.", outcome: "complete" });
  const raw = await readFile(join(agent.memoryDir, "episodes.jsonl"), "utf8");
  assert.equal(raw.trim().split("\n").length, 1);
  service.dispose();
});

test("purgeRoom: erases a deleted room from episodic memory (disk + recall), keeps other rooms, backs up removed", async () => {
  const { service, agent } = await makeMemoryService();
  await service.capture("gaia", { roomId: "doomed", task: "trace the widget", reply: "found the doomed widget bug", outcome: "complete" });
  await service.capture("gaia", { roomId: "keep", task: "trace the gadget", reply: "found the kept gadget bug", outcome: "complete" });
  assert.equal((await readFile(join(agent.memoryDir, "episodes.jsonl"), "utf8")).trim().split("\n").length, 2);

  const backupDir = await mkdtemp(join(tmpdir(), "gaia-trash-"));
  const purged = await service.purgeRoom("doomed", backupDir);
  assert.equal(purged, 1);

  // Gone from disk; the other room survives; removed line is recoverable.
  const after = (await readFile(join(agent.memoryDir, "episodes.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { roomId: string });
  assert.deepEqual(after.map((episode) => episode.roomId), ["keep"]);
  assert.equal(existsSync(join(backupDir, "episodes-gaia.jsonl")), true, "removed episodes backed up for reversibility");

  // Recall never surfaces the purged room's content again.
  const hits = await service.search("gaia", "doomed widget");
  assert.ok(!hits.hits.some((hit) => hit.text.includes("doomed widget")), "purged episode is out of recall");
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

test("recall degraded is debounced: one slow search doesn't latch the chip; a streak does; a fast search clears it", async () => {
  // A slow EMBED pushes each search past the 1.5s recall budget deterministically
  // (setTimeout guarantees ≥1600ms > SLOW_RECALL_MS). The point: a lone spike
  // must not raise the loud chip — only sustained slowness — and recovery clears.
  let slow = true;
  const { service } = await makeMemoryService({
    config: { embeddings: "auto" },
    rooms: [{ roomId: "solo", events: [{ author: "user", text: "the daemon port is 8787" }] }],
    embedderDeps: {
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("embeddings")) {
          if (slow) await new Promise((resolve) => setTimeout(resolve, 1_600));
          const input = JSON.parse(init!.body as string).input as string[];
          return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }), { status: 200 });
        }
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
      ensureLocalSidecar: async () => ({ baseUrl: "http://127.0.0.1:4244/v1", model: "embeddinggemma-300m" }),
    },
  });
  const hasRecallChip = async () => (await service.healthChips()).some((chip) => chip.startsWith("recall"));
  await service.search("gaia", "daemon port"); // 1 slow — under the streak
  assert.ok(!(await hasRecallChip()), "a single slow search must NOT latch the recall chip");
  await service.search("gaia", "daemon port"); // 2
  await service.search("gaia", "daemon port"); // 3 — reaches the streak
  assert.ok(await hasRecallChip(), "a streak of slow searches surfaces the recall chip");
  slow = false;
  await service.search("gaia", "daemon port"); // fast — recovery
  assert.ok(!(await hasRecallChip()), "a fast search clears the recall chip");
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

test("deepSearch self-heals an idle-stopped reranker: failed call → in-call re-ensure + retry, NO degradation", async () => {
  const pad = " filler words to give this event enough mass to close a chunk cleanly.".repeat(10);
  let rerankCalls = 0;
  const { service } = await makeMemoryService({
    config: { reranker: "auto" },
    rooms: [
      { roomId: "noise", events: [{ author: "user", text: `pineapple pizza pineapple pizza pineapple opinions all day long.${pad}` }] },
      { roomId: "truth", events: [{ author: "user", text: `the daemon restart procedure: stop it, then pineapple start detached.${pad}` }] },
    ],
    embedderDeps: {
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("/rerank")) {
          rerankCalls += 1;
          // Call 1 = resolve probe (server was up), call 2 = the real rerank
          // against a now idle-stopped server, calls 3+4 = re-probe + retry.
          if (rerankCalls === 2) throw new Error("ECONNREFUSED (idle-stopped)");
          const documents = JSON.parse(init!.body as string).documents as string[];
          const results = documents.map((doc, index) => ({ index, relevance_score: doc.includes("restart procedure") ? 5.0 : -5.0 }));
          return new Response(JSON.stringify({ results }), { status: 200 });
        }
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
      ensureLocalReranker: async () => ({ baseUrl: "http://127.0.0.1:4245/v1", model: "bge-reranker-v2-m3" }),
    },
  });
  const { hits, degraded } = await service.deepSearch("gaia", "pineapple restart");
  assert.equal(rerankCalls, 4, "probe, failed call, re-probe, retried call");
  assert.equal(hits[0].roomId, "truth", `the retried rerank still reorders the head (got ${hits[0].roomId})`);
  assert.ok(!degraded.some((note) => note.includes("rerank")), `self-heal is silent (got ${JSON.stringify(degraded)})`);
  service.dispose();
});

test("search self-heals an idle-stopped embedder: failed query embed → in-call re-ensure + retry keeps the dense arm", async () => {
  const pad = " filler words to give this event enough mass to close a chunk cleanly.".repeat(10);
  let embedCalls = 0;
  const { service } = await makeMemoryService({
    config: { embeddings: "auto" },
    rooms: [{ roomId: "solo", events: [{ author: "user", text: `the marker phrase lives here.${pad}` }] }],
    embedderDeps: {
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("embeddings")) {
          embedCalls += 1;
          // Call 1 = resolve probe, call 2 = the query embed against a now
          // idle-stopped server, calls 3+4 = re-probe + retried query embed.
          if (embedCalls === 2) throw new Error("ECONNREFUSED (idle-stopped)");
          const input = JSON.parse(init!.body as string).input as string[];
          return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }), { status: 200 });
        }
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
      ensureLocalSidecar: async () => ({ baseUrl: "http://127.0.0.1:4244/v1", model: "embeddinggemma-300m" }),
    },
  });
  const { degraded } = await service.search("gaia", "marker phrase");
  assert.equal(embedCalls, 4, "probe, failed query embed, re-probe, retried query embed");
  assert.ok(!degraded.some((note) => note.includes("lexical-only")), `self-heal keeps the dense arm silently (got ${JSON.stringify(degraded)})`);
  service.dispose();
});

test("an over-long query is capped to one physical batch: no 'input too large' 500, dense arm survives", async () => {
  const pad = " filler words to give this event enough mass to close a chunk cleanly.".repeat(10);
  // Stand-in for the non-causal embedder's physical batch: any single input
  // past this 500s ("input too large"), exactly like the live llama-server did
  // against a stale 512-batch sidecar. The query cap must keep us under it.
  const BATCH_CHAR_LIMIT = 1_400;
  let maxInputLen = 0;
  const { service } = await makeMemoryService({
    config: { embeddings: "auto" },
    rooms: [{ roomId: "solo", events: [{ author: "user", text: `the marker phrase lives here.${pad}` }] }],
    embedderDeps: {
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("embeddings")) {
          const input = JSON.parse(init!.body as string).input as string[];
          for (const text of input) maxInputLen = Math.max(maxInputLen, text.length);
          if (input.some((text) => text.length > BATCH_CHAR_LIMIT)) {
            return new Response(JSON.stringify({ error: { message: "input too large to process" } }), { status: 500 });
          }
          return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }), { status: 200 });
        }
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
      ensureLocalSidecar: async () => ({ baseUrl: "http://127.0.0.1:4244/v1", model: "embeddinggemma-300m" }),
    },
  });
  const hugeQuery = "marker phrase ".repeat(400); // ~5600 chars, far past any batch
  const { degraded } = await service.search("gaia", hugeQuery);
  assert.ok(maxInputLen <= BATCH_CHAR_LIMIT, `every embed input stayed within one batch (saw ${maxInputLen})`);
  assert.ok(!degraded.some((note) => note.includes("lexical-only")), `the capped query keeps its dense arm (got ${JSON.stringify(degraded)})`);
  service.dispose();
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
