// The dreaming loop (src/services/consolidate.ts): one guarded LLM call that
// distills episodes into facts, supersessions, and core edits. The LLM is a
// recorded fake — no network. Every apply path is exercised through the same
// guarded writers the agent uses (dup drop, caps, secret filter), plus the
// cursor/ledger durability and MemoryService's concurrency guard.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, MemoryConfig } from "../src/core/types.js";
import { appendEpisode } from "../src/domain/episodes.js";
import type { Episode } from "../src/domain/episodes.js";
import { appendFactOp, readFactOpsFrom, replayFacts } from "../src/domain/facts.js";
import { CORE_MEMORY_FILE, MemoryStore } from "../src/domain/memory.js";
import {
  parseConsolidateOps,
  readConsolidateState,
  runConsolidation,
  writeConsolidateState,
} from "../src/services/consolidate.js";
import type { ConsolidateLlm, ConsolidateLlmInput } from "../src/services/consolidate.js";
import { MemoryService } from "../src/services/memory-service.js";

process.env.GAIA_HOME = await mkdtemp(join(tmpdir(), "gaia-home-"));

const NOW = new Date("2026-07-01T00:00:00.000Z");

let seq = 0;
async function memDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gaia-consolidate-"));
}

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: `ep_${(seq += 1)}`,
    ts: "2026-06-30T00:00:00.000Z",
    roomId: "default",
    agentId: "gaia",
    task: "fix the flaky voice test",
    reply: "Found the race in the websocket setup",
    outcome: "complete",
    ...overrides,
  };
}

async function seedFact(dir: string, id: string, text: string): Promise<void> {
  const result = await appendFactOp(dir, { op: "add", id, ts: "2026-06-01T00:00:00.000Z", text, source: "user_stated", validFrom: "2026-06-01T00:00:00.000Z" });
  assert.equal(result.ok, true, result.message);
}

function cannedLlm(reply: string, calls: ConsolidateLlmInput[] = []): ConsolidateLlm {
  return async (input) => {
    calls.push(input);
    return reply;
  };
}

async function run(dir: string, store: MemoryStore, llm: ConsolidateLlm, options: { maxPerDay?: number; force?: boolean } = {}) {
  return runConsolidation({
    memoryDir: dir,
    agentId: "gaia",
    memoryStore: store,
    llm,
    maxPerDay: options.maxPerDay ?? 8,
    force: options.force,
    now: NOW,
  });
}

// --- parseConsolidateOps -----------------------------------------------------

test("parseConsolidateOps: valid array survives prose and fences around it", () => {
  const reply = [
    "Sure! After reviewing the episodes, here are my ops:",
    "```json",
    JSON.stringify([
      { kind: "fact-add", text: "User prefers dark themes", entities: ["themes"] },
      { kind: "fact-invalidate", id: "f_1" },
      { kind: "memory-edit", file: "MEMORY.md", action: "add", content: "note" },
    ]),
    "```",
    "Let me know if you need anything else.",
  ].join("\n");
  const ops = parseConsolidateOps(reply);
  assert.deepEqual(ops, [
    { kind: "fact-add", text: "User prefers dark themes", entities: ["themes"] },
    { kind: "fact-invalidate", id: "f_1" },
    { kind: "memory-edit", file: "MEMORY.md", action: "add", content: "note" },
  ]);
});

test("parseConsolidateOps: unknown kinds and malformed ops drop", () => {
  const ops = parseConsolidateOps(
    JSON.stringify([
      { kind: "fact-add", text: "keep me" },
      { kind: "core-rewrite", content: "nope" },
      { kind: "fact-add" }, // no text
      { kind: "fact-invalidate", id: "   " }, // blank id
      { kind: "memory-edit", file: "MEMORY.md", action: "destroy" }, // bad action
      "just a string",
      42,
    ]),
  );
  assert.deepEqual(ops, [{ kind: "fact-add", text: "keep me" }]);
});

test("parseConsolidateOps: more than 20 ops are capped at 20", () => {
  const many = Array.from({ length: 25 }, (_, index) => ({ kind: "fact-add", text: `fact number ${index}` }));
  const ops = parseConsolidateOps(JSON.stringify(many));
  assert.equal(ops.length, 20);
});

