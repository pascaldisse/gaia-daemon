// Memory v4 (MEMORY-DESIGN.md): ONE derived index per workspace at
// <workspace>/.gaia/memory/index.db (the platform's built-in sqlite via
// src/core/sqlite.ts — node:sqlite or bun:sqlite, zero dependencies).
//
// The union store: verbatim transcript CHUNKS over every room, plus each
// agent's facts and episodes, all FTS5-indexed in one file with global corpus
// statistics — a single bm25 ranking whose score MAGNITUDE survives (v3's
// per-room rank folding flattened 105 rooms into rank-0 ties and let recency
// decide; that is failure #3 in the design doc). The JSONL logs and room
// transcripts stay the source of truth; this file is derived, safe to delete,
// and rebuilds incrementally from per-source cursors.
//
// Search is score-based fusion: per-table max-normalized bm25 (plus a dense
// arm when vectors exist — P2), soft-multiplied by provenance weight, recency
// decay (floor 0.25 — decay tunes, never decides), and an access boost.
// Self-match exclusion (CALMem): hits whose source events sit in the asking
// agent's ACTIVE context window are dropped; compacted-away content from the
// same room stays recallable — recall's job is reinstatement, not duplication.
// No LLM in the query path; scores are deterministic.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqliteDatabase as DatabaseSync } from "../core/sqlite.js";
import { openSqlite } from "../core/sqlite.js";
import { workspacePaths } from "../core/paths.js";
import type { EpisodeOutcome } from "./episodes.js";
import { readEpisodesFrom } from "./episodes.js";
import type { FactSource } from "./facts.js";
import { readFactOpsFrom, sharedFactsDir, WORKSPACE_FACTS_AGENT } from "./facts.js";

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

// FTS5 has its own query syntax; quoting each token and OR-ing them turns
// free-form questions into a ranked any-term match.
//
// Bounded on purpose. An unbounded OR of every token is a denial-of-service on
// ourselves: a long message (or a pasted document) expands into hundreds of
// OR-terms, and because `ORDER BY rank` must score every matching row, a query
// that matches most of the corpus makes bm25 scan the whole table. We dedupe
// (case-insensitively), drop 1-char noise, and cap the term count so any
// single query stays cheap regardless of input size.
export const MAX_FTS_TERMS = 24;

export function ftsQuery(query: string): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of query.split(/[^\p{L}\p{N}]+/u)) {
    if (token.length < 2) continue; // single chars are noise and match too broadly
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(`"${token}"`);
    if (terms.length >= MAX_FTS_TERMS) break;
  }
  return terms.join(" OR ");
}

// --- schema ------------------------------------------------------------------

// Chunk targets (chars): big enough to be a real attributed excerpt (the
// design kills v3's useless 48-char snippets), small enough to embed and to
// keep injection focused. Chunks split on turn boundaries; a single oversized
// event splits on paragraph boundaries.
const CHUNK_MIN = 600;
const CHUNK_MAX = 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  closed_lines INTEGER NOT NULL DEFAULT 0,
  total_lines INTEGER NOT NULL DEFAULT 0,
  mtime_ms REAL NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  first_idx INTEGER NOT NULL,
  last_idx INTEGER NOT NULL,
  event_ids TEXT NOT NULL,
  ts_from TEXT NOT NULL,
  ts_to TEXT NOT NULL,
  speakers TEXT NOT NULL,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  open INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chunks_room ON chunks (room_id, first_idx);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, chunk_id UNINDEXED);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL, entities TEXT,
  source TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT, superseded_by TEXT,
  hash TEXT NOT NULL, access_count INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, id UNINDEXED);
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, ts TEXT NOT NULL, room_id TEXT NOT NULL, outcome TEXT NOT NULL,
  task TEXT NOT NULL, reply TEXT NOT NULL, lesson TEXT, hash TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(text, id UNINDEXED);
