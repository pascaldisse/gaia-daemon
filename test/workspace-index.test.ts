// Memory v4 workspace index (src/domain/workspace-index.ts): ONE derived
// SQLite file per workspace — transcript chunks (all rooms) + per-agent facts
// and episodes, global bm25 with score-magnitude fusion, active-context
// self-match exclusion, loud health, and the v3 retirement sweep. The JSONL
// logs and transcripts are the source of truth; index.db is derived and
// rebuilds itself. Scores are only ever asserted RELATIVELY.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, appendFile, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEpisode } from "../src/domain/episodes.js";
import { appendFactOp } from "../src/domain/facts.js";
import type { FactSource } from "../src/domain/facts.js";
import {
  bareWorkspaceRecall,
  buildChunks,
  countEmbeddings,
  expandChunkWindows,
  formatMemoryHits,
  ftsQuery,
  MAX_FTS_TERMS,
  openWorkspaceIndex,
  pendingEmbeddings,
  prepareVector,
  quantizeInt8,
  readHealth,
  scrollTranscriptWindow,
  searchTranscripts,
  searchWorkspaceIndex,
  SEARCH_MARK_CLOSE,
  SEARCH_MARK_OPEN,
  sharedMemorySource,
  setHealth,
  storeEmbeddings,
  syncWorkspaceIndex,
  workspaceRoomRefs,
  type MemorySearchHit,
  type WorkspaceIndexSources,
} from "../src/domain/workspace-index.js";

process.env.GAIA_HOME = await mkdtemp(join(tmpdir(), "gaia-home-"));

const NOW = new Date("2026-07-01T00:00:00.000Z");
const RECENT_TS = "2026-06-30T00:00:00.000Z";
const OLD_TS = "2026-06-10T00:00:00.000Z";

let seq = 0;

interface RoomSpec {
  roomId: string;
  events: Array<{ author: string; text: string; ts?: string; id?: string }>;
  /** File mtime, seconds ago relative to real now (recentRoomRefs sorts by it). */
  ageSec?: number;
  /** Seed this room's state.json as incognito (excluded from workspaceRoomRefs). */
  incognito?: boolean;
}

/** A throwaway workspace root with rooms + one agent's memory dir. */
async function makeWorkspace(rooms: RoomSpec[] = []): Promise<{ root: string; memoryDir: string; sources: WorkspaceIndexSources }> {
  const root = await mkdtemp(join(tmpdir(), "gaia-ws-"));
  const memoryDir = join(root, "agents", "gaia", "persona", "memory");
  await mkdir(memoryDir, { recursive: true });
  for (const room of rooms) await writeRoom(root, room);
  return {
    root,
    memoryDir,
    sources: { rooms: workspaceRoomRefs(root), agents: [{ agentId: "gaia", memoryDir }] },
  };
}

async function writeRoom(root: string, room: RoomSpec): Promise<string> {
  const dir = join(root, ".gaia", "rooms", room.roomId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "transcript.jsonl");
  const lines = room.events.map((event, i) =>
    JSON.stringify({ id: event.id ?? `${room.roomId}_e${i}`, timestamp: event.ts ?? RECENT_TS, author: event.author, text: event.text }),
  );
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  if (room.incognito) {
    await writeFile(join(dir, "state.json"), JSON.stringify({ activeRoles: {}, agentCursors: {}, incognito: true }), "utf8");
  }
  if (room.ageSec) {
    const at = new Date(Date.now() - room.ageSec * 1000);
    await utimes(path, at, at);
  }
  return path;
}

async function addFact(dir: string, text: string, options: { id?: string; ts?: string; source?: FactSource } = {}): Promise<string> {
  const id = options.id ?? `fact_${(seq += 1)}`;
  const ts = options.ts ?? RECENT_TS;
  const result = await appendFactOp(dir, { op: "add", id, ts, text, source: options.source ?? "user_stated", validFrom: ts });
  assert.equal(result.ok, true, result.message);
  return id;
}

function facts(hits: MemorySearchHit[]): MemorySearchHit[] {
  return hits.filter((hit) => hit.kind === "fact");
}

function chunks(hits: MemorySearchHit[]): MemorySearchHit[] {
  return hits.filter((hit) => hit.kind === "transcript");
}

// --- chunking ------------------------------------------------------------------

