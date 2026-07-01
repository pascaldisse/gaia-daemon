// Memory v3 hybrid index (src/domain/memory-index.ts): FTS5 over facts +
// episodes + room transcripts, an optional brute-force vector list, RRF
// fusion, then recency-decay × provenance weighting. The JSONL logs are the
// source of truth; index.db is derived and rebuilds itself. Scores are only
// ever asserted RELATIVELY (ordering / presence), never as absolute values.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEpisode } from "../src/domain/episodes.js";
import type { Episode } from "../src/domain/episodes.js";
import { appendFactOp } from "../src/domain/facts.js";
import type { FactSource } from "../src/domain/facts.js";
import { formatMemoryHits, pendingEmbeddings, searchMemory, storeEmbeddings } from "../src/domain/memory-index.js";
import type { MemorySearchHit } from "../src/domain/memory-index.js";

process.env.GAIA_HOME = await mkdtemp(join(tmpdir(), "gaia-home-"));

const NOW = new Date("2026-07-01T00:00:00.000Z");
const RECENT_TS = "2026-06-30T00:00:00.000Z";

async function memDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gaia-index-"));
}

let seq = 0;
async function addFact(dir: string, text: string, options: { id?: string; ts?: string; source?: FactSource } = {}): Promise<string> {
  const id = options.id ?? `fact_${(seq += 1)}`;
  const ts = options.ts ?? RECENT_TS;
  const result = await appendFactOp(dir, { op: "add", id, ts, text, source: options.source ?? "user_stated", validFrom: ts });
  assert.equal(result.ok, true, result.message);
  return id;
}

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: `ep_${(seq += 1)}`,
    ts: RECENT_TS,
    roomId: "default",
    agentId: "gaia",
    task: "fix the flaky unmute voice test",
    reply: "found the race in the websocket setup",
    outcome: "complete",
    ...overrides,
  };
}

function facts(hits: MemorySearchHit[]): MemorySearchHit[] {
  return hits.filter((hit) => hit.kind === "fact");
}

test("lexical-only: a matching fact comes back kind:fact with source; an episode with outcome", async () => {
  const dir = await memDir();
  await addFact(dir, "The GAIA daemon listens on port 8787 by default");
  await appendEpisode(dir, episode({ outcome: "error" }));

  const factHits = await searchMemory("port 8787", { memoryDir: dir, now: NOW });
  assert.ok(factHits.length >= 1);
  assert.equal(factHits[0].kind, "fact");
  assert.equal(factHits[0].source, "user_stated");
  assert.ok(factHits[0].text.includes("8787"));
  assert.ok(factHits[0].score > 0);

  const episodeHits = await searchMemory("flaky websocket race", { memoryDir: dir, now: NOW });
  const hit = episodeHits.find((candidate) => candidate.kind === "episode");
  assert.ok(hit, "episode hit expected");
  assert.equal(hit.outcome, "error");
  // Without a lesson, the episode text is "task → reply".
  assert.ok(hit.text.includes("fix the flaky unmute voice test"));
  assert.ok(hit.text.includes("→"));
});

test("invalidated facts are excluded by default and included with includeInvalidated", async () => {
  const dir = await memDir();
  await addFact(dir, "The zorblat port was 9999", { id: "fact_old" });
  await addFact(dir, "The zorblat port is 8888", { id: "fact_new" });
  await appendFactOp(dir, { op: "invalidate", id: "fact_old", ts: RECENT_TS, supersededBy: "fact_new" });

  const current = await searchMemory("zorblat", { memoryDir: dir, now: NOW });
  assert.deepEqual(facts(current).map((hit) => hit.id), ["fact_new"]);

  const historical = await searchMemory("zorblat", { memoryDir: dir, now: NOW, includeInvalidated: true });
  const ids = facts(historical).map((hit) => hit.id);
  assert.ok(ids.includes("fact_old"), `invalidated fact reachable on demand (got ${ids.join(", ")})`);
  assert.ok(ids.includes("fact_new"));
});

test("room transcripts merge into the hybrid results", async () => {
  const dir = await memDir();
  await addFact(dir, "gaia voice uses the unmute stack", { ts: "2026-06-25T00:00:00.000Z" });

  const roomDir = await mkdtemp(join(tmpdir(), "gaia-room-"));
  const transcriptPath = join(roomDir, "transcript.jsonl");
  const lines = [
    { id: "e1", timestamp: "2026-06-20T10:00:00.000Z", author: "user", text: "can you check the unmute voice backend again" },
    { id: "e2", timestamp: "2026-06-20T10:01:00.000Z", author: "gaia", text: "the unmute backend is healthy" },
  ];
  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  const hits = await searchMemory("unmute", {
    memoryDir: dir,
    rooms: [{ roomId: "lab", transcriptPath, dbPath: join(roomDir, "recall.db") }],
    now: NOW,
  });
  const transcriptHits = hits.filter((hit) => hit.kind === "transcript");
  assert.ok(transcriptHits.length >= 1, "a transcript hit appears");
  assert.equal(transcriptHits[0].roomId, "lab");
  assert.ok(transcriptHits.some((hit) => hit.author === "user"));
  assert.ok(hits.some((hit) => hit.kind === "fact"), "fact hits merge alongside transcript hits");
});