CREATE TABLE IF NOT EXISTS embeddings (hash TEXT PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL, fmt TEXT NOT NULL DEFAULT 'i8');
CREATE TABLE IF NOT EXISTS health (component TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_hash ON chunks (hash);
CREATE INDEX IF NOT EXISTS facts_hash ON facts (hash);
CREATE INDEX IF NOT EXISTS episodes_hash ON episodes (hash);
`;

/** Open (creating if needed) the workspace memory index. WAL so the daemon's
 * writes and a CLI reader (`gaia memory status|eval`) can coexist. */
export function openWorkspaceIndex(workspaceRoot: string): DatabaseSync {
  mkdirSync(workspacePaths.memoryDir(workspaceRoot), { recursive: true });
  const db = openSqlite(workspacePaths.memoryIndexDb(workspaceRoot));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;");
  db.exec(SCHEMA);
  // P1 indexes predate the fmt column; the index is derived, so patching the
  // schema in place beats a rebuild.
  const cols = db.prepare("SELECT name FROM pragma_table_info('embeddings')").all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === "fmt")) db.exec("ALTER TABLE embeddings ADD COLUMN fmt TEXT NOT NULL DEFAULT 'f32'");
  return db;
}

// --- vector quantization (int8 @ MRL-truncated 256d, §6) ---------------------------

/** Stored vector width: MRL truncation point (EmbeddingGemma loses ~2% here);
 * shorter vectors pass through untouched. */
export const EMBED_STORE_DIM = 256;

/** Truncate to the MRL prefix and L2-normalize — MUST be applied identically
 * to stored vectors and query vectors or cosines are meaningless. */
export function prepareVector(vec: Float32Array, dim = EMBED_STORE_DIM): Float32Array {
  const cut = vec.length > dim ? vec.subarray(0, dim) : vec;
  let norm = 0;
  for (let i = 0; i < cut.length; i += 1) norm += cut[i] * cut[i];
  norm = Math.sqrt(norm);
  const out = new Float32Array(cut.length);
  if (norm === 0) return out;
  for (let i = 0; i < cut.length; i += 1) out[i] = cut[i] / norm;
  return out;
}

/** Symmetric int8 quantization of a unit vector (values ⊂ [-1,1] × 127).
 * dot(int8, f32)/127 ≈ cosine; brute-force scan stays <10ms to ~50k rows. */
export function quantizeInt8(unit: Float32Array): Int8Array {
  const out = new Int8Array(unit.length);
  for (let i = 0; i < unit.length; i += 1) out[i] = Math.max(-127, Math.min(127, Math.round(unit[i] * 127)));
  return out;
}

// --- sources -------------------------------------------------------------------

export interface RoomRef {
  roomId: string;
  transcriptPath: string;
}

export interface AgentMemoryRef {
  agentId: string;
  memoryDir: string;
}

export interface WorkspaceIndexSources {
  /** Most-recently-active first — a budget cut then loses the OLDEST rooms. */
  rooms: RoomRef[];
  agents: AgentMemoryRef[];
}

/** The workspace-shared facts store (§5) as an index source: a pseudo-agent,
 * so sync, search scoping, and recall reuse the per-agent machinery
 * unchanged. Every sync caller includes it; every agent's search reads it. */
export function sharedMemorySource(workspaceRoot: string): AgentMemoryRef {
  return { agentId: WORKSPACE_FACTS_AGENT, memoryDir: sharedFactsDir(workspacePaths.memoryDir(workspaceRoot)) };
}

/** True when a room's state.json marks it incognito — such rooms are invisible
 * to recall, so their transcripts are never indexed. Best-effort: a room whose
 * state can't be read (missing, mid-write, corrupt) is treated as NON-incognito,
 * i.e. indexed — failing open keeps normal rooms recallable, and an incognito
 * room's state is written once at creation before any turn exists to index. */
function roomIsIncognito(workspaceRoot: string, roomId: string): boolean {
  try {
    const raw = readFileSync(workspacePaths.roomState(workspaceRoot, roomId), "utf8");
    return (JSON.parse(raw) as { incognito?: unknown }).incognito === true;
  } catch {
    return false;
  }
}

/** Every room transcript in the workspace, most-recently-active first —
 * EXCEPT incognito rooms, which are omitted so they can never enter the recall
 * index. Uncapped on purpose: rooms are chats, and recall must reach ANY of them —
 * including a 100-chat history import. Shared by the daemon and the bare-CLI
 * fallbacks so there is exactly one definition of "the workspace's recallable rooms". */
export function workspaceRoomRefs(workspaceRoot: string): RoomRef[] {
  const roomsDir = workspacePaths.roomsDir(workspaceRoot);
  if (!existsSync(roomsDir)) return [];
  const refs: Array<RoomRef & { mtime: number }> = [];
  for (const entry of readdirSync(roomsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transcriptPath = workspacePaths.transcript(workspaceRoot, entry.name);
    if (!existsSync(transcriptPath)) continue;
    if (roomIsIncognito(workspaceRoot, entry.name)) continue;
    try {
      refs.push({ roomId: entry.name, transcriptPath, mtime: statSync(transcriptPath).mtimeMs });
    } catch {
      // Room being deleted mid-scan; skip it.
    }
  }
  return refs.sort((a, b) => b.mtime - a.mtime).map(({ mtime: _mtime, ...ref }) => ref);
}

export interface SyncReport {
  roomsScanned: number;
  roomsPending: number;
  /** Set when the room budget cut the scan short — never silent (§10). */
  degraded?: string;
}

export interface SyncOptions {
  /** Wall-clock budget for the room catch-up. Rooms already up to date cost a
   * stat() each; only rooms with new lines cost real work. Absent = no cut. */
  budgetMs?: number;
  log?: (message: string) => void;
  now?: Date;
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// One retirement sweep per open handle (not per index lifetime): a v3 daemon
// still running during the upgrade window recreates its derived files, so a
// once-ever sweep would leave them behind forever.
const sweptHandles = new WeakSet<DatabaseSync>();

/** Catch the index up with every source: room transcripts (chunked), plus each
 * agent's facts.jsonl + episodes.jsonl. Incremental via cursors; a source that
 * SHRANK (hand-edit, /rewind) rebuilds its slice from scratch. Also retires
 * the v3 derived files (per-room recall.db, per-agent index.db). */
export async function syncWorkspaceIndex(db: DatabaseSync, sources: WorkspaceIndexSources, options: SyncOptions = {}): Promise<SyncReport> {
  if (!sweptHandles.has(db)) {
    sweptHandles.add(db);
    retireV3Indexes(sources);
    writeMeta(db, "v", "4");
  }

  for (const agent of sources.agents) await syncAgentMemory(db, agent);

  const started = Date.now();
  let scanned = 0;
  for (let i = 0; i < sources.rooms.length; i += 1) {
    if (options.budgetMs !== undefined && i > 0 && Date.now() - started > options.budgetMs) {
      const pending = sources.rooms.length - i;
      const detail = `index catch-up budget (${options.budgetMs}ms) reached; ${pending} rooms pending until the next turn`;
      options.log?.(`memory: ${detail}`);
      setHealth(db, "index", "degraded", detail, options.now);
      return { roomsScanned: scanned, roomsPending: pending, degraded: detail };
    }
    if (await syncRoomChunks(db, sources.rooms[i])) scanned += 1;
    // Hand the event loop back between rooms so a large catch-up (first build,
    // history import) never starves HTTP — the recall-freeze lesson from v3.
    if (i < sources.rooms.length - 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  setHealth(db, "index", "ok", describeIndex(db), options.now);
  return { roomsScanned: scanned, roomsPending: 0 };
}

/** v3's derived files are dead weight once the workspace index exists; §14
 * says delete, so a stale engine can never silently serve again. */
function retireV3Indexes(sources: WorkspaceIndexSources): void {
  for (const room of sources.rooms) {
    for (const suffix of ["", "-wal", "-shm"]) rmQuiet(join(room.transcriptPath, "..", `recall.db${suffix}`));
  }
  for (const agent of sources.agents) {
    for (const suffix of ["", "-wal", "-shm"]) rmQuiet(join(agent.memoryDir, `index.db${suffix}`));
  }
}

function rmQuiet(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Derived files; best-effort.
  }
}

function describeIndex(db: DatabaseSync): string {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return `${count("SELECT COUNT(*) AS n FROM rooms")} rooms · ${count("SELECT COUNT(*) AS n FROM chunks")} chunks · ${count("SELECT COUNT(*) AS n FROM facts WHERE valid_to IS NULL")} facts · ${count("SELECT COUNT(*) AS n FROM episodes")} episodes`;
}

// --- room transcript chunking ---------------------------------------------------

interface ChunkEvent {
  idx: number;
  id: string;
  ts: string;
  author: string;
  text: string;
}

interface ChunkRow {
  firstIdx: number;
  lastIdx: number;
  eventIds: string[];
  tsFrom: string;
  tsTo: string;
  speakers: string[];
  text: string;
  open: boolean;
}

/** Returns true when the room had new lines to index. */
async function syncRoomChunks(db: DatabaseSync, room: RoomRef): Promise<boolean> {
  let stat;
  try {
    stat = statSync(room.transcriptPath);
  } catch {
    return false; // room being deleted mid-scan
  }
  const cursor = db.prepare("SELECT closed_lines, total_lines, mtime_ms, size_bytes FROM rooms WHERE room_id = ?").get(room.roomId) as
    | { closed_lines: number; total_lines: number; mtime_ms: number; size_bytes: number }
    | undefined;
  if (cursor && cursor.mtime_ms === stat.mtimeMs && cursor.size_bytes === stat.size) return false;

  const raw = await readFile(room.transcriptPath, "utf8").catch(() => "");
  const lines = raw.split("\n").filter((line) => line.trim());
  let from = cursor?.closed_lines ?? 0;
  // Fewer lines than indexed ⇒ the transcript was replaced, hand-edited, or
  // /rewind-truncated: rebuild this room from scratch for consistency.
  if (lines.length < (cursor?.total_lines ?? 0)) {
    deleteRoomChunks(db, room.roomId, 0);
    from = 0;
  } else {
    // Re-chunk the open tail: delete open chunks and restart from closed_lines.
    deleteRoomChunks(db, room.roomId, from);
  }

  const events: ChunkEvent[] = [];
  for (let idx = from; idx < lines.length; idx += 1) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[idx]) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof parsed.text !== "string" || typeof parsed.author !== "string" || !parsed.text.trim()) continue;
    // System events are room chrome (slash-command replies), never conversation.
    if (parsed.author === "system") continue;
    events.push({
      idx,
      id: typeof parsed.id === "string" && parsed.id ? parsed.id : `legacy_${idx}`,
      ts: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
      author: parsed.author,
      text: parsed.text,
    });
  }

  const chunks = buildChunks(events);
  const insert = db.prepare(
    "INSERT INTO chunks (room_id, first_idx, last_idx, event_ids, ts_from, ts_to, speakers, text, hash, open) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFts = db.prepare("INSERT INTO chunks_fts (text, chunk_id) VALUES (?, ?)");
  for (const chunk of chunks) {
    const { lastInsertRowid } = insert.run(
      room.roomId,
      chunk.firstIdx,
      chunk.lastIdx,
      JSON.stringify(chunk.eventIds),
      chunk.tsFrom,
      chunk.tsTo,
      JSON.stringify(chunk.speakers),
      chunk.text,
      sha256Hex(chunk.text),
      chunk.open ? 1 : 0,
    );
    insertFts.run(chunk.text, Number(lastInsertRowid));
  }

  const openChunk = chunks.find((chunk) => chunk.open);
  const closedLines = openChunk ? openChunk.firstIdx : lines.length;
  db.prepare(
    "INSERT INTO rooms (room_id, closed_lines, total_lines, mtime_ms, size_bytes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET closed_lines = excluded.closed_lines, total_lines = excluded.total_lines, mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes",
  ).run(room.roomId, closedLines, lines.length, stat.mtimeMs, stat.size);
  return true;
}

/** Drop a room's chunks from `fromIdx` on (0 = the whole room), FTS rows too. */
function deleteRoomChunks(db: DatabaseSync, roomId: string, fromIdx: number): void {
  const rows = db.prepare("SELECT id FROM chunks WHERE room_id = ? AND first_idx >= ?").all(roomId, fromIdx) as Array<{ id: number }>;
  if (!rows.length) return;
  const dropFts = db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
  for (const row of rows) dropFts.run(row.id);
  db.prepare("DELETE FROM chunks WHERE room_id = ? AND first_idx >= ?").run(roomId, fromIdx);
}

/** Erase a deleted room from the derived index: its transcript chunks (+ FTS),
 * the per-room sync cursor, and any episodes captured in it (+ FTS). The sync
 * pass only visits rooms that still exist on disk and has no orphan-prune, so
 * without this a deleted room's rows would linger and keep matching recall
 * forever. Idempotent; derived data, so always safe to run. */
export function purgeRoomIndex(db: DatabaseSync, roomId: string): void {
  deleteRoomChunks(db, roomId, 0);
  db.prepare("DELETE FROM rooms WHERE room_id = ?").run(roomId);
  const episodes = db.prepare("SELECT id FROM episodes WHERE room_id = ?").all(roomId) as Array<{ id: string }>;
  const dropFts = db.prepare("DELETE FROM episodes_fts WHERE id = ?");
  for (const row of episodes) dropFts.run(row.id);
  db.prepare("DELETE FROM episodes WHERE room_id = ?").run(roomId);
}

function renderEvent(event: ChunkEvent): string {
  return `@${event.author}: ${event.text.trim()}`;
}

/** Greedy chunker: contiguous events, split on turn boundaries, target
 * CHUNK_MIN..CHUNK_MAX chars. The trailing residue below CHUNK_MIN stays an
 * OPEN chunk — searchable now, deleted and re-chunked on the next sync until
 * it grows past the minimum and closes. A single oversized event splits on
 * paragraph boundaries into closed single-event chunks. */
export function buildChunks(events: ChunkEvent[]): ChunkRow[] {
  const out: ChunkRow[] = [];
  let cur: ChunkEvent[] = [];
  let curLen = 0;

  const flush = (open: boolean): void => {
    if (!cur.length) return;
    out.push({
      firstIdx: cur[0].idx,
      lastIdx: cur[cur.length - 1].idx,
      eventIds: cur.map((event) => event.id),
      tsFrom: cur[0].ts,
      tsTo: cur[cur.length - 1].ts,
      speakers: [...new Set(cur.map((event) => event.author))],
      text: cur.map(renderEvent).join("\n"),
      open,
    });
    cur = [];
    curLen = 0;
  };

  for (const event of events) {
    const rendered = renderEvent(event);
    if (rendered.length > CHUNK_MAX) {
      flush(false);
      for (const piece of splitLongText(rendered)) {
        out.push({
          firstIdx: event.idx,
          lastIdx: event.idx,
          eventIds: [event.id],
          tsFrom: event.ts,
          tsTo: event.ts,
          speakers: [event.author],
          text: piece,
          open: false,
        });
      }
      continue;
    }
    if (curLen + rendered.length + 1 > CHUNK_MAX) flush(false);
    cur.push(event);
    curLen += rendered.length + 1;
  }
  flush(curLen >= CHUNK_MIN ? false : true);

  // Only the LAST chunk may be open; everything before it is settled.
  for (let i = 0; i < out.length - 1; i += 1) out[i].open = false;
  return out;
}

function splitLongText(text: string): string[] {
  const pieces: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    if (cur && cur.length + para.length + 2 > CHUNK_MAX) {
      pieces.push(cur);
      cur = "";
    }
    if (para.length > CHUNK_MAX) {
      if (cur) {
        pieces.push(cur);
        cur = "";
      }
      for (let at = 0; at < para.length; at += CHUNK_MAX) pieces.push(para.slice(at, at + CHUNK_MAX));
      continue;
    }
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) pieces.push(cur);
  return pieces.filter((piece) => piece.trim());
}

// --- facts + episodes sync --------------------------------------------------------

async function syncAgentMemory(db: DatabaseSync, agent: AgentMemoryRef): Promise<void> {
  const factKey = `facts:${agent.agentId}`;
  const factCursor = Number(readMeta(db, factKey) ?? 0);
  const factPage = await readFactOpsFrom(agent.memoryDir, factCursor);
  if (factPage.nextCursor < factCursor) {
    dropAgentRows(db, "facts", agent.agentId);
    const full = await readFactOpsFrom(agent.memoryDir, 0);
    applyFactOps(db, agent.agentId, full.items);
    writeMeta(db, factKey, String(full.nextCursor));
  } else if (factPage.items.length) {
    applyFactOps(db, agent.agentId, factPage.items);
    writeMeta(db, factKey, String(factPage.nextCursor));
  } else if (factPage.nextCursor !== factCursor) {
    writeMeta(db, factKey, String(factPage.nextCursor));
  }

  const epKey = `episodes:${agent.agentId}`;
  const epCursor = Number(readMeta(db, epKey) ?? 0);
  const epPage = await readEpisodesFrom(agent.memoryDir, epCursor);
  if (epPage.nextCursor < epCursor) {
    dropAgentRows(db, "episodes", agent.agentId);
    const full = await readEpisodesFrom(agent.memoryDir, 0);
    applyEpisodes(db, agent.agentId, full.items);
    writeMeta(db, epKey, String(full.nextCursor));
  } else if (epPage.items.length) {
    applyEpisodes(db, agent.agentId, epPage.items);
    writeMeta(db, epKey, String(epPage.nextCursor));
  } else if (epPage.nextCursor !== epCursor) {
    writeMeta(db, epKey, String(epPage.nextCursor));
  }
}

function dropAgentRows(db: DatabaseSync, table: "facts" | "episodes", agentId: string): void {
  const ids = db.prepare(`SELECT id FROM ${table} WHERE agent_id = ?`).all(agentId) as Array<{ id: string }>;
  const dropFts = db.prepare(`DELETE FROM ${table}_fts WHERE id = ?`);
  for (const row of ids) dropFts.run(row.id);
  db.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(agentId);
}

function applyFactOps(db: DatabaseSync, agentId: string, ops: Awaited<ReturnType<typeof readFactOpsFrom>>["items"]): void {
  const insert = db.prepare(
    "INSERT OR REPLACE INTO facts (id, agent_id, ts, text, entities, source, valid_from, valid_to, superseded_by, hash, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT access_count FROM facts WHERE id = ?), 0))",
  );
  const insertFts = db.prepare("INSERT INTO facts_fts (text, id) VALUES (?, ?)");
  const dropFts = db.prepare("DELETE FROM facts_fts WHERE id = ?");
  const invalidate = db.prepare("UPDATE facts SET valid_to = ?, superseded_by = ? WHERE id = ? AND valid_to IS NULL");
  for (const op of ops) {
    if (op.op === "add") {
      dropFts.run(op.id); // replace ⇒ no duplicate FTS row
      insert.run(op.id, agentId, op.ts, op.text, op.entities ? JSON.stringify(op.entities) : null, op.source, op.validFrom, op.validTo ?? null, op.supersededBy ?? null, sha256Hex(op.text), op.id);
      insertFts.run(op.text, op.id);
    } else {
      invalidate.run(op.ts, op.supersededBy ?? null, op.id);
    }
  }
}

function applyEpisodes(db: DatabaseSync, agentId: string, episodes: Awaited<ReturnType<typeof readEpisodesFrom>>["items"]): void {
  const insert = db.prepare(
    "INSERT OR REPLACE INTO episodes (id, agent_id, ts, room_id, outcome, task, reply, lesson, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFts = db.prepare("INSERT INTO episodes_fts (text, id) VALUES (?, ?)");
  const dropFts = db.prepare("DELETE FROM episodes_fts WHERE id = ?");
  for (const episode of episodes) {
    const text = [episode.task, episode.reply, episode.lesson ?? ""].filter(Boolean).join(" ");
    dropFts.run(episode.id);
    insert.run(episode.id, agentId, episode.ts, episode.roomId, episode.outcome, episode.task, episode.reply, episode.lesson ?? null, sha256Hex(text));
    insertFts.run(text, episode.id);
  }
}

// --- embeddings cache (vectors land in P2; the plumbing is uniform now) -----------

/** Rows whose text has no cached vector yet: chunks ∪ facts ∪ episodes. */
export function pendingEmbeddings(db: DatabaseSync, limit = 256): Array<{ hash: string; text: string }> {
  return db
    .prepare(
      `SELECT hash, text FROM (
         SELECT hash, text FROM chunks WHERE open = 0
         UNION SELECT hash, text FROM facts WHERE valid_to IS NULL
         UNION SELECT e.hash, e.task || ' ' || e.reply || COALESCE(' ' || e.lesson, '') AS text FROM episodes e
       ) WHERE hash NOT IN (SELECT hash FROM embeddings) LIMIT ?`,
    )
    .all(limit) as Array<{ hash: string; text: string }>;
}

/** Store vectors int8 @ EMBED_STORE_DIM (truncate → normalize → quantize). */
export function storeEmbeddings(db: DatabaseSync, vectors: Array<{ hash: string; vec: Float32Array }>): void {
  if (!vectors.length) return;
  const insert = db.prepare("INSERT OR REPLACE INTO embeddings (hash, dim, vec, fmt) VALUES (?, ?, ?, 'i8')");
  for (const { hash, vec } of vectors) {
    const quantized = quantizeInt8(prepareVector(vec));
    insert.run(hash, quantized.length, Buffer.from(quantized.buffer, quantized.byteOffset, quantized.byteLength));
  }
  denseCache.delete(db);
}

export function countEmbeddings(db: DatabaseSync): { cached: number; pending: number } {
  const cached = (db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n;
  const pending = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT hash FROM chunks WHERE open = 0
           UNION SELECT hash FROM facts WHERE valid_to IS NULL
           UNION SELECT hash FROM episodes
         ) WHERE hash NOT IN (SELECT hash FROM embeddings)`,
      )
      .get() as { n: number }
  ).n;
  return { cached, pending };
}

