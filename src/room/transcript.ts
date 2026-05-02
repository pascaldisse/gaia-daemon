import { existsSync } from "node:fs";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface UserRoomEvent {
  timestamp: string;
  author: "user";
  targets: string[];
  text: string;
}

export interface AgentRoomEvent {
  timestamp: string;
  author: string;
  text: string;
}

export type RoomEvent = UserRoomEvent | AgentRoomEvent;

function isRoomEvent(value: unknown): value is RoomEvent {
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

  const lines = text.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim());
  const safeCursor = Math.max(0, Math.floor(cursor));
  const events = nonEmptyLines
    .slice(safeCursor)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    })
    .filter(isRoomEvent);

  return { events, nextCursor: nonEmptyLines.length };
}

export async function readRecentRoomEvents(path: string, limit: number): Promise<RoomEvent[]> {
  const { events } = await readTranscriptFromCursor(path, 0);
  return events.slice(-limit);
}

export async function readRoomEventsAfterCursor(path: string, cursor: number): Promise<ReadTranscriptResult> {
  return readTranscriptFromCursor(path, cursor);
}

export async function countRoomEventLines(path: string): Promise<number> {
  return (await readTranscriptFromCursor(path, 0)).nextCursor;
}
