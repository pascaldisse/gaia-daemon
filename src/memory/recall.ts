// Episodic recall over a room transcript: an SQLite FTS5 index (node:sqlite,
// zero dependencies) built lazily from transcript.jsonl. The transcript stays
// the source of truth; the index is derived data and safe to delete.
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface RecallHit {
  timestamp: string;
  author: string;
  channel?: string;
  snippet: string;
}

interface TranscriptLine {
  timestamp?: unknown;
  author?: unknown;
  text?: unknown;
  channel?: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS events USING fts5(text, author UNINDEXED, timestamp UNINDEXED, channel UNINDEXED);
`;

/**
 * Search the room transcript for past messages. Opens the index, catches it
 * up with any transcript lines appended since the last search, queries, and
 * closes - no long-lived handles to manage.
 */
export function searchTranscript(transcriptPath: string, dbPath: string, query: string, limit = 8): RecallHit[] {
  const match = ftsQuery(query);
  if (!match) return [];

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA);
    syncIndex(db, transcriptPath);
    const rows = db
      .prepare(
        `SELECT author, timestamp, channel, snippet(events, 0, '', '', '…', 48) AS snippet
         FROM events WHERE events MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as Array<{ author: string; timestamp: string; channel: string | null; snippet: string }>;
    return rows.map((row) => ({
      timestamp: row.timestamp,
      author: row.author,
      channel: row.channel ?? undefined,
      snippet: row.snippet,
    }));
  } finally {
    db.close();
  }
}

// FTS5 has its own query syntax; quoting each token and OR-ing them turns
// free-form questions into a ranked any-term match.
function ftsQuery(query: string): string {
  const tokens = query
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((token) => `"${token}"`);
  return tokens.join(" OR ");
}

function syncIndex(db: DatabaseSync, transcriptPath: string): void {
  const lines = existsSync(transcriptPath)
    ? readFileSync(transcriptPath, "utf8")
        .split("\n")
        .filter((line) => line.trim())
    : [];

  let indexed = (db.prepare("SELECT value FROM meta WHERE key = 'lines'").get() as { value: number } | undefined)?.value ?? 0;
  // Transcripts are append-only; fewer lines than indexed means the file was
  // replaced or hand-edited, so rebuild from scratch.
  if (lines.length < indexed) {
    db.exec("DELETE FROM events");
    indexed = 0;
  }
  if (lines.length === indexed) return;

  const insert = db.prepare("INSERT INTO events (text, author, timestamp, channel) VALUES (?, ?, ?, ?)");
  for (const line of lines.slice(indexed)) {
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (typeof parsed.text !== "string" || typeof parsed.author !== "string") continue;
    insert.run(parsed.text, parsed.author, typeof parsed.timestamp === "string" ? parsed.timestamp : "", typeof parsed.channel === "string" ? parsed.channel : null);
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('lines', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    lines.length,
  );
}
