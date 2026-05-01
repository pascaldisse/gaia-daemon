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

export async function readRecentRoomEvents(path: string, limit: number): Promise<RoomEvent[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  if (!text.trim()) return [];

  const events = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    })
    .filter(isRoomEvent);

  return events.slice(-limit);
}