// --- health — degradation is loud (§10) --------------------------------------------

export type MemoryHealthState = "ok" | "off" | "degraded" | "dead" | "building";

export interface MemoryHealthRow {
  component: string;
  state: MemoryHealthState;
  detail: string;
  ts: string;
}

export function setHealth(db: DatabaseSync, component: string, state: MemoryHealthState, detail: string, now?: Date): void {
  db.prepare(
    "INSERT INTO health (component, state, detail, ts) VALUES (?, ?, ?, ?) ON CONFLICT(component) DO UPDATE SET state = excluded.state, detail = excluded.detail, ts = excluded.ts",
  ).run(component, state, detail, (now ?? new Date()).toISOString());
}

export function readHealth(db: DatabaseSync): MemoryHealthRow[] {
  return db.prepare("SELECT component, state, detail, ts FROM health ORDER BY component").all() as unknown as MemoryHealthRow[];
}

// --- search --------------------------------------------------------------------

export interface MemorySearchHit {
  kind: "fact" | "episode" | "transcript";
  id?: string;
  /** Full text: the fact, the episode line, or the whole chunk. */
  text: string;
  /** FTS5-built excerpt around the match (transcript chunks) — what compact
   * renderings (auto-recall lines) show instead of the full chunk. */
  snippet?: string;
  ts: string;
  score: number;
  source?: FactSource;
  outcome?: EpisodeOutcome;
  roomId?: string;
  speakers?: string[];
  /** Kept for the bare-CLI transcript path and older callers. */
  author?: string;
}

