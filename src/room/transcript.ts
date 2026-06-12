import { existsSync } from "node:fs";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { newId } from "../lib/ids.js";

export interface UserRoomEvent {
  id: string;
  timestamp: string;
  author: "user";
  targets: string[];
  text: string;
  // Surface the message arrived on; "voice" today, absent for typed messages.
  channel?: string;
}

export interface AgentRoomEvent {
  id: string;
  timestamp: string;
  author: string;
  text: string;
  channel?: string;
}

export type RoomEvent = UserRoomEvent | AgentRoomEvent;

export function newRoomEventId(): string {
  return newId("evt");
}

function isRoomEventLike(value: unknown): value is Omit<RoomEvent, "id"> & { id?: unknown } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RoomEvent>;
  return typeof candidate.timestamp === "string" && typeof candidate.author === "string" && typeof candidate.text === "string";
}

export async function appendRoomEvent(path: string, event: RoomEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

interface ReadTranscriptResult {
  events: RoomEvent[];
  nextCursor: number;
}

async function readTranscriptFromCursor(path: string, cursor: number): Promise<ReadTranscriptResult> {
  if (!existsSync(path)) return { events: [], nextCursor: 0 };
  const text = await readFile(path, "utf8");
  if (!text.trim()) return { events: [], nextCursor: 0 };

  const nonEmptyLines = text.split("\n").filter((line) => line.trim());
  const safeCursor = Math.max(0, Math.floor(cursor));
  const events: RoomEvent[] = [];

  nonEmptyLines.slice(safeCursor).forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRoomEventLike(parsed)) return;
    // Transcript lines written before events carried ids get a deterministic
    // line-based id so runtime-detail lookups stay stable across reads.
    const id = typeof parsed.id === "string" && parsed.id ? parsed.id : `legacy_${safeCursor + index}`;
    events.push({ ...parsed, id } as RoomEvent);
  });

  return { events, nextCursor: nonEmptyLines.length };
}

export async function readRecentRoomEvents(path: string, limit: number): Promise<RoomEvent[]> {
  const { events } = await readTranscriptFromCursor(path, 0);
  return events.slice(-limit);
}

export async function readRoomEventsAfterCursor(path: string, cursor: number): Promise<ReadTranscriptResult> {
  return readTranscriptFromCursor(path, cursor);
}