test("buildChunks: a short tail stays one OPEN chunk; enough text closes on turn boundaries within 600–1000 chars", () => {
  const short = buildChunks([
    { idx: 0, id: "a", ts: RECENT_TS, author: "user", text: "hello" },
    { idx: 1, id: "b", ts: RECENT_TS, author: "gaia", text: "hi there" },
  ]);
  assert.equal(short.length, 1);
  assert.equal(short[0].open, true);
  assert.deepEqual(short[0].eventIds, ["a", "b"]);
  assert.deepEqual(short[0].speakers, ["user", "gaia"]);

  const wordy = Array.from({ length: 12 }, (_, i) => ({
    idx: i,
    id: `e${i}`,
    ts: RECENT_TS,
    author: i % 2 ? "gaia" : "user",
    text: `message number ${i} ` + "lorem ipsum dolor sit amet ".repeat(8), // ~230 chars each
  }));
  const out = buildChunks(wordy);
  assert.ok(out.length >= 3, `multiple chunks (got ${out.length})`);
  for (const chunk of out.slice(0, -1)) {
    assert.equal(chunk.open, false);
    assert.ok(chunk.text.length <= 1000, `closed chunk ≤1000 chars (got ${chunk.text.length})`);
    assert.ok(chunk.text.length >= 400, `closed chunk is substantial (got ${chunk.text.length})`);
  }
  // Contiguity: chunk boundaries meet with no gaps or overlaps.
  for (let i = 1; i < out.length; i += 1) assert.equal(out[i].firstIdx, out[i - 1].lastIdx + 1);
});

test("buildChunks: a single oversized event splits into CLOSED single-event pieces", () => {
  const big = buildChunks([{ idx: 5, id: "huge", ts: RECENT_TS, author: "user", text: "paragraph one.\n\n" + "x".repeat(2600) }]);
  assert.ok(big.length >= 3, `split into pieces (got ${big.length})`);
  for (const piece of big) {
    assert.equal(piece.open, false);
    assert.deepEqual(piece.eventIds, ["huge"]);
    assert.equal(piece.firstIdx, 5);
    assert.ok(piece.text.length <= 1000);
  }
});

// --- chat search (web client) ----------------------------------------------------

test("searchTranscripts: transcript-only, cross-room, with event_ids and marked snippet", async () => {
  const { root, memoryDir, sources } = await makeWorkspace([
    { roomId: "kitchen", events: [{ author: "user", text: "the sourdough needs a longer autolyse", id: "k0" }, { author: "gaia", text: "raise the hydration too", id: "k1" }] },
    { roomId: "garage", events: [{ author: "user", text: "the autolyse of the epoxy took all night", id: "g0" }] },
  ]);
  // A matching fact must NOT leak into chat search (transcript-only).
  await addFact(memoryDir, "the autolyse step matters for sourdough");

  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    const hits = searchTranscripts(db, "autolyse");
    // Both rooms matched; no facts/episodes in the result set.
    const rooms = new Set(hits.map((hit) => hit.roomId));
    assert.ok(rooms.has("kitchen") && rooms.has("garage"), `both rooms matched (got ${[...rooms].join(", ")})`);
    // Every hit resolves to concrete message ids for navigation.
    for (const hit of hits) assert.ok(hit.eventIds.length >= 1, "hit carries event ids");
    const kitchen = hits.find((hit) => hit.roomId === "kitchen");
    assert.ok(kitchen?.eventIds.includes("k0"), "kitchen hit points at the matching message");
    // The FTS snippet wraps the matched term in the sentinels the client swaps for <mark>.
    assert.ok(hits.some((hit) => hit.snippet.includes(SEARCH_MARK_OPEN) && hit.snippet.includes(SEARCH_MARK_CLOSE)), "snippet marks the match");
  } finally {
    db.close();
  }
});

test("incognito rooms are omitted from workspaceRoomRefs, so their transcripts never enter recall", async () => {
  const { root, sources } = await makeWorkspace([
    { roomId: "kitchen", events: [{ author: "user", text: "the sourdough needs a longer autolyse", id: "k0" }] },
    { roomId: "vault", incognito: true, events: [{ author: "user", text: "the autolyse secret is a longer overnight rest", id: "v0" }] },
  ]);
  // The incognito room is absent from the shared room list...
  assert.deepEqual(
    sources.rooms.map((ref) => ref.roomId).sort(),
    ["kitchen"],
    "workspaceRoomRefs excludes the incognito room",
  );

  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    const hits = searchTranscripts(db, "autolyse");
    const rooms = new Set(hits.map((hit) => hit.roomId));
    assert.ok(rooms.has("kitchen"), "the normal room is recallable");
    assert.ok(!rooms.has("vault"), "the incognito room never reaches recall");
  } finally {
    db.close();
  }
});

test("searchTranscripts: roomId scopes to a single chat (in-chat search)", async () => {
  const { root, sources } = await makeWorkspace([
    { roomId: "kitchen", events: [{ author: "user", text: "the sourdough needs a longer autolyse", id: "k0" }] },
    { roomId: "garage", events: [{ author: "user", text: "the autolyse of the epoxy took all night", id: "g0" }] },
  ]);
  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    const scoped = searchTranscripts(db, "autolyse", { roomId: "garage" });
    assert.ok(scoped.length >= 1, "found the match in the scoped room");
    assert.ok(
      scoped.every((hit) => hit.roomId === "garage"),
      "no hits leak from other rooms",
    );
  } finally {
    db.close();
  }
});