test("parseConsolidateOps: garbage → []", () => {
  assert.deepEqual(parseConsolidateOps("no json here at all"), []);
  assert.deepEqual(parseConsolidateOps("[unclosed and broken"), []);
  assert.deepEqual(parseConsolidateOps('{"kind":"fact-add","text":"not an array"}'), []);
  assert.deepEqual(parseConsolidateOps("[1, 2, 3]"), []);
  assert.deepEqual(parseConsolidateOps(""), []);
});

// --- runConsolidation --------------------------------------------------------

test("the llm input carries new episodes, active facts, and the core files", async () => {
  const dir = await memDir();
  const store = new MemoryStore();
  await store.init(dir, "Gaia");
  await seedFact(dir, "f_port", "The GAIA port is 8787");
  await appendEpisode(dir, episode({ task: "fix the flaky voice test" }));

  const calls: ConsolidateLlmInput[] = [];
  const result = await run(dir, store, cannedLlm("[]", calls));
  assert.equal(result.ran, true);
  assert.equal(result.episodesSeen, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /consolidator/);
  assert.ok(calls[0].user.includes("fix the flaky voice test"), "episode in prompt");
  assert.ok(calls[0].user.includes("The GAIA port is 8787"), "active fact in prompt");
  assert.ok(calls[0].user.includes("## MEMORY.md"), "core file in prompt");
  assert.ok(calls[0].user.includes("## USER.md"), "user file in prompt");
  assert.ok(calls[0].user.includes("# Gaia Memory"), "core file content in prompt");
});

test("fact-add applies with source consolidator; a normalized duplicate is skipped", async () => {
  const dir = await memDir();
  const store = new MemoryStore();
  await store.init(dir, "Gaia");
  await seedFact(dir, "f_port", "The GAIA port is 8787");
  await appendEpisode(dir, episode());

  const ops = [
    { kind: "fact-add", text: "User deploys to fly.io in region fra" },
    { kind: "fact-add", text: "  the gaia PORT is   8787 " }, // dup after normalization
  ];
  const result = await run(dir, store, cannedLlm(JSON.stringify(ops)));
  assert.equal(result.ran, true);
  assert.equal(result.factsAdded, 1);
  assert.equal(result.opsSkipped, 1);

  const { active } = replayFacts((await readFactOpsFrom(dir, 0)).items);
  const added = active.find((fact) => fact.text === "User deploys to fly.io in region fra");
  assert.ok(added, "new fact recorded");
  assert.equal(added.source, "consolidator");
  assert.equal(active.filter((fact) => fact.text.includes("8787")).length, 1, "no duplicate 8787 fact");
});

test("fact-add with invalidates supersedes: validTo + supersededBy point at the new id", async () => {
  const dir = await memDir();
  const store = new MemoryStore();
  await store.init(dir, "Gaia");
  await seedFact(dir, "f_old", "The old truth about ports");
  await appendEpisode(dir, episode());

  const ops = [{ kind: "fact-add", text: "The port moved to 9090", invalidates: "f_old" }];
  const result = await run(dir, store, cannedLlm(JSON.stringify(ops)));
  assert.equal(result.factsAdded, 1);
  assert.equal(result.factsInvalidated, 1);

  const { active, all } = replayFacts((await readFactOpsFrom(dir, 0)).items);
  const fresh = active.find((fact) => fact.text === "The port moved to 9090");
  assert.ok(fresh);
  const old = all.get("f_old");
  assert.ok(old?.validTo, "old fact got validTo");
  assert.equal(old.supersededBy, fresh.id, "supersededBy points at the new fact");
  assert.ok(!active.some((fact) => fact.id === "f_old"), "old fact no longer active");
});

test("guarded applies: an over-cap memory-edit and a secret-looking fact-add are skipped", async () => {
  const dir = await memDir();
  const store = new MemoryStore();
  await store.init(dir, "Gaia");
  await appendEpisode(dir, episode());
  const before = await readFile(join(dir, CORE_MEMORY_FILE), "utf8");

  const ops = [
    // Pushes MEMORY.md far past its 4000-char cap → mutate rejects.
    { kind: "memory-edit", file: "MEMORY.md", action: "add", content: "x".repeat(4200) },
    // Secret filter applies to the facts log exactly as to memory files.
    { kind: "fact-add", text: `the api key is sk-${"a".repeat(24)}` },
  ];
  const result = await run(dir, store, cannedLlm(JSON.stringify(ops)));
  assert.equal(result.ran, true);
  assert.equal(result.memoryEdits, 0);
  assert.equal(result.factsAdded, 0);
  assert.equal(result.opsSkipped, 2);
  assert.equal(await readFile(join(dir, CORE_MEMORY_FILE), "utf8"), before, "MEMORY.md unchanged");
  assert.deepEqual(replayFacts((await readFactOpsFrom(dir, 0)).items).active, [], "no fact written");
});

