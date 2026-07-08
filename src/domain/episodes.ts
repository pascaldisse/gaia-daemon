// Episodic memory: one JSONL line per settled task, captured mechanically
// post-commit (no LLM, no hot-path latency). Append-only source of truth;
// any index over it is derived and rebuildable.

import { join } from "node:path";
import type { JsonlPage } from "../core/store.js";
import { appendJsonl, appendText, readJsonlFrom, readText, writeTextAtomic } from "../core/store.js";

export type EpisodeOutcome = "complete" | "error" | "cancelled" | "user_corrected";

export interface Episode {
  id: string;
  ts: string;
  roomId: string;
  agentId: string;
  task: string;
  reply: string;
  outcome: EpisodeOutcome;
  tools?: string[];
  channel?: "text" | "voice";
  /** Added later by the consolidator, never at capture time. */
  lesson?: string;
}

export const EPISODES_FILE = "episodes.jsonl";

// task/reply are heads, not transcripts — the full text stays in the room log.
const HEAD_LIMIT = 400;

const OUTCOMES: readonly string[] = ["complete", "error", "cancelled", "user_corrected"];

export async function appendEpisode(dir: string, episode: Episode): Promise<void> {
  await appendJsonl(join(dir, EPISODES_FILE), {
    ...episode,
    task: episode.task.slice(0, HEAD_LIMIT),
    reply: episode.reply.slice(0, HEAD_LIMIT),
  });
}

export async function readEpisodesFrom(dir: string, cursor: number): Promise<JsonlPage<Episode>> {
  return readJsonlFrom(join(dir, EPISODES_FILE), cursor, episodeFrom);
}

/** Remove every episode captured in `roomId` from this agent's log — used when a
 * room is deleted so its turns stop surfacing in recall. This is the ONE place
 * the otherwise append-only log is rewritten; the write is atomic and every
 * other line (including unparseable ones) is preserved verbatim. When
 * `backupPath` is given the removed lines are copied there first, so a room
 * delete stays reversible. Returns how many episodes were removed. */
export async function purgeRoomEpisodes(dir: string, roomId: string, backupPath?: string): Promise<number> {
  const path = join(dir, EPISODES_FILE);
  const text = await readText(path);
  if (!text) return 0;
  const lines = text.split("\n").filter((line) => line.trim());
  const kept: string[] = [];
  const removed: string[] = [];
  for (const line of lines) {
    let room: unknown;
    try {
      room = (JSON.parse(line) as { roomId?: unknown }).roomId;
    } catch {
      kept.push(line); // leave anything unparseable untouched
      continue;
    }
    (room === roomId ? removed : kept).push(line);
  }
  if (!removed.length) return 0;
  if (backupPath) await appendText(backupPath, `${removed.join("\n")}\n`);
  await writeTextAtomic(path, kept.length ? `${kept.join("\n")}\n` : "");
  return removed.length;
}

function episodeFrom(raw: unknown): Episode | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.ts !== "string" || typeof record.task !== "string") return undefined;
  if (!OUTCOMES.includes(record.outcome as string)) return undefined;
  return record as unknown as Episode;
}