export interface ActiveContextRef {
  roomId: string;
  /** Transcript line index below which content is NOT in the agent's active
   * context (never loaded, or evicted by compaction). Events at or above the
   * floor are in context and excluded from recall (CALMem, failure #4). */
  floorIdx: number;
}

export interface WorkspaceSearchOptions {
  /** Whose facts + episodes to search; transcript chunks are workspace-wide. */
  agentId: string;
  /** Precomputed query vector; absent = lexical-only (the P1 floor). */
  queryVec?: Float32Array;
  limit?: number;
  includeInvalidated?: boolean;
  halfLifeDays?: number;
  minScore?: number;
  now?: Date;
  exclude?: ActiveContextRef;
}

const LIST_DEPTH = 50;
// Fetch deeper than the list so active-context exclusion can't empty a page.
const FETCH_DEPTH = LIST_DEPTH * 3;
const DECAY_FLOOR = 0.25;
const SNIPPET_TOKENS = 24;
// Calibrated convex fusion (§7): fused = α·dense + (1−α)·lexical over
// max-normalized lists. (The design names min-max; max-norm differs only by
// the min-shift and avoids zeroing the tail under the threshold gate.)
const FUSION_ALPHA = 0.5;
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

function decay(ts: string, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(ts)) / 86_400_000);
  if (!Number.isFinite(ageDays)) return DECAY_FLOOR;
  return Math.max(DECAY_FLOOR, 0.5 ** (ageDays / halfLifeDays));
}