// --- sync + search ----------------------------------------------------------------

test("global search: fact, episode, and transcript-chunk hits come back attributed", async () => {
  const { root, memoryDir, sources } = await makeWorkspace([
    { roomId: "lab", events: [{ author: "user", text: "can you check the unmute voice backend again" }, { author: "gaia", text: "the unmute backend is healthy" }] },
  ]);
  await addFact(memoryDir, "gaia voice uses the unmute stack");
  await appendEpisode(memoryDir, {
    id: `ep_${(seq += 1)}`,
    ts: RECENT_TS,
    roomId: "lab",
    agentId: "gaia",
    task: "debug the unmute websocket race",
    reply: "found it",
    outcome: "error",
  });

  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    const hits = searchWorkspaceIndex(db, "unmute voice backend", { agentId: "gaia", now: NOW });
    assert.ok(facts(hits).length >= 1, "fact hit present");
    assert.equal(facts(hits)[0].source, "user_stated");
    const episodeHit = hits.find((hit) => hit.kind === "episode");
    assert.ok(episodeHit, "episode hit present");
    assert.equal(episodeHit.outcome, "error");
    const chunkHits = chunks(hits);
    assert.ok(chunkHits.length >= 1, "transcript chunk hit present");
    assert.equal(chunkHits[0].roomId, "lab");
    assert.ok(chunkHits[0].speakers && chunkHits[0].speakers.length >= 1, "speakers attributed");
    assert.ok(chunkHits[0].text.includes("@user:"), "chunk text is a real attributed excerpt, not a 48-char snippet");
  } finally {
    db.close();
  }
});

test("REGRESSION (v3 failure #3): a strong match in an OLD room outranks weak matches in RECENT rooms", async () => {
  // v3 folded per-room bm25 lists by rank: every room's best hit tied at 1/60
  // and recency decay decided — recent noise buried the real conversation.
  // Global bm25 keeps score magnitude, so the June room must win now.
  const rooms: RoomSpec[] = [
    {
      roomId: "epic-fail-with-iran",
      ageSec: 20 * 86_400,
      events: [
        {
          author: "nyari",
          ts: OLD_TS,
          text: "the strike targeting used a model for military selection and school children in iran were killed when the targeting failed",
        },
      ],
    },
  ];
  // Twenty recent rooms that each contain ONE common query term.
  for (let i = 0; i < 20; i += 1) {
    rooms.push({ roomId: `recent-${i}`, ageSec: 60 * i, events: [{ author: "user", ts: RECENT_TS, text: `the model shipped feature ${i} today` }] });
  }
  const { root, sources } = await makeWorkspace(rooms);
  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    const hits = searchWorkspaceIndex(db, "model used killing iran school children strike targeting military", { agentId: "gaia", now: NOW, limit: 8 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].roomId, "epic-fail-with-iran", `the June room wins on score magnitude (got ${hits[0].roomId}: ${hits[0].text.slice(0, 60)})`);
  } finally {
    db.close();
  }
});

test("self-match exclusion: the asking room's active window is dropped; content below the floor stays reachable", async () => {
  const marker = "the zorblat launch plan was finalized";
  // The old event is padded past the chunk max so it CLOSES its own chunk(s):
  // the compaction floor then falls on a chunk boundary. (A chunk straddling
  // the floor is conservatively treated as in-context.)
  const padding = "we worked through the details for a long while. ".repeat(21);
  const { root, memoryDir, sources } = await makeWorkspace([
    {
      roomId: "current",
      events: [
        { author: "user", ts: OLD_TS, text: `${marker} months ago in this very room. ${padding}` },
        { author: "user", ts: RECENT_TS, text: "did we ever discuss the zorblat launch plan?" },
      ],
    },
    { roomId: "other", events: [{ author: "user", ts: OLD_TS, text: `${marker} — and the other room knew it too` }] },
  ]);
  await appendEpisode(memoryDir, {
    id: `ep_${(seq += 1)}`,
    ts: RECENT_TS,
    roomId: "current",
    agentId: "gaia",
    task: "asked about the zorblat launch plan",
    reply: "answered from context",
    outcome: "complete",
  });
  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);

    // floorIdx 0 = the whole current room is in context → only the other room hits.
    const excluded = searchWorkspaceIndex(db, "zorblat launch plan", { agentId: "gaia", now: NOW, exclude: { roomId: "current", floorIdx: 0 } });
    assert.ok(chunks(excluded).length >= 1);
    assert.ok(chunks(excluded).every((hit) => hit.roomId === "other"), `self-matches dropped (got ${chunks(excluded).map((h) => h.roomId).join(",")})`);
    assert.ok(excluded.every((hit) => !(hit.kind === "episode" && hit.roomId === "current")), "the asking room's episodes are self-matches too");

    // floor above the old event = it was compacted away → reachable again,
    // while the fresh asking event (at/above the floor) stays excluded.
    const compacted = searchWorkspaceIndex(db, "zorblat launch plan", { agentId: "gaia", now: NOW, exclude: { roomId: "current", floorIdx: 1 } });
    const currentHits = chunks(compacted).filter((hit) => hit.roomId === "current");
    assert.ok(currentHits.length >= 1, "compacted-away content is recall-reachable");
    assert.ok(currentHits.every((hit) => !hit.text.includes("did we ever discuss")), "the fresh asking event stays excluded");

    // No exclusion → the asking room matches itself (the recall tool without context).
    const bare = searchWorkspaceIndex(db, "zorblat launch plan", { agentId: "gaia", now: NOW });
    assert.ok(chunks(bare).some((hit) => hit.roomId === "current"));
  } finally {
    db.close();
  }
});

