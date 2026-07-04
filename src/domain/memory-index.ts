// The derived memory index: one SQLite file (node:sqlite, zero dependencies)
// per agent memory dir, mirroring facts.jsonl + episodes.jsonl into FTS5
// tables plus an embedding-vector cache. The JSONL logs are the source of
// truth; this file is safe to delete and rebuilds incrementally — the same
// contract as the per-room recall.db.
//
// Search is hybrid: BM25 lists (facts, episodes, room transcripts) and an
// optional brute-force cosine list over cached vectors are fused with
// reciprocal-rank fusion, then weighted by recency decay, provenance, and
// access count. No LLM in the query path; scores are deterministic.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EpisodeOutcome } from "./episodes.js";
import { readEpisodesFrom } from "./episodes.js";
import type { FactSource } from "./facts.js";
import { readFactOpsFrom } from "./facts.js";
import { ftsQuery, searchTranscript } from "./recall.js";

export const MEMORY_INDEX_FILE = "index.db";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, text TEXT NOT NULL, entities TEXT,
  source TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT, superseded_by TEXT,
  hash TEXT NOT NULL, access_count INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, id UNINDEXED);
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, room_id TEXT NOT NULL, outcome TEXT NOT NULL,
  task TEXT NOT NULL, reply TEXT NOT NULL, lesson TEXT, hash TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(text, id UNINDEXED);