test("RRF fusion: the query vector pulls the aligned fact to the top", async () => {
  const dir = await memDir();
  await addFact(dir, "gaia handles deployment and hosting", { id: "fact_deploy" });
  await addFact(dir, "gaia handles theming and colors", { id: "fact_theme" });

  // pendingEmbeddings hands back [hash, text] rows; store fake unit vectors.
  const pending = await pendingEmbeddings(dir);
  assert.equal(pending.length, 2);
  await storeEmbeddings(
    dir,
    pending.map((row) => ({
      hash: row.hash,
      vec: row.text.includes("deployment") ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]),
    })),
  );

  // Both facts tie lexically on "gaia"; the vector list breaks the tie.
  const deployFirst = await searchMemory("gaia", { memoryDir: dir, queryVec: Float32Array.from([1, 0]), now: NOW });
  assert.equal(facts(deployFirst).length, 2);
  assert.equal(facts(deployFirst)[0].id, "fact_deploy");

  const themeFirst = await searchMemory("gaia", { memoryDir: dir, queryVec: Float32Array.from([0, 1]), now: NOW });
  assert.equal(facts(themeFirst)[0].id, "fact_theme");
});

test("recency decay ranks the newer of two equally-relevant facts higher; the old one stays (floor, not filter)", async () => {
  const dir = await memDir();
  await addFact(dir, "signal alpha marker", { id: "fact_fresh", ts: "2026-06-28T00:00:00.000Z" });
  await addFact(dir, "signal beta marker", { id: "fact_stale", ts: "2024-07-01T00:00:00.000Z" });

  const hits = facts(await searchMemory("signal", { memoryDir: dir, now: NOW }));
  assert.equal(hits.length, 2, "the two-year-old fact is floored, never dropped");
  assert.equal(hits[0].id, "fact_fresh");
  assert.equal(hits[1].id, "fact_stale");
  assert.ok(hits[0].score > hits[1].score);
  assert.ok(hits[1].score > 0);
});

test("provenance: user_stated outranks consolidator for the same wording", async () => {
  const dir = await memDir();
  const text = "the deploy target is the fra region";
  await addFact(dir, text, { id: "fact_cons", source: "consolidator" });
  await addFact(dir, text, { id: "fact_user", source: "user_stated" });

  const hits = facts(await searchMemory("deploy target fra", { memoryDir: dir, now: NOW }));
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "fact_user");
  assert.equal(hits[0].source, "user_stated");
  assert.ok(hits[0].score > hits[1].score);
});

test("incremental sync picks up appended facts; a hand-truncated log forces a consistent rebuild", async () => {
  const dir = await memDir();
  await addFact(dir, "the quokka mascot ships with the docs");
  assert.equal(facts(await searchMemory("quokka", { memoryDir: dir, now: NOW })).length, 1);

  // Appended AFTER the index was built → picked up incrementally.
  await addFact(dir, "the wombat job digs through backlogs");
  assert.equal(facts(await searchMemory("wombat", { memoryDir: dir, now: NOW })).length, 1);

  // Source shrank (hand-edit) → the facts table rebuilds from scratch.
  const factsPath = join(dir, "facts.jsonl");
  const [firstLine] = (await readFile(factsPath, "utf8")).trim().split("\n");
  await writeFile(factsPath, `${firstLine}\n`, "utf8");
  assert.equal(facts(await searchMemory("wombat", { memoryDir: dir, now: NOW })).length, 0, "truncated-away fact is gone");
  assert.equal(facts(await searchMemory("quokka", { memoryDir: dir, now: NOW })).length, 1, "surviving fact still served");
});

test("formatMemoryHits renders fact, episode, and transcript lines", () => {
  const hits: MemorySearchHit[] = [
    { kind: "fact", id: "f1", text: "port is 8787", ts: "2026-07-01T10:00:00.000Z", score: 1, source: "user_stated" },
    { kind: "episode", id: "e1", text: "fix tests → done", ts: "2026-06-01T10:00:00.000Z", score: 1, outcome: "complete" },
    { kind: "transcript", text: "hello there", ts: "2026-05-01T10:00:00.000Z", score: 1, author: "user", roomId: "lab" },
  ];
  const lines = formatMemoryHits(hits).split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "[2026-07-01 · fact · user_stated] port is 8787");
  assert.equal(lines[1], "[2026-06-01 · episode · complete] fix tests → done");
  assert.equal(lines[2], "[2026-05-01T10:00:00.000Z] @user (lab): hello there");
});