interface Scored {
  hit: MemorySearchHit;
  /** Per-table max-normalized bm25 — real magnitude, not a fold of ranks. */
  lexical: number;
  /** Max-normalized cosine from the dense arm (0 = not a dense candidate). */
  dense: number;
  weight: number;
  accessCount: number;
}

// Dense-arm scan cache: decoding every stored vector per query would dominate
// the hot path, so vectors stay resident per open handle and reload when the
// row count changes (storeEmbeddings also invalidates directly).
interface DenseCacheEntry {
  count: number;
  hashes: string[];
  vecs: Array<Int8Array | Float32Array>;
}
const denseCache = new WeakMap<DatabaseSync, DenseCacheEntry>();

function denseRows(db: DatabaseSync): DenseCacheEntry {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n;
  const cached = denseCache.get(db);
  if (cached && cached.count === count) return cached;
  const rows = db.prepare("SELECT hash, dim, vec, fmt FROM embeddings").all() as unknown as Array<{ hash: string; dim: number; vec: Uint8Array; fmt: string }>;
  const entry: DenseCacheEntry = { count, hashes: [], vecs: [] };
  for (const row of rows) {
    const buf = Buffer.from(row.vec);
    entry.hashes.push(row.hash);
    entry.vecs.push(
      row.fmt === "i8"
        ? new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        : new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)),
    );
  }
  denseCache.set(db, entry);
  return entry;
}

/** cosine(query, stored) for either stored format; both sides unit-normalized
 * at store/prepare time, so a plain dot suffices. */
