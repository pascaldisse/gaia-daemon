import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RoomState {
  activeRoles: Record<string, string>;
  agentCursors: Record<string, number>;
  piSessions: Record<string, unknown>;
}

export function defaultRoomState(): RoomState {
  return {
    activeRoles: {},
    agentCursors: {},
    piSessions: {},
  };
}

export function roomStatePath(roomsDir: string, roomId: string): string {
  return join(roomsDir, roomId, "state.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0));
}

function cursorRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0)
      .map(([key, cursor]) => [key, Math.floor(cursor)]),
  );
}

export function normalizeRoomState(value: unknown): RoomState {
  if (!isRecord(value)) return defaultRoomState();

  return {
    activeRoles: stringRecord(value.activeRoles),
    agentCursors: cursorRecord(value.agentCursors),
    piSessions: isRecord(value.piSessions) ? value.piSessions : {},
  };
}

export async function readRoomState(path: string): Promise<RoomState> {
  if (!existsSync(path)) return defaultRoomState();

  try {
    return normalizeRoomState(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return defaultRoomState();
  }
}

export async function writeRoomState(path: string, state: RoomState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalizeRoomState(state), null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}