test("facts: invalidated excluded by default, includeInvalidated reaches them; provenance weighting; decay floors old facts", async () => {
  const { root, memoryDir, sources } = await makeWorkspace();
  await addFact(memoryDir, "The zorblat port was 9999", { id: "fact_old_port" });
  await addFact(memoryDir, "The zorblat port is 8888", { id: "fact_new_port" });
  await appendFactOp(memoryDir, { op: "invalidate", id: "fact_old_port", ts: RECENT_TS, supersededBy: "fact_new_port" });
  const same = "the deploy target is the fra region";
  await addFact(memoryDir, same, { id: "fact_cons", source: "consolidator" });
  await addFact(memoryDir, same + " for gaia", { id: "fact_user", source: "user_stated" });
  await addFact(memoryDir, "signal alpha marker", { id: "fact_fresh", ts: "2026-06-28T00:00:00.000Z" });
  await addFact(memoryDir, "signal beta marker", { id: "fact_stale", ts: "2024-07-01T00:00:00.000Z" });

  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);

    const current = searchWorkspaceIndex(db, "zorblat port", { agentId: "gaia", now: NOW });
    assert.deepEqual(facts(current).map((hit) => hit.id), ["fact_new_port"]);
    const historical = searchWorkspaceIndex(db, "zorblat port", { agentId: "gaia", now: NOW, includeInvalidated: true });
    assert.ok(facts(historical).some((hit) => hit.id === "fact_old_port"), "invalidated fact reachable on demand");

    const provenance = facts(searchWorkspaceIndex(db, "deploy target fra region", { agentId: "gaia", now: NOW }));
    assert.equal(provenance[0].id, "fact_user", "user_stated outranks consolidator");

    const decayed = facts(searchWorkspaceIndex(db, "signal marker", { agentId: "gaia", now: NOW }));
    assert.equal(decayed.length, 2, "the two-year-old fact is floored, never dropped");
    assert.equal(decayed[0].id, "fact_fresh");
    assert.ok(decayed[1].score > 0);
  } finally {
    db.close();
  }
});

test("agent scoping: facts belong to their persona; transcript chunks are workspace-wide", async () => {
  const { root, memoryDir, sources } = await makeWorkspace([
    { roomId: "nyari-room", events: [{ author: "nyari", ts: OLD_TS, text: "the palantir affair discussion happened right here with plenty of detail" }] },
  ]);
  const nyariDir = join(root, "agents", "nyari", "persona", "memory");
  await mkdir(nyariDir, { recursive: true });
  await addFact(memoryDir, "gaia private fact about the palantir affair");
  await addFact(nyariDir, "nyari private fact about the palantir affair");
  sources.agents.push({ agentId: "nyari", memoryDir: nyariDir });

  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    const asGaia = searchWorkspaceIndex(db, "palantir affair", { agentId: "gaia", now: NOW });
    assert.ok(facts(asGaia).every((hit) => hit.text.startsWith("gaia")), "only gaia's facts in gaia's scope (workspace-shared facts are P4)");
    assert.ok(chunks(asGaia).some((hit) => hit.roomId === "nyari-room"), "another persona's ROOM HISTORY is reachable — the union store");
  } finally {
    db.close();
  }
});

