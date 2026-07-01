// Episodic memory: one JSONL line per settled task, captured mechanically
// post-commit (no LLM, no hot-path latency). Append-only source of truth;
// any index over it is derived and rebuildable.

import { join } from "node:path";
import type { JsonlPage } from "../core/store.js";
import { appendJsonl, readJsonlFrom } from "../core/store.js";

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

function episodeFrom(raw: unknown): Episode | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.ts !== "string" || typeof record.task !== "string") return undefined;
  if (!OUTCOMES.includes(record.outcome as string)) return undefined;
  return record as unknown as Episode;
}