test("the cursor advances: a second run with nothing new skips (without force)", async () => {
  const dir = await memDir();
  const store = new MemoryStore();
  await store.init(dir, "Gaia");
  await appendEpisode(dir, episode());
  await appendEpisode(dir, episode());

  const first = await run(dir, store, cannedLlm("[]"));
  assert.equal(first.ran, true);
  assert.equal(first.episodesSeen, 2);

  const state = await readConsolidateState(dir);
  assert.equal(state.episodeCursor, 2, "episodeCursor persisted");
  assert.deepEqual(state.runs, [NOW.toISOString()], "run ledger appended");

  const second = await run(dir, store, cannedLlm("[]"));
  assert.equal(second.ran, false);
  assert.match(second.reason ?? "", /nothing new/);
  assert.deepEqual(await readConsolidateState(dir), state, "skipped run leaves state untouched");
});

test("maxPerDay caps runs; force bypasses the cap", async () => {
  const dir = await memDir();
  const store = new MemoryStore();
  await store.init(dir, "Gaia");
  await appendEpisode(dir, episode());
  await writeConsolidateState(dir, { episodeCursor: 0, runs: [NOW.toISOString(), NOW.toISOString(), NOW.toISOString()] });

  const capped = await run(dir, store, cannedLlm("[]"), { maxPerDay: 3 });
  assert.equal(capped.ran, false);
  assert.match(capped.reason ?? "", /daily cap/);

  const forced = await run(dir, store, cannedLlm("[]"), { maxPerDay: 3, force: true });
  assert.equal(forced.ran, true);
  assert.equal((await readConsolidateState(dir)).runs.length, 4, "forced run lands in the ledger");
});

// --- MemoryService.consolidate ------------------------------------------------

function makeAgent(root: string): AgentDef {
  const dir = join(root, "agents", "gaia");
  return {
    id: "gaia",
    displayName: "Gaia",
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

function memConfig(): MemoryConfig {
  return {
    autoRecall: true,
    autoRecallBudget: 1200,
    embeddings: "off",
    consolidate: { enabled: true, idleMinutes: 30, maxPerDay: 8 },
    decayHalfLifeDays: 60,
  };
}

test("MemoryService.consolidate: no llm → ran:false, reason mentions the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-memsvc-"));
  const agent = makeAgent(root);
  const service = new MemoryService({ workspaceMemory: memConfig, agents: () => ({ gaia: agent }), memoryStore: new MemoryStore() });
  const result = await service.consolidate("gaia");
  assert.equal(result.ran, false);
  assert.match(result.reason ?? "", /model/);
  service.dispose();
});

test("MemoryService.consolidate: concurrent calls are guarded per agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-memsvc-"));
  const agent = makeAgent(root);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new MemoryService({
    workspaceRoot: root,
    workspaceMemory: memConfig,
    agents: () => ({ gaia: agent }),
    memoryStore: new MemoryStore(),
    llm: async () => {
      await gate;
      return "[]";
    },
  });

  const first = service.consolidate("gaia", { force: true });
  const second = await service.consolidate("gaia");
  assert.equal(second.ran, false);
  assert.equal(second.reason, "already consolidating");

  release();
  const firstResult = await first;
  assert.equal(firstResult.ran, true, "the in-flight run completes normally");
  service.dispose();
});

// --- P4: two-scope facts + user_stated immutability (§5, §13) ---------------------------