test("incremental sync: appended transcript lines re-chunk the open tail; a truncated transcript rebuilds its room", async () => {
  const { root, sources } = await makeWorkspace([{ roomId: "grow", events: [{ author: "user", text: "the quokka mascot ships with the docs" }] }]);
  const transcriptPath = sources.rooms[0].transcriptPath;
  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    assert.ok(chunks(searchWorkspaceIndex(db, "quokka mascot", { agentId: "gaia", now: NOW })).length >= 1);

    await appendFile(transcriptPath, `${JSON.stringify({ id: "g2", timestamp: RECENT_TS, author: "gaia", text: "the wombat job digs through backlogs" })}\n`, "utf8");
    await syncWorkspaceIndex(db, sources);
    assert.ok(chunks(searchWorkspaceIndex(db, "wombat backlogs", { agentId: "gaia", now: NOW })).length >= 1, "appended line picked up");
    assert.ok(chunks(searchWorkspaceIndex(db, "quokka mascot", { agentId: "gaia", now: NOW })).length >= 1, "earlier line still served");

    // Truncation (hand-edit / rewind) → the room rebuilds without ghosts.
    await writeFile(transcriptPath, `${JSON.stringify({ id: "g1", timestamp: RECENT_TS, author: "user", text: "the quokka mascot ships with the docs" })}\n`, "utf8");
    await syncWorkspaceIndex(db, sources);
    assert.equal(chunks(searchWorkspaceIndex(db, "wombat backlogs", { agentId: "gaia", now: NOW })).length, 0, "truncated-away event is gone");
    assert.ok(chunks(searchWorkspaceIndex(db, "quokka mascot", { agentId: "gaia", now: NOW })).length >= 1);
  } finally {
    db.close();
  }
});

test("system events and command chrome never enter chunks", async () => {
  const { root, sources } = await makeWorkspace([
    {
      roomId: "chrome",
      events: [
        { author: "system", text: "Recall @gaia — sysmarkeralpha appears in this system reply" },
        { author: "user", text: "a normal message about the usermarkerbeta subject" },
      ],
    },
  ]);
  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    assert.equal(chunks(searchWorkspaceIndex(db, "sysmarkeralpha", { agentId: "gaia", now: NOW })).length, 0, "system chrome not indexed");
    assert.ok(chunks(searchWorkspaceIndex(db, "usermarkerbeta", { agentId: "gaia", now: NOW })).length >= 1);
  } finally {
    db.close();
  }
});

test("sync budget: cut is reported and NEVER silent; the freshest room is always indexed", async () => {
  const rooms: RoomSpec[] = Array.from({ length: 4 }, (_, i) => ({
    roomId: `room-${i}`,
    ageSec: i * 3600,
    events: [{ author: "user", text: `shared marker token in room ${i}` }],
  }));
  const { root, sources } = await makeWorkspace(rooms);
  const logs: string[] = [];
  const db = openWorkspaceIndex(root);
  try {
    const report = await syncWorkspaceIndex(db, sources, { budgetMs: -1, log: (m) => logs.push(m), now: NOW });
    assert.ok(report.degraded, "degradation reported");
    assert.equal(report.roomsPending, 3);
    assert.ok(logs.some((m) => m.includes("pending")), "and logged");
    assert.equal(readHealth(db).find((row) => row.component === "index")?.state, "degraded", "and visible in health");
    const reached = new Set(chunks(searchWorkspaceIndex(db, "shared marker token", { agentId: "gaia", now: NOW, limit: 20 })).map((hit) => hit.roomId));
    assert.ok(reached.has("room-0"), "the most recent room is always indexed");

    const full = await syncWorkspaceIndex(db, sources, { now: NOW });
    assert.equal(full.roomsPending, 0);
    assert.equal(readHealth(db).find((row) => row.component === "index")?.state, "ok", "health recovers loudly too");
  } finally {
    db.close();
  }
});

test("v3 retirement: first sync deletes per-room recall.db and per-agent index.db", async () => {
  const { root, memoryDir, sources } = await makeWorkspace([{ roomId: "lab", events: [{ author: "user", text: "hello" }] }]);
  const oldRoomDb = join(root, ".gaia", "rooms", "lab", "recall.db");
  const oldAgentDb = join(memoryDir, "index.db");
  await writeFile(oldRoomDb, "stale", "utf8");
  await writeFile(oldAgentDb, "stale", "utf8");

  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    assert.equal(existsSync(oldRoomDb), false, "per-room recall.db retired");
    assert.equal(existsSync(oldAgentDb), false, "per-agent index.db retired");
  } finally {
    db.close();
  }
});

test("health: set/read round-trip", async () => {
  const { root } = await makeWorkspace();
  const db = openWorkspaceIndex(root);
  try {
    setHealth(db, "embedder", "dead", "openai probe failed: 401", NOW);
    setHealth(db, "embedder", "ok", "local/embeddinggemma-300m · dim 256 · local", NOW);
    const rows = readHealth(db);
    assert.equal(rows.length, 1, "one row per component (upsert)");
    assert.equal(rows[0].state, "ok");
    assert.match(rows[0].detail, /local/);
  } finally {
    db.close();
  }
});