function storedCosine(q: Float32Array, stored: Int8Array | Float32Array): number {
  const n = Math.min(q.length, stored.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += q[i] * stored[i];
  return stored instanceof Int8Array ? dot / 127 : dot;
}

/** Global hybrid search over the workspace index. Lexical is ONE bm25 ranking
 * per table with global corpus statistics, max-normalized per table so score
 * magnitude survives into the fused pool (the structural fix for v3 failure
 * #3, where per-room rank folding made 105 rooms tie and recency decide).
 * With a queryVec, a dense arm scans the quantized vectors and the two lists
 * fuse convexly (α·dense + (1−α)·lexical) before the soft signals. */
export function searchWorkspaceIndex(db: DatabaseSync, query: string, options: WorkspaceSearchOptions): MemorySearchHit[] {
  const limit = options.limit ?? 8;
  const now = options.now ?? new Date();
  const halfLife = options.halfLifeDays ?? 60;
  const match = ftsQuery(query);
  if (!match && !options.queryVec) return [];
  const pool = new Map<string, Scored>();

  const upsert = (key: string, make: () => Scored): Scored => {
    let entry = pool.get(key);
    if (!entry) {
      entry = make();
      pool.set(key, entry);
    }
    return entry;
  };

  const validity = options.includeInvalidated ? "" : "AND f.valid_to IS NULL";
  if (match) {
    // Facts: the agent's own store ∪ the workspace-shared store (§5) — every
    // persona reads shared facts about the user/world.
    const factRows = db
      .prepare(
        `SELECT f.id, f.ts, f.text, f.source, f.access_count, -bm25(facts_fts) AS raw FROM facts_fts
         JOIN facts f ON f.id = facts_fts.id
         WHERE facts_fts MATCH ? AND f.agent_id IN (?, ?) ${validity} ORDER BY rank LIMIT ?`,
      )
      .all(match, options.agentId, WORKSPACE_FACTS_AGENT, LIST_DEPTH) as Array<{ id: string; ts: string; text: string; source: FactSource; access_count: number; raw: number }>;
    normalize(factRows).forEach(({ row, rel }) => {
      upsert(`fact:${row.id}`, () => ({
        hit: { kind: "fact", id: row.id, text: row.text, ts: row.ts, score: 0, source: row.source },
        lexical: 0,
        dense: 0,
        weight: SOURCE_WEIGHT[row.source] ?? 1.0,
        accessCount: row.access_count,
      })).lexical = rel;
    });

    const episodeRows = db
      .prepare(
        `SELECT e.id, e.ts, e.room_id, e.outcome, e.task, e.reply, e.lesson, -bm25(episodes_fts) AS raw FROM episodes_fts
         JOIN episodes e ON e.id = episodes_fts.id
         WHERE episodes_fts MATCH ? AND e.agent_id = ? ORDER BY rank LIMIT ?`,
      )
      .all(match, options.agentId, FETCH_DEPTH) as Array<{ id: string; ts: string; room_id: string; outcome: EpisodeOutcome; task: string; reply: string; lesson: string | null; raw: number }>;
    // Episodes distill the asking room's own turns — inside the active context
    // they are self-matches like the chunks they summarize. They carry no event
    // indexes (P1), so the whole asking room is excluded conservatively; the
    // raw chunks below the floor stay recallable either way.
    const visibleEpisodes = episodeRows.filter((row) => !(options.exclude && row.room_id === options.exclude.roomId));
    normalize(visibleEpisodes.slice(0, LIST_DEPTH)).forEach(({ row, rel }) => {
      upsert(`episode:${row.id}`, () => ({
        hit: {
          kind: "episode",
          id: row.id,
          text: row.lesson ?? `${row.task} → ${row.reply}`,
          ts: row.ts,
          score: 0,
          outcome: row.outcome,
          roomId: row.room_id,
        },
        lexical: 0,
        dense: 0,
        weight: EPISODE_WEIGHT,
        accessCount: 0,
      })).lexical = rel;
    });

    // Transcript chunks: workspace-wide by design (one human's history, every
    // persona can recall it), minus the asking agent's active context window.
    const chunkRows = db
      .prepare(
        `SELECT c.id, c.room_id, c.first_idx, c.last_idx, c.ts_from, c.speakers, c.text, -bm25(chunks_fts) AS raw,
                snippet(chunks_fts, 0, '', '', '…', ${SNIPPET_TOKENS}) AS snip
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id
         WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, FETCH_DEPTH) as Array<{ id: number; room_id: string; first_idx: number; last_idx: number; ts_from: string; speakers: string; text: string; raw: number; snip: string }>;
    const visible = chunkRows.filter((row) => !(options.exclude && row.room_id === options.exclude.roomId && row.last_idx >= options.exclude.floorIdx));
    normalize(visible.slice(0, LIST_DEPTH)).forEach(({ row, rel }) => {
      const speakers = safeStringArray(row.speakers);
      upsert(`chunk:${row.id}`, () => ({
        hit: {
          kind: "transcript",
          id: String(row.id),
          text: row.text,
          snippet: row.snip,
          ts: row.ts_from,
          score: 0,
          roomId: row.room_id,
          speakers,
          author: speakers[0],
        },
        lexical: 0,
        dense: 0,
        weight: TRANSCRIPT_WEIGHT,
        accessCount: 0,
      })).lexical = rel;
    });
  }

  const denseRan = options.queryVec ? foldDenseArm(db, options, pool, upsert) : false;

  // Convex fusion over the max-normalized arms (α = FUSION_ALPHA). Without a
  // dense arm, fused = lexical — the P1 scale, so thresholds keep meaning.
  const results = [...pool.values()]
    .map((scored) => {
      const boost = 1 + 0.05 * Math.log1p(scored.accessCount);
      const fused = denseRan ? FUSION_ALPHA * scored.dense + (1 - FUSION_ALPHA) * scored.lexical : scored.lexical;
      scored.hit.score = fused * scored.weight * decay(scored.hit.ts, now, halfLife) * boost;
      return scored.hit;
    })
    .filter((hit) => hit.score >= (options.minScore ?? 0))
    .sort((a, b) => b.score - a.score);

  const deduped = dedupeByText(results).slice(0, limit);

  // Access counts feed the ranking boost; losing them costs nothing (the
  // index is derived), so this is best-effort.
  const bump = db.prepare("UPDATE facts SET access_count = access_count + 1 WHERE id = ?");
  for (const hit of deduped) if (hit.kind === "fact" && hit.id) bump.run(hit.id);

  return deduped;
}

/** The dense arm: brute-force cosine over the quantized vector cache, top-50
 * hashes ≥ MIN_COSINE, mapped back onto chunk/fact/episode rows (same scope +
 * exclusion rules as the lexical arm), cosines max-normalized into the pool.
 * Exclusion applies BEFORE normalization (fetch deep → filter → slice → norm,
 * exactly like the lexical arm) — an excluded self-match must not sit in the
 * denominator deflating every visible score. Returns whether the arm actually
 * contributed (vectors existed). */
function foldDenseArm(db: DatabaseSync, options: WorkspaceSearchOptions, pool: Map<string, Scored>, upsert: (key: string, make: () => Scored) => Scored): boolean {
  const cache = denseRows(db);
  if (!cache.hashes.length) return false;
  const q = prepareVector(options.queryVec as Float32Array);

  const sims: Array<{ hash: string; sim: number }> = [];
  for (let i = 0; i < cache.hashes.length; i += 1) {
    const sim = storedCosine(q, cache.vecs[i]);
    if (sim >= MIN_COSINE) sims.push({ hash: cache.hashes[i], sim });
  }
  if (!sims.length) return true; // the arm ran; it found nothing close enough
  sims.sort((a, b) => b.sim - a.sim);
  const fetched = sims.slice(0, FETCH_DEPTH);
  const fetchedHashes = fetched.map((entry) => entry.hash);
  const marks = fetchedHashes.map(() => "?").join(",");

  const chunkRows = (
    db
      .prepare(`SELECT id, room_id, first_idx, last_idx, ts_from, speakers, text, hash FROM chunks WHERE hash IN (${marks})`)
      .all(...fetchedHashes) as Array<{ id: number; room_id: string; first_idx: number; last_idx: number; ts_from: string; speakers: string; text: string; hash: string }>
  ).filter((row) => !(options.exclude && row.room_id === options.exclude.roomId && row.last_idx >= options.exclude.floorIdx));

  const validity = options.includeInvalidated ? "" : "AND valid_to IS NULL";
  const factRows = db
    .prepare(`SELECT id, ts, text, source, access_count, hash FROM facts WHERE hash IN (${marks}) AND agent_id IN (?, ?) ${validity}`)
    .all(...fetchedHashes, options.agentId, WORKSPACE_FACTS_AGENT) as Array<{ id: string; ts: string; text: string; source: FactSource; access_count: number; hash: string }>;

  const episodeRows = (
    db
      .prepare(`SELECT id, ts, room_id, outcome, task, reply, lesson, hash FROM episodes WHERE hash IN (${marks}) AND agent_id = ?`)
      .all(...fetchedHashes, options.agentId) as Array<{ id: string; ts: string; room_id: string; outcome: EpisodeOutcome; task: string; reply: string; lesson: string | null; hash: string }>
  ).filter((row) => !(options.exclude && row.room_id === options.exclude.roomId));

  const visible = new Set<string>();
  for (const row of chunkRows) visible.add(row.hash);
  for (const row of factRows) visible.add(row.hash);
  for (const row of episodeRows) visible.add(row.hash);
  const top = fetched.filter((entry) => visible.has(entry.hash)).slice(0, LIST_DEPTH);
  if (!top.length) return true;
  const maxSim = top[0].sim;
  const simByHash = new Map(top.map((entry) => [entry.hash, entry.sim / maxSim]));

  for (const row of chunkRows) {
    if (!simByHash.has(row.hash)) continue;
    const speakers = safeStringArray(row.speakers);
    upsert(`chunk:${row.id}`, () => ({
      hit: {
        kind: "transcript",
        id: String(row.id),
        text: row.text,
        // No FTS match to excerpt around — lead of the chunk stands in.
        snippet: row.text.length > 240 ? `${row.text.slice(0, 240)}…` : row.text,
        ts: row.ts_from,
        score: 0,
        roomId: row.room_id,
        speakers,
        author: speakers[0],
      },
      lexical: 0,
      dense: 0,
      weight: TRANSCRIPT_WEIGHT,
      accessCount: 0,
    })).dense = simByHash.get(row.hash) ?? 0;
  }

  for (const row of factRows) {
    if (!simByHash.has(row.hash)) continue;
    upsert(`fact:${row.id}`, () => ({
      hit: { kind: "fact", id: row.id, text: row.text, ts: row.ts, score: 0, source: row.source },
      lexical: 0,
      dense: 0,
      weight: SOURCE_WEIGHT[row.source] ?? 1.0,
      accessCount: row.access_count,
    })).dense = simByHash.get(row.hash) ?? 0;
  }

  for (const row of episodeRows) {
    if (!simByHash.has(row.hash)) continue;
    upsert(`episode:${row.id}`, () => ({
      hit: {
        kind: "episode",
        id: row.id,
        text: row.lesson ?? `${row.task} → ${row.reply}`,
        ts: row.ts,
        score: 0,
        outcome: row.outcome,
        roomId: row.room_id,
      },
      lexical: 0,
      dense: 0,
      weight: EPISODE_WEIGHT,
      accessCount: 0,
    })).dense = simByHash.get(row.hash) ?? 0;
  }

  return true;
}

function normalize<T extends { raw: number }>(rows: T[]): Array<{ row: T; rel: number }> {
  const max = rows.reduce((best, row) => Math.max(best, row.raw), 0);
  if (max <= 0) return rows.map((row) => ({ row, rel: rows.length ? 1 : 0 }));
  return rows.map((row) => ({ row, rel: Math.max(0, row.raw) / max }));
}

/** Near-identical texts pad the injection with no new information — keep the
 * best-scored of each normalized prefix. */
function dedupeByText(hits: MemorySearchHit[]): MemorySearchHit[] {
  const seen = new Set<string>();
  const out: MemorySearchHit[] = [];
  for (const hit of hits) {
    const key = hit.text.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function safeStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** No-daemon fallback recall (bare `gaia recall`, pi without a bridge): the
 * same workspace index, opened directly, lexical-only, no active-context
 * exclusion (without the daemon nobody knows the context window). §14: the
 * per-room recall.db fallback retired with the rest of v3. */
export async function bareWorkspaceRecall(
  workspaceRoot: string,
  query: string,
  options: { agentId?: string; memoryDir?: string; limit?: number } = {},
): Promise<MemorySearchHit[]> {
  const db = openWorkspaceIndex(workspaceRoot);
  try {
    await syncWorkspaceIndex(db, {
      rooms: workspaceRoomRefs(workspaceRoot),
      agents: [
        ...(options.agentId && options.memoryDir ? [{ agentId: options.agentId, memoryDir: options.memoryDir }] : []),
        sharedMemorySource(workspaceRoot),
      ],
    });
    return searchWorkspaceIndex(db, query, { agentId: options.agentId ?? "", limit: options.limit });
  } finally {
    db.close();
  }
}

// --- deep path (§8) ---------------------------------------------------------------

/** "Retrieve small, read big": widen each transcript hit to its ±1 chunk
 * neighborhood before rendering. The hit stays the ranking anchor; only its
 * text grows. Non-transcript hits pass through untouched. */
export function expandChunkWindows(db: DatabaseSync, hits: MemorySearchHit[]): void {
  const anchor = db.prepare("SELECT room_id, first_idx, last_idx FROM chunks WHERE id = ?");
  const prevStmt = db.prepare(
    "SELECT text FROM chunks WHERE room_id = ? AND (first_idx < ? OR (first_idx = ? AND id < ?)) ORDER BY first_idx DESC, id DESC LIMIT 1",
  );
  const nextStmt = db.prepare(
    "SELECT text FROM chunks WHERE room_id = ? AND (first_idx > ? OR (first_idx = ? AND id > ?)) ORDER BY first_idx ASC, id ASC LIMIT 1",
  );
  for (const hit of hits) {
    if (hit.kind !== "transcript" || !hit.id) continue;
    const id = Number(hit.id);
    if (!Number.isFinite(id)) continue;
    const row = anchor.get(id) as { room_id: string; first_idx: number; last_idx: number } | undefined;
    if (!row) continue;
    const prev = prevStmt.get(row.room_id, row.first_idx, row.first_idx, id) as { text: string } | undefined;
    const next = nextStmt.get(row.room_id, row.first_idx, row.first_idx, id) as { text: string } | undefined;
    if (prev || next) hit.text = [prev?.text, hit.text, next?.text].filter(Boolean).join("\n");
  }
}

/** The scroll pager (§8): raw transcript lines around a previous transcript
 * hit — a no-LLM window the caller pages with `span`/`offset`. `undefined`
 * when the hit id is unknown. Offset shifts the window (negative = earlier). */
export async function scrollTranscriptWindow(
  workspaceRoot: string,
  chunkId: number,
  options: { span?: number; offset?: number } = {},
): Promise<string | undefined> {
  const span = options.span && options.span > 0 ? Math.min(options.span, 200) : 12;
  const db = openWorkspaceIndex(workspaceRoot);
  let row: { room_id: string; first_idx: number; last_idx: number } | undefined;
  try {
    row = db.prepare("SELECT room_id, first_idx, last_idx FROM chunks WHERE id = ?").get(chunkId) as typeof row;
  } finally {
    db.close();
  }
  if (!row) return undefined;
  const transcriptPath = workspacePaths.transcript(workspaceRoot, row.room_id);
  const raw = await readFile(transcriptPath, "utf8").catch(() => "");
  if (!raw) return undefined;
  const lines = raw.split("\n").filter((line) => line.trim());
  const center = Math.floor((row.first_idx + row.last_idx) / 2) + (options.offset ?? 0);
  const from = Math.max(0, center - span);
  const to = Math.min(lines.length - 1, center + span);
  const out: string[] = [`room ${row.room_id} · events ${from}–${to} of ${lines.length} (hit ${chunkId} at ${row.first_idx}–${row.last_idx})`];
  for (let idx = from; idx <= to; idx += 1) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[idx]) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof parsed.text !== "string" || typeof parsed.author !== "string") continue;
    const marker = idx >= row.first_idx && idx <= row.last_idx ? "▶" : " ";
    const text = parsed.text.length > 500 ? `${parsed.text.slice(0, 500)}…` : parsed.text;
    out.push(`${marker}[${idx}] @${parsed.author}: ${text.replace(/\n/g, "\n    ")}`);
  }
  return out.join("\n");
}

// --- chat search (web client) ----------------------------------------------------

/** Sentinels the FTS snippet wraps matched terms in — the web client escapes
 * the text then swaps these for <mark>. Private-use codepoints so they never
 * collide with transcript content. */
export const SEARCH_MARK_OPEN = String.fromCharCode(0xe000);
export const SEARCH_MARK_CLOSE = String.fromCharCode(0xe001);

export interface TranscriptSearchHit {
  chunkId: number;
  roomId: string;
  /** The matched chunk's message ids — the client jumps to eventIds[0]. */
  eventIds: string[];
  /** FTS excerpt, matched terms wrapped in SEARCH_MARK_OPEN/CLOSE. */
  snippet: string;
  text: string;
  ts: string;
  speakers: string[];
  score: number;
}

export interface TranscriptSearchOptions {
  limit?: number;
  /** Restrict to one room (in-chat search); omit for workspace-wide. */
  roomId?: string;
}

/** Transcript-only full-text search — the web client's chat search. Unlike
 * searchWorkspaceIndex this returns plain bm25 order (no decay, no fusion, no
 * agent scoping, no facts/episodes) and, crucially, each matched chunk's
 * event_ids so the client can jump to the message. Workspace-wide by default;
 * `roomId` scopes to a single chat. Reuses the same DoS-bounded ftsQuery. */
export function searchTranscripts(db: DatabaseSync, query: string, options: TranscriptSearchOptions = {}): TranscriptSearchHit[] {
  const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 200) : 40;
  const match = ftsQuery(query);
  if (!match) return [];
  const roomFilter = options.roomId ? "AND c.room_id = ?" : "";
  const params: Array<string | number> = [match];
  if (options.roomId) params.push(options.roomId);
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT c.id, c.room_id, c.event_ids, c.ts_from, c.speakers, c.text, -bm25(chunks_fts) AS raw,
              snippet(chunks_fts, 0, '${SEARCH_MARK_OPEN}', '${SEARCH_MARK_CLOSE}', '…', ${SNIPPET_TOKENS}) AS snip
       FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id
       WHERE chunks_fts MATCH ? ${roomFilter} ORDER BY rank LIMIT ?`,
    )
    .all(...params) as Array<{ id: number; room_id: string; event_ids: string; ts_from: string; speakers: string; text: string; raw: number; snip: string }>;
  return rows.map((row) => ({
    chunkId: row.id,
    roomId: row.room_id,
    eventIds: safeStringArray(row.event_ids),
    snippet: row.snip,
    text: row.text,
    ts: row.ts_from,
    speakers: safeStringArray(row.speakers),
    score: row.raw,
  }));
}

// --- rendering -------------------------------------------------------------------

/** One line per hit, shared by the recall tool, `gaia recall`, and /recall.
 * Absolute dates + attribution (§7); transcript hits show the FTS excerpt
 * unless `full` asks for whole chunks (the deep path's rendering, where the
 * hit id is printed so `gaia recall --around <id>` can scroll from it). */
export function formatMemoryHits(hits: MemorySearchHit[], options: { full?: boolean } = {}): string {
  return hits
    .map((hit) => {
      const date = hit.ts.slice(0, 10) || "unknown-date";
      if (hit.kind === "fact") return `[${date} · fact · ${hit.source ?? "unknown"}] ${hit.text}`;
      if (hit.kind === "episode") return `[${date} · episode · ${hit.outcome ?? "unknown"}${hit.roomId ? ` · room ${hit.roomId}` : ""}] ${hit.text}`;
      const who = hit.speakers?.length ? hit.speakers.map((speaker) => `@${speaker}`).join(" ") : `@${hit.author ?? "?"}`;
      const body = options.full ? hit.text : (hit.snippet ?? hit.text);
      const anchor = options.full && hit.id ? ` · hit ${hit.id}` : "";
      return `[${date} · room ${hit.roomId ?? "?"} · ${who}${anchor}] ${body}`;
    })
    .join("\n");
}