CREATE TABLE IF NOT EXISTS embeddings (hash TEXT PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL);
`;

export interface MemorySearchHit {
  kind: "fact" | "episode" | "transcript";
  id?: string;
  text: string;
  ts: string;
  score: number;
  source?: FactSource;
  outcome?: EpisodeOutcome;
  author?: string;
  roomId?: string;
}

/** One line per hit, shared by the recall tool and the `gaia recall` CLI. */
export function formatMemoryHits(hits: MemorySearchHit[]): string {
  return hits
    .map((hit) => {
      if (hit.kind === "fact") return `[${hit.ts.slice(0, 10)} · fact · ${hit.source ?? "unknown"}] ${hit.text}`;
      if (hit.kind === "episode") return `[${hit.ts.slice(0, 10)} · episode · ${hit.outcome ?? "unknown"}] ${hit.text}`;
      return `[${hit.ts}] @${hit.author ?? "?"}${hit.roomId ? ` (${hit.roomId})` : ""}: ${hit.text}`;
    })
    .join("\n");
}

export interface RoomSearchRef {
  roomId: string;
  transcriptPath: string;
  dbPath: string;
}

export interface MemorySearchOptions {
  memoryDir: string;
  rooms?: RoomSearchRef[];
  /** Precomputed query vector; when absent the search is lexical-only. */
  queryVec?: Float32Array;
  limit?: number;
  includeInvalidated?: boolean;
  halfLifeDays?: number;
  minScore?: number;
  now?: Date;
  /** Wall-clock budget for the synchronous cross-room transcript scan. Rooms
   * are scanned most-recent-first; once the budget is spent we stop and leave
   * older rooms out of THIS turn's recall rather than block the event loop.
   * The first (most recent) room is always scanned. Defaults to
   * DEFAULT_ROOM_SCAN_BUDGET_MS. */
  roomScanBudgetMs?: number;
  /** Optional sink for a one-line note when the room-scan budget cuts the scan
   * short (so a degraded scan is never silent). */
  log?: (message: string) => void;
}

const LIST_DEPTH = 50;
const RRF_K = 60;
// Cross-room recall runs a synchronous FTS query per room. A workspace can hold
// hundreds of rooms (e.g. an imported chat history), and running them all in one
// uninterrupted synchronous burst freezes the daemon's single event loop. We
// cap the total wall-clock spent scanning rooms and yield between each so the
// daemon stays responsive; rooms are pre-sorted most-recent-first, so the budget
// preserves the most relevant ones.
const DEFAULT_ROOM_SCAN_BUDGET_MS = 1000;
const DECAY_FLOOR = 0.25;
const MIN_COSINE = 0.25;

// Distilled facts outrank raw chatter; consolidator output ranks below what
// the user actually said (loop-protection, not politeness).
const SOURCE_WEIGHT: Record<FactSource, number> = {
  user_stated: 1.2,
  outcome_verified: 1.15,
  agent_inferred: 1.0,
  consolidator: 0.9,
};
const EPISODE_WEIGHT = 1.0;
const TRANSCRIPT_WEIGHT = 0.9;

interface Candidate {
  hit: MemorySearchHit;
  rrf: number;
  weight: number;
  accessCount: number;
}

function decay(ts: string, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(ts)) / 86_400_000);
  if (!Number.isFinite(ageDays)) return DECAY_FLOOR;
  return Math.max(DECAY_FLOOR, 0.5 ** (ageDays / halfLifeDays));
}

function openIndex(memoryDir: string): DatabaseSync {
  const db = new DatabaseSync(join(memoryDir, MEMORY_INDEX_FILE));
  db.exec(SCHEMA);
  return db;
}

function readCursor(db: DatabaseSync, key: string): number {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: number } | undefined)?.value ?? 0;
}

function writeCursor(db: DatabaseSync, key: string, value: number): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Catch the index up with facts.jsonl + episodes.jsonl. Source shrank ⇒ the
 * log was replaced by hand; rebuild that table from scratch. */
export async function syncMemoryIndex(memoryDir: string, db: DatabaseSync): Promise<void> {
  const factCursor = readCursor(db, "facts_ops");
  const factPage = await readFactOpsFrom(memoryDir, factCursor);
  if (factPage.nextCursor < factCursor) {
    db.exec("DELETE FROM facts; DELETE FROM facts_fts;");
    const full = await readFactOpsFrom(memoryDir, 0);
    applyFactOps(db, full.items);
    writeCursor(db, "facts_ops", full.nextCursor);
  } else if (factPage.items.length) {
    applyFactOps(db, factPage.items);
    writeCursor(db, "facts_ops", factPage.nextCursor);
  } else if (factPage.nextCursor !== factCursor) {
    writeCursor(db, "facts_ops", factPage.nextCursor);
  }

  const epCursor = readCursor(db, "episode_lines");
  const epPage = await readEpisodesFrom(memoryDir, epCursor);
  if (epPage.nextCursor < epCursor) {
    db.exec("DELETE FROM episodes; DELETE FROM episodes_fts;");
    const full = await readEpisodesFrom(memoryDir, 0);
    applyEpisodes(db, full.items);
    writeCursor(db, "episode_lines", full.nextCursor);
  } else if (epPage.items.length) {
    applyEpisodes(db, epPage.items);
    writeCursor(db, "episode_lines", epPage.nextCursor);
  } else if (epPage.nextCursor !== epCursor) {
    writeCursor(db, "episode_lines", epPage.nextCursor);
  }
}

function applyFactOps(db: DatabaseSync, ops: Awaited<ReturnType<typeof readFactOpsFrom>>["items"]): void {
  const insert = db.prepare(
    "INSERT OR REPLACE INTO facts (id, ts, text, entities, source, valid_from, valid_to, superseded_by, hash, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT access_count FROM facts WHERE id = ?), 0))",
  );
  const insertFts = db.prepare("INSERT INTO facts_fts (text, id) VALUES (?, ?)");
  const invalidate = db.prepare("UPDATE facts SET valid_to = ?, superseded_by = ? WHERE id = ? AND valid_to IS NULL");
  for (const op of ops) {
    if (op.op === "add") {
      insert.run(op.id, op.ts, op.text, op.entities ? JSON.stringify(op.entities) : null, op.source, op.validFrom, op.validTo ?? null, op.supersededBy ?? null, sha256Hex(op.text), op.id);
      insertFts.run(op.text, op.id);
    } else {
      invalidate.run(op.ts, op.supersededBy ?? null, op.id);
    }
  }
}

function applyEpisodes(db: DatabaseSync, episodes: Awaited<ReturnType<typeof readEpisodesFrom>>["items"]): void {
  const insert = db.prepare("INSERT OR REPLACE INTO episodes (id, ts, room_id, outcome, task, reply, lesson, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO episodes_fts (text, id) VALUES (?, ?)");
  for (const episode of episodes) {
    const text = [episode.task, episode.reply, episode.lesson ?? ""].filter(Boolean).join(" ");
    insert.run(episode.id, episode.ts, episode.roomId, episode.outcome, episode.task, episode.reply, episode.lesson ?? null, sha256Hex(text));
    insertFts.run(text, episode.id);
  }
}

/** Rows whose text has no cached vector yet: [hash, text] pairs, capped. */
export async function pendingEmbeddings(memoryDir: string, limit = 256): Promise<Array<{ hash: string; text: string }>> {
  const db = openIndex(memoryDir);
  try {
    await syncMemoryIndex(memoryDir, db);
    const rows = db
      .prepare(
        `SELECT hash, text FROM (
           SELECT hash, text FROM facts WHERE valid_to IS NULL
           UNION SELECT e.hash, e.task || ' ' || e.reply || COALESCE(' ' || e.lesson, '') AS text FROM episodes e
         ) WHERE hash NOT IN (SELECT hash FROM embeddings) LIMIT ?`,
      )
      .all(limit) as Array<{ hash: string; text: string }>;
    return rows;
  } finally {
    db.close();
  }
}

export async function storeEmbeddings(memoryDir: string, vectors: Array<{ hash: string; vec: Float32Array }>): Promise<void> {
  if (!vectors.length) return;
  const db = openIndex(memoryDir);
  try {
    const insert = db.prepare("INSERT OR REPLACE INTO embeddings (hash, dim, vec) VALUES (?, ?, ?)");
    for (const { hash, vec } of vectors) {
      insert.run(hash, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
    }
  } finally {
    db.close();
  }
}

function vecFromBlob(blob: Uint8Array): Float32Array {
  const buf = Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

export async function searchMemory(query: string, options: MemorySearchOptions): Promise<MemorySearchHit[]> {
  const limit = options.limit ?? 8;
  const now = options.now ?? new Date();
  const halfLife = options.halfLifeDays ?? 60;
  const match = ftsQuery(query);
  const candidates = new Map<string, Candidate>();

  const fold = (key: string, rank: number, make: () => Omit<Candidate, "rrf">): void => {
    const existing = candidates.get(key);
    const contribution = 1 / (RRF_K + rank);
    if (existing) {
      existing.rrf += contribution;
    } else {
      candidates.set(key, { ...make(), rrf: contribution });
    }
  };

  const hasIndex = existsSync(join(options.memoryDir, MEMORY_INDEX_FILE)) || existsSync(join(options.memoryDir, "facts.jsonl")) || existsSync(join(options.memoryDir, "episodes.jsonl"));
  let db: DatabaseSync | undefined;

  // Open + sync inside the try: a sync failure must still close the handle.
  try {
    if (hasIndex) {
      db = openIndex(options.memoryDir);
      await syncMemoryIndex(options.memoryDir, db);
    }

    if (db && match) {
      const validity = options.includeInvalidated ? "" : "AND f.valid_to IS NULL";
      const factRows = db
        .prepare(
          `SELECT f.id, f.ts, f.text, f.source, f.access_count FROM facts_fts
           JOIN facts f ON f.id = facts_fts.id
           WHERE facts_fts MATCH ? ${validity} ORDER BY rank LIMIT ?`,
        )
        .all(match, LIST_DEPTH) as Array<{ id: string; ts: string; text: string; source: FactSource; access_count: number }>;
      factRows.forEach((row, rank) =>
        fold(`fact:${row.id}`, rank, () => ({
          hit: { kind: "fact", id: row.id, text: row.text, ts: row.ts, score: 0, source: row.source },
          weight: SOURCE_WEIGHT[row.source] ?? 1.0,
          accessCount: row.access_count,
        })),
      );

      const episodeRows = db
        .prepare(
          `SELECT e.id, e.ts, e.room_id, e.outcome, e.task, e.reply, e.lesson FROM episodes_fts
           JOIN episodes e ON e.id = episodes_fts.id
           WHERE episodes_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(match, LIST_DEPTH) as Array<{ id: string; ts: string; room_id: string; outcome: EpisodeOutcome; task: string; reply: string; lesson: string | null }>;
      episodeRows.forEach((row, rank) =>
        fold(`episode:${row.id}`, rank, () => ({
          hit: {
            kind: "episode",
            id: row.id,
            text: row.lesson ?? `${row.task} → ${row.reply}`,
            ts: row.ts,
            score: 0,
            outcome: row.outcome,
            roomId: row.room_id,
          },
          weight: EPISODE_WEIGHT,
          accessCount: 0,
        })),
      );

      if (options.queryVec) {
        const validityVec = options.includeInvalidated ? "" : "WHERE f.valid_to IS NULL";
        const vecRows = db
          .prepare(
            `SELECT 'fact' AS kind, f.id, f.ts, f.text, f.source, f.access_count, NULL AS outcome, NULL AS room_id, em.vec
               FROM facts f JOIN embeddings em ON em.hash = f.hash ${validityVec}
             UNION ALL
             SELECT 'episode' AS kind, e.id, e.ts, COALESCE(e.lesson, e.task || ' → ' || e.reply) AS text, NULL AS source, 0 AS access_count, e.outcome, e.room_id, em.vec
               FROM episodes e JOIN embeddings em ON em.hash = e.hash`,
          )
          .all() as Array<{ kind: "fact" | "episode"; id: string; ts: string; text: string; source: FactSource | null; access_count: number; outcome: EpisodeOutcome | null; room_id: string | null; vec: Uint8Array }>;
        const scored = vecRows
          .map((row) => ({ row, sim: cosine(options.queryVec as Float32Array, vecFromBlob(row.vec)) }))
          .filter((entry) => entry.sim >= MIN_COSINE)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, LIST_DEPTH);
        scored.forEach(({ row }, rank) =>
          fold(`${row.kind}:${row.id}`, rank, () => ({
            hit: {
              kind: row.kind,
              id: row.id,
              text: row.text,
              ts: row.ts,
              score: 0,
              source: row.source ?? undefined,
              outcome: row.outcome ?? undefined,
              roomId: row.room_id ?? undefined,
            },
            weight: row.kind === "fact" ? (SOURCE_WEIGHT[row.source as FactSource] ?? 1.0) : EPISODE_WEIGHT,
            accessCount: row.access_count,
          })),
        );
      }
    }

    const rooms = options.rooms ?? [];
    const roomBudgetMs = options.roomScanBudgetMs ?? DEFAULT_ROOM_SCAN_BUDGET_MS;
    const scanStart = Date.now();
    for (let i = 0; i < rooms.length; i += 1) {
      // Always scan the most-recent room; after that, stop once the budget is
      // spent rather than freeze the event loop on a very large workspace.
      if (i > 0 && Date.now() - scanStart > roomBudgetMs) {
        options.log?.(`recall: room-scan budget (${roomBudgetMs}ms) reached after ${i}/${rooms.length} rooms; ${rooms.length - i} older rooms skipped this turn`);
        break;
      }
      const room = rooms[i];
      const hits = searchTranscript(room.transcriptPath, room.dbPath, query, LIST_DEPTH);
      hits.forEach((hit, rank) =>
        fold(`transcript:${room.roomId}:${sha256Hex(`${hit.timestamp}:${hit.author}:${hit.snippet}`)}`, rank, () => ({
          hit: {
            kind: "transcript",
            text: hit.snippet,
            ts: hit.timestamp,
            score: 0,
            author: hit.author,
            roomId: room.roomId,
          },
          weight: TRANSCRIPT_WEIGHT,
          accessCount: 0,
        })),
      );
      // Hand the event loop back between rooms so HTTP (health, /stop, other
      // rooms' turns) is never starved by a long synchronous recall.
      if (i < rooms.length - 1) await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const results = [...candidates.values()]
      .map((candidate) => {
        const boost = 1 + 0.05 * Math.log1p(candidate.accessCount);
        candidate.hit.score = candidate.rrf * candidate.weight * decay(candidate.hit.ts, now, halfLife) * boost;
        return candidate.hit;
      })
      .filter((hit) => hit.score >= (options.minScore ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Access counts feed the ranking boost; losing them costs nothing (the
    // index is derived), so this is best-effort.
    if (db) {
      const bump = db.prepare("UPDATE facts SET access_count = access_count + 1 WHERE id = ?");
      for (const hit of results) if (hit.kind === "fact" && hit.id) bump.run(hit.id);
    }

    return results;
  } finally {
    db?.close();
  }
}