test("embedding cache plumbing: pending rows = chunks ∪ facts ∪ episodes, drained by storeEmbeddings", async () => {
  const { root, memoryDir, sources } = await makeWorkspace([
    { roomId: "lab", events: [{ author: "user", text: "some transcript content that is long enough to matter ".repeat(20) }] },
  ]);
  await addFact(memoryDir, "a fact to embed");
  await appendEpisode(memoryDir, { id: `ep_${(seq += 1)}`, ts: RECENT_TS, roomId: "lab", agentId: "gaia", task: "t", reply: "r", outcome: "complete" });

  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    const pending = pendingEmbeddings(db);
    assert.ok(pending.length >= 3, `chunks + fact + episode pending (got ${pending.length})`);
    storeEmbeddings(db, pending.map((row) => ({ hash: row.hash, vec: Float32Array.from([1, 0]) })));
    assert.equal(pendingEmbeddings(db).length, 0);
    const counts = countEmbeddings(db);
    assert.ok(counts.cached >= 3);
    assert.equal(counts.pending, 0);
  } finally {
    db.close();
  }
});

test("bareWorkspaceRecall: the no-daemon fallback searches the same index", async () => {
  const { root, memoryDir } = await makeWorkspace([{ roomId: "lab", events: [{ author: "user", text: "the flux capacitor design was approved" }] }]);
  await addFact(memoryDir, "the flux capacitor needs 1.21 gigawatts");
  const hits = await bareWorkspaceRecall(root, "flux capacitor", { agentId: "gaia", memoryDir });
  assert.ok(chunks(hits).length >= 1, "transcript reachable");
  assert.ok(facts(hits).length >= 1, "facts reachable when the agent is known");
});

// --- dense arm + fusion (P2) --------------------------------------------------------

test("quantization: prepareVector truncates + normalizes; int8 round-trip preserves cosine within 1%", () => {
  const long = Float32Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.7));
  const prepared = prepareVector(long);
  assert.equal(prepared.length, 256, "MRL-truncated");
  let norm = 0;
  for (const value of prepared) norm += value * value;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5, "unit norm");

  const quantized = quantizeInt8(prepared);
  let dot = 0;
  for (let i = 0; i < 256; i += 1) dot += prepared[i] * (quantized[i] / 127);
  assert.ok(Math.abs(dot - 1) < 0.01, `int8 self-cosine ≈ 1 (got ${dot})`);
});

test("dense arm: the query vector breaks a lexical tie, and a PARAPHRASE with zero keyword overlap is reachable", async () => {
  // Long enough to CLOSE its chunk — open tails are not embedded (they
  // re-chunk on every sync; lexical covers the fresh tail).
  const chunkText = "the targeting system picked the wrong building and children died. " + "the aftermath dominated every debrief that month. ".repeat(12);
  const { root, memoryDir, sources } = await makeWorkspace([{ roomId: "topic", events: [{ author: "user", ts: OLD_TS, text: chunkText }] }]);
  await addFact(memoryDir, "gaia handles deployment and hosting", { id: "fact_deploy" });
  await addFact(memoryDir, "gaia handles theming and colors", { id: "fact_theme" });

  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    // Fake unit vectors: deploy≈[1,0,0], theme≈[0,1,0], the chunk≈[0,0,1].
    const pending = pendingEmbeddings(db);
    assert.equal(pending.length, 3);
    storeEmbeddings(
      db,
      pending.map((row) => ({
        hash: row.hash,
        vec: row.text.includes("deployment") ? Float32Array.from([1, 0, 0]) : row.text.includes("theming") ? Float32Array.from([0, 1, 0]) : Float32Array.from([0, 0, 1]),
      })),
    );

    // Both facts tie lexically on "gaia"; the dense arm decides.
    const deployFirst = searchWorkspaceIndex(db, "gaia", { agentId: "gaia", queryVec: Float32Array.from([1, 0, 0]), now: NOW });
    assert.equal(facts(deployFirst)[0].id, "fact_deploy");
    const themeFirst = searchWorkspaceIndex(db, "gaia", { agentId: "gaia", queryVec: Float32Array.from([0, 1, 0]), now: NOW });
    assert.equal(facts(themeFirst)[0].id, "fact_theme");

    // Zero keyword overlap: the query text matches nothing lexically, but the
    // vector lands on the chunk — the eval-#1 paraphrase mechanism.
    const paraphrase = searchWorkspaceIndex(db, "completely unrelated words here", { agentId: "gaia", queryVec: Float32Array.from([0, 0, 1]), now: NOW });
    assert.ok(chunks(paraphrase).length >= 1, "dense-only chunk hit surfaces");
    assert.equal(chunks(paraphrase)[0].roomId, "topic");
    assert.ok(paraphrase[0].score > 0);
  } finally {
    db.close();
  }
});