test("scope routing: workspace-scope adds land in the shared store with actor; agent scope stays home", async () => {
  const dir = await memDir();
  const shared = await memDir();
  const store = new MemoryStore();
  await appendEpisode(dir, episode());
  const llm = cannedLlm(
    JSON.stringify([
      { kind: "fact-add", text: "The user prefers absolute dates everywhere in notes and facts", scope: "workspace" },
      { kind: "fact-add", text: "I read the user as trusting me more after the June repair", scope: "agent" },
      { kind: "fact-add", text: "Default scope stays agent when the model names none" },
    ]),
  );
  const result = await runConsolidation({ memoryDir: dir, agentId: "gaia", memoryStore: store, llm, maxPerDay: 8, sharedFactsDir: shared, now: NOW });
  assert.equal(result.factsAdded, 3);

  const sharedFacts = replayFacts((await readFactOpsFrom(shared, 0)).items).active;
  assert.equal(sharedFacts.length, 1);
  assert.match(sharedFacts[0].text, /absolute dates/);
  assert.equal(sharedFacts[0].scope, "workspace");
  assert.equal(sharedFacts[0].actor, "agent:gaia");

  const agentFacts = replayFacts((await readFactOpsFrom(dir, 0)).items).active;
  assert.equal(agentFacts.length, 2);
  assert.ok(agentFacts.every((fact) => fact.scope === undefined), "agent-scope facts carry no scope field (v3-compatible)");
});

test("shared facts feed dedupe and the prompt; a workspace fact can be superseded in ITS store", async () => {
  const dir = await memDir();
  const shared = await memDir();
  const store = new MemoryStore();
  await appendFactOp(shared, {
    op: "add", id: "f_shared_old", ts: "2026-06-01T00:00:00.000Z",
    text: "the user works from Berlin", source: "consolidator", scope: "workspace", actor: "agent:gaia", validFrom: "2026-06-01T00:00:00.000Z",
  });
  await appendEpisode(dir, episode());
  const calls: ConsolidateLlmInput[] = [];
  const llm = cannedLlm(
    JSON.stringify([
      { kind: "fact-add", text: "The user works from Berlin" }, // dup of the SHARED fact → skip
      { kind: "fact-add", text: "The user relocated to Hamburg in June 2026", scope: "workspace", invalidates: "f_shared_old" },
    ]),
    calls,
  );
  const result = await runConsolidation({ memoryDir: dir, agentId: "gaia", memoryStore: store, llm, maxPerDay: 8, sharedFactsDir: shared, now: NOW });
  assert.ok(calls[0].user.includes("works from Berlin"), "shared facts render in the prompt");
  assert.ok(calls[0].user.includes("· workspace]"), "scope marker shown");
  assert.equal(result.opsSkipped, 1, "cross-store duplicate dropped");
  assert.equal(result.factsAdded, 1);
  assert.equal(result.factsInvalidated, 1);

  const { all } = replayFacts((await readFactOpsFrom(shared, 0)).items);
  const old = all.get("f_shared_old");
  assert.ok(old?.validTo, "superseded in the shared store");
  assert.ok(old?.supersededBy);
});

test("user_stated is immutable to the consolidator: bare invalidate drops; supersession is allowed", async () => {
  const dir = await memDir();
  const store = new MemoryStore();
  await seedFact(dir, "f_user", "the user said the daemon must keep running on :8787");
  await appendEpisode(dir, episode());

  // Bare invalidate → skipped.
  const bare = await run(dir, store, cannedLlm(JSON.stringify([{ kind: "fact-invalidate", id: "f_user" }])));
  assert.equal(bare.factsInvalidated, 0);
  assert.equal(bare.opsSkipped, 1);
  let facts = replayFacts((await readFactOpsFrom(dir, 0)).items);
  assert.equal(facts.all.get("f_user")?.validTo, undefined, "user_stated fact untouched");

  // Supersession (fact-add + invalidates) → allowed, record preserved.
  await appendEpisode(dir, episode({ id: `ep_${(seq += 1)}` }));
  const supersede = await run(dir, store, cannedLlm(JSON.stringify([{ kind: "fact-add", text: "The user moved the daemon to port 9900 on 2026-06-30", invalidates: "f_user" }])), { force: true });
  assert.equal(supersede.factsAdded, 1);
  assert.equal(supersede.factsInvalidated, 1);
  facts = replayFacts((await readFactOpsFrom(dir, 0)).items);
  assert.ok(facts.all.get("f_user")?.validTo, "superseded, not erased");
  assert.ok(facts.all.get("f_user")?.supersededBy, "points at the newer truth");
});
