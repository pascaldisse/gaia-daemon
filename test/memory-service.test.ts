// MemoryService (src/services/memory-service.ts) as the daemon-side memory
// surface: mechanical episodic capture, the fenced/gated/budgeted auto-recall
// block, and the RoomService wiring (RoomMemoryHooks) that carries a turn's
// recall into the runtime input and its settlement into an episode. Hooks are
// faked at the interface boundary; embeddings stay "off" — no network ever.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_DEFAULTS } from "../src/core/config.js";
import type { AgentDef, AgentEvent, MemoryConfig, UiEvent, Workspace } from "../src/core/types.js";
import { appendFactOp } from "../src/domain/facts.js";
import { MemoryStore } from "../src/domain/memory.js";
import type { RoomSearchRef } from "../src/domain/memory-index.js";
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
  options: { config?: Partial<MemoryConfig>; rooms?: RoomSearchRef[]; now?: () => Date } = {},
): Promise<{ service: MemoryService; agent: AgentDef }> {
  const root = await mkdtemp(join(tmpdir(), "gaia-memsvc-"));
  const agent = makeAgent("gaia", root);
  const config: MemoryConfig = {
    autoRecall: true,
    autoRecallBudget: 1200,
    embeddings: "off",
    consolidate: { enabled: false, idleMinutes: 30, maxPerDay: 8 },
    decayHalfLifeDays: 60,
    ...options.config,
  };
  const service = new MemoryService({
    workspaceMemory: () => config,
    agents: () => ({ gaia: agent }),
    memoryStore: new MemoryStore(),
    ...(options.rooms ? { roomsFor: () => options.rooms as RoomSearchRef[] } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { service, agent };
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

test("autoRecallBlock: a matching fact yields the fenced header + text within budget", async () => {
  const { service, agent } = await makeMemoryService();
  const text = "The deploy pipeline runs on fly.io in region fra";
  await seedFact(agent.memoryDir, text);

  const block = await service.autoRecallBlock("gaia", "deploy pipeline");
  assert.notEqual(block, "");
  const [header] = block.split("\n");
  assert.ok(header.includes("Possibly relevant memories"), `fenced header present (got: ${header})`);
  assert.ok(block.includes(text), "fact text injected");
  // Budget: line chars ≤ autoRecallBudget; the header + ≤5 joins ride on top.
  assert.ok(block.length <= 1200 + header.length + 5, `block within budget (${block.length})`);
  service.dispose();
});

test("autoRecallBlock: fresh transcript hits are excluded, old ones included", async () => {
  const roomDir = await mkdtemp(join(tmpdir(), "gaia-room-"));
  const transcriptPath = join(roomDir, "transcript.jsonl");
  const oldTs = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const freshTs = new Date(Date.now() - 10 * 60_000).toISOString();
  const lines = [
    { id: "e1", timestamp: oldTs, author: "user", text: "the zephyr protocol was archived long ago" },
    { id: "e2", timestamp: freshTs, author: "user", text: "the zephyr protocol just came up again" },
  ];
  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  const { service } = await makeMemoryService({ rooms: [{ roomId: "default", transcriptPath, dbPath: join(roomDir, "recall.db") }] });
  const block = await service.autoRecallBlock("gaia", "zephyr protocol");
  assert.ok(block.includes("archived long ago"), `old transcript hit included (got: ${block})`);
  assert.ok(!block.includes("just came up again"), "sub-hour transcript hit excluded (already in context)");
  service.dispose();
});

test("autoRecallBlock: a broken index returns '' instead of throwing", async () => {
  const { service, agent } = await makeMemoryService();
  // facts.jsonl as a DIRECTORY forces a read error inside the search path.
  await mkdir(join(agent.memoryDir, "facts.jsonl"), { recursive: true });
  const block = await service.autoRecallBlock("gaia", "anything at all");
  assert.equal(block, "");
  service.dispose();
});

// --- RoomService integration (RoomMemoryHooks) --------------------------------

interface HookCalls {
  recall: Array<{ agentId: string; query: string }>;
  captures: Array<{ agentId: string } & EpisodeCapture>;
  consolidations: Array<{ agentId: string; options?: { force?: boolean } }>;
}

function fakeHooks(calls: HookCalls, recallBlock = "MEMBLOCK"): RoomMemoryHooks {
  return {
    async autoRecallBlock(agentId, query) {
      calls.recall.push({ agentId, query });
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
      return [];
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

test("a message turn: auto-recall reaches the runtime input; the settled turn is captured complete", async () => {
  const calls: HookCalls = { recall: [], captures: [], consolidations: [] };
  const { service, inputs } = await makeRoomService({ memory: fakeHooks(calls) });

  await service.sendMessage("what is the port?");
  await service.waitForIdle();

  assert.deepEqual(calls.recall, [{ agentId: "gaia", query: "what is the port?" }]);
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