test("dense arm honors self-match exclusion too", async () => {
  const pad = " padding sentence to close the chunk for embedding.".repeat(13);
  const { root, sources } = await makeWorkspace([
    { roomId: "current", events: [{ author: "user", ts: OLD_TS, text: `a dense-only memory living in the asking room.${pad}` }] },
    { roomId: "other", events: [{ author: "user", ts: OLD_TS, text: `a dense-only memory living elsewhere entirely.${pad}` }] },
  ]);
  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    const pending = pendingEmbeddings(db);
    storeEmbeddings(db, pending.map((row) => ({ hash: row.hash, vec: Float32Array.from([1, 0]) })));
    const hits = searchWorkspaceIndex(db, "zzz nolexicalmatch", {
      agentId: "gaia",
      queryVec: Float32Array.from([1, 0]),
      now: NOW,
      exclude: { roomId: "current", floorIdx: 0 },
    });
    assert.ok(chunks(hits).length >= 1);
    assert.ok(chunks(hits).every((hit) => hit.roomId === "other"), `asking-room dense hits dropped (got ${chunks(hits).map((h) => h.roomId).join(",")})`);
  } finally {
    db.close();
  }
});

test("dense normalization: an excluded self-match cannot deflate visible scores", async () => {
  const pad = " padding sentence to close the chunk for embedding.".repeat(13);
  const { root, sources } = await makeWorkspace([
    { roomId: "current", events: [{ author: "user", ts: OLD_TS, text: `the asking room's own copy of the memory.${pad}` }] },
    { roomId: "other", events: [{ author: "user", ts: OLD_TS, text: `the old room's account of the incident.${pad}` }] },
  ]);
  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    const pending = pendingEmbeddings(db);
    storeEmbeddings(
      db,
      pending.map((row) => ({
        hash: row.hash,
        vec: row.text.includes("asking room") ? Float32Array.from([1, 0]) : Float32Array.from([0.8, 0.6]),
      })),
    );
    const exclude = { roomId: "current", floorIdx: 0 };
    // Query aligned with the EXCLUDED chunk (visible cos 0.8, excluded 1.0)…
    const shadowed = searchWorkspaceIndex(db, "zzz nolexicalmatch", { agentId: "gaia", queryVec: Float32Array.from([1, 0]), now: NOW, exclude });
    // …vs aligned with the VISIBLE chunk (it is the max outright).
    const direct = searchWorkspaceIndex(db, "zzz nolexicalmatch", { agentId: "gaia", queryVec: Float32Array.from([0.8, 0.6]), now: NOW, exclude });
    assert.equal(chunks(shadowed)[0]?.roomId, "other");
    assert.equal(chunks(direct)[0]?.roomId, "other");
    // The visible max normalizes to 1.0 either way — the excluded row must not
    // sit in the denominator (fetch → filter → normalize, like the lexical arm).
    const a = chunks(shadowed)[0].score;
    const b = chunks(direct)[0].score;
    assert.ok(Math.abs(a - b) / b < 0.02, `excluded self-match deflated the visible score (${a} vs ${b})`);
  } finally {
    db.close();
  }
});

// --- query hygiene + rendering ------------------------------------------------------

test("ftsQuery is bounded: dedupes, drops 1-char noise, and caps the term count", () => {
  assert.equal(ftsQuery("You you YOU a b"), `"You"`);
  assert.equal(ftsQuery("port PORT 8787"), `"port" OR "8787"`);
  const huge = Array.from({ length: 500 }, (_, i) => `term${i}`).join(" ");
  assert.equal(ftsQuery(huge).split(" OR ").length, MAX_FTS_TERMS);
  assert.equal(ftsQuery("a . ! b"), "");
});

test("formatMemoryHits renders dated, attributed lines; full mode expands chunks", () => {
  const hits: MemorySearchHit[] = [
    { kind: "fact", id: "f1", text: "port is 8787", ts: "2026-07-01T10:00:00.000Z", score: 1, source: "user_stated" },
    { kind: "episode", id: "e1", text: "fix tests → done", ts: "2026-06-01T10:00:00.000Z", score: 1, outcome: "complete", roomId: "lab" },
    { kind: "transcript", text: "@user: hello there from the whole chunk", snippet: "hello there", ts: "2026-05-01T10:00:00.000Z", score: 1, roomId: "lab", speakers: ["user", "gaia"] },
  ];
  const lines = formatMemoryHits(hits).split("\n");
  assert.equal(lines[0], "[2026-07-01 · fact · user_stated] port is 8787");
  assert.equal(lines[1], "[2026-06-01 · episode · complete · room lab] fix tests → done");
  assert.equal(lines[2], "[2026-05-01 · room lab · @user @gaia] hello there");
  const full = formatMemoryHits(hits, { full: true }).split("\n");
  assert.equal(full[2], "[2026-05-01 · room lab · @user @gaia] @user: hello there from the whole chunk");
});

// --- deep path (P3, §8) ---------------------------------------------------------------

