import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EPISODES_FILE, appendEpisode, readEpisodesFrom } from "../src/domain/episodes.js";
import type { Episode } from "../src/domain/episodes.js";
import { FACTS_FILE, appendFactOp, findDuplicateFact, readFactOpsFrom, replayFacts } from "../src/domain/facts.js";
import type { Fact } from "../src/domain/facts.js";
import { MemoryStore, looksLikeSecret } from "../src/domain/memory.js";

async function memDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gaia-mem-"));
}

function episode(overrides: Partial<Episode>): Episode {
  return {
    id: "ep_1",
    ts: "2026-07-01T00:00:00Z",
    roomId: "default",
    agentId: "gaia",
    task: "fix the flaky voice test",
    reply: "found the race",
    outcome: "complete",
    ...overrides,
  };
}

test("episodes: append + read roundtrip; task/reply truncated to 400", async () => {
  const dir = await memDir();
  const long = "x".repeat(500);
  await appendEpisode(dir, episode({ task: long, reply: long, tools: ["read", "bash"], channel: "voice" }));

  const { items, nextCursor } = await readEpisodesFrom(dir, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].task.length, 400);
  assert.equal(items[0].reply.length, 400);
  assert.equal(items[0].outcome, "complete");
  assert.deepEqual(items[0].tools, ["read", "bash"]);
  assert.equal(items[0].channel, "voice");
  assert.equal(nextCursor, 1);
});

test("episodes: malformed lines are skipped but still counted by the cursor", async () => {
  const dir = await memDir();
  await appendEpisode(dir, episode({ id: "ep_1" }));
  await appendFile(join(dir, EPISODES_FILE), `not json\n${JSON.stringify({ id: "ep_no_outcome", ts: "t", task: "x" })}\n`, "utf8");
  await appendEpisode(dir, episode({ id: "ep_2" }));

  const { items, nextCursor } = await readEpisodesFrom(dir, 0);
  assert.deepEqual(items.map((item) => item.id), ["ep_1", "ep_2"]);
  assert.equal(nextCursor, 4); // junk + invalid lines count, so cursors stay stable

  const tail = await readEpisodesFrom(dir, 3);
  assert.equal(tail.items.length, 1);
  assert.equal(tail.items[0].id, "ep_2");
});

test("facts: add + invalidate replay; unknown target is a no-op; active is newest-first", async () => {
  const dir = await memDir();
  await appendFactOp(dir, { op: "add", id: "fact_1", ts: "2026-01-01T00:00:00Z", text: "port is 8080", source: "user_stated", validFrom: "2026-01-01T00:00:00Z" });
  await appendFactOp(dir, { op: "add", id: "fact_2", ts: "2026-02-01T00:00:00Z", text: "port is 8787", source: "user_stated", validFrom: "2026-02-01T00:00:00Z" });
  await appendFactOp(dir, { op: "invalidate", id: "fact_1", ts: "2026-02-01T00:00:01Z", supersededBy: "fact_2" });
  await appendFactOp(dir, { op: "invalidate", id: "fact_unknown", ts: "2026-02-01T00:00:02Z" });
  await appendFactOp(dir, { op: "add", id: "fact_3", ts: "2026-03-01T00:00:00Z", text: "theme is tokyo night", source: "agent_inferred", validFrom: "2026-03-01T00:00:00Z" });
  await appendFile(join(dir, FACTS_FILE), "junk line\n", "utf8");

  const { items, nextCursor } = await readFactOpsFrom(dir, 0);
  assert.equal(items.length, 5);
  assert.equal(nextCursor, 6);

  const { active, all } = replayFacts(items);
  assert.deepEqual(active.map((fact) => fact.id), ["fact_3", "fact_2"]);
  assert.equal(all.size, 3);
  assert.equal(all.get("fact_1")?.validTo, "2026-02-01T00:00:01Z");
  assert.equal(all.get("fact_1")?.supersededBy, "fact_2");
  assert.equal(all.get("fact_2")?.validTo, undefined);
});

test("appendFactOp rejects secret-looking and empty text; nothing is appended", async () => {
  const dir = await memDir();
  const fakeKey = "sk-" + "a".repeat(24);
  const secret = await appendFactOp(dir, { op: "add", id: "fact_s", ts: "t", text: `the key is ${fakeKey}`, source: "agent_inferred", validFrom: "t" });
  assert.equal(secret.ok, false);
  assert.equal(secret.message, "fact rejected: content looks like a secret");

  const empty = await appendFactOp(dir, { op: "add", id: "fact_e", ts: "t", text: "   ", source: "agent_inferred", validFrom: "t" });
  assert.equal(empty.ok, false);

  assert.equal(existsSync(join(dir, FACTS_FILE)), false);
  assert.deepEqual((await readFactOpsFrom(dir, 0)).items, []);
});

test("findDuplicateFact normalizes case and whitespace", () => {
  const fact: Fact = { id: "fact_1", ts: "t", text: "The  Port is\t8787", source: "user_stated", validFrom: "t" };
  assert.equal(findDuplicateFact([fact], "  the port is 8787 "), fact);
  assert.equal(findDuplicateFact([fact], "the port is 8788"), undefined);
  assert.equal(findDuplicateFact([], "anything"), undefined);
});

test("looksLikeSecret is exported and still blocks memory mutate", async () => {
  const fakeKey = "sk-" + "b".repeat(24);
  assert.equal(looksLikeSecret(fakeKey), true);
  assert.equal(looksLikeSecret("a plain note about api keys"), false);

  const dir = await memDir();
  const store = new MemoryStore();
  await store.init(dir, "Gaia");
  const result = await store.mutate(dir, "MEMORY.md", "add", { content: `token: ${fakeKey}` });
  assert.equal(result.ok, false);
  assert.match(result.message, /looks like a secret/);
});