test("expandChunkWindows: a transcript hit widens to its ±1 chunk neighborhood; edges and non-transcript hits pass through", async () => {
  // Three closed chunks in one room: pad each event past CHUNK_MAX so every
  // event closes its own chunk(s), giving a deterministic prev/mid/next.
  const pad = " filler sentence that only exists to close the chunk cleanly.".repeat(11);
  const { root, memoryDir, sources } = await makeWorkspace([
    {
      roomId: "story",
      events: [
        { author: "user", ts: OLD_TS, text: `alpha the earliest part.${pad}` },
        { author: "user", ts: OLD_TS, text: `bravo the middle part.${pad}` },
        { author: "user", ts: OLD_TS, text: `charlie the latest part.${pad}` },
      ],
    },
  ]);
  await addFact(memoryDir, "a fact that must pass through untouched", { id: "fact_pass" });
  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, sources);
    const hits = searchWorkspaceIndex(db, "bravo", { agentId: "gaia", now: NOW });
    const mid = chunks(hits).find((hit) => hit.text.includes("bravo"));
    assert.ok(mid, "the middle chunk is a lexical hit");
    const factHit = { kind: "fact" as const, id: "fact_pass", text: "a fact that must pass through untouched", ts: RECENT_TS, score: 1 };
    const targets = [mid, factHit];
    expandChunkWindows(db, targets);
    assert.ok(mid.text.includes("alpha"), "window includes the previous chunk");
    assert.ok(mid.text.includes("charlie"), "window includes the next chunk");
    assert.equal(factHit.text, "a fact that must pass through untouched");

    // Edge chunk (first in room): only the next neighbor exists.
    const first = searchWorkspaceIndex(db, "alpha", { agentId: "gaia", now: NOW });
    const head = chunks(first).find((hit) => hit.text.includes("alpha"));
    assert.ok(head);
    expandChunkWindows(db, [head]);
    assert.ok(head.text.includes("bravo"), "edge window includes the following chunk");
  } finally {
    db.close();
  }
});

test("scrollTranscriptWindow: raw transcript lines around a hit, ▶-marked, pageable via offset; unknown id → undefined", async () => {
  const pad = " filler sentence that only exists to close the chunk cleanly.".repeat(18);
  const events = Array.from({ length: 9 }, (_, i) => ({ author: i % 2 ? "gaia" : "user", ts: OLD_TS, text: i === 4 ? `the anchor event.${pad}` : `event number ${i}` }));
  const { root, sources } = await makeWorkspace([{ roomId: "scrolled", events }]);
  const db = openWorkspaceIndex(root);
  let anchorId: number;
  try {
    await syncWorkspaceIndex(db, sources);
    const hit = chunks(searchWorkspaceIndex(db, "anchor", { agentId: "gaia", now: NOW }))[0];
    assert.ok(hit?.id);
    anchorId = Number(hit.id);
  } finally {
    db.close();
  }

  const window = await scrollTranscriptWindow(root, anchorId, { span: 2 });
  assert.ok(window, "window renders");
  assert.match(window, /room scrolled/);
  assert.match(window, /▶\[4\] @user: the anchor event\./, "anchor line is ▶-marked");
  assert.match(window, /\[2\] @user: event number 2/, "span reaches 2 back");
  assert.ok(!window.includes("event number 8"), "span cuts the far tail");

  const shifted = await scrollTranscriptWindow(root, anchorId, { span: 2, offset: -2 });
  assert.ok(shifted);
  assert.match(shifted, /\[0\] @user: event number 0/, "negative offset pages earlier");

  assert.equal(await scrollTranscriptWindow(root, 99_999), undefined);
});

test("workspace-shared facts (§5): visible to EVERY agent's search, lexical and dense", async () => {
  const { root, sources } = await makeWorkspace();
  const shared = sharedMemorySource(root);
  await mkdir(shared.memoryDir, { recursive: true });
  await appendFactOp(shared.memoryDir, {
    op: "add", id: "f_ws", ts: RECENT_TS,
    text: "the user prefers the zephyr deployment recipe for all services",
    source: "consolidator", scope: "workspace", actor: "agent:gaia", validFrom: RECENT_TS,
  });
  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, { ...sources, agents: [...sources.agents, shared] });
    // An agent that does NOT own the fact still recalls it.
    const lexical = searchWorkspaceIndex(db, "zephyr deployment recipe", { agentId: "ari", now: NOW });
    assert.equal(facts(lexical)[0]?.id, "f_ws", "lexical arm reads the shared store");

    const pending = pendingEmbeddings(db);
    storeEmbeddings(db, pending.map((row) => ({ hash: row.hash, vec: Float32Array.from([1, 0]) })));
    const dense = searchWorkspaceIndex(db, "nolexicaloverlap", { agentId: "ari", queryVec: Float32Array.from([1, 0]), now: NOW });
    assert.equal(facts(dense)[0]?.id, "f_ws", "dense arm reads the shared store");
  } finally {
    db.close();
  }
});
