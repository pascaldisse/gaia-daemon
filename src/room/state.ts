import { join } from "node:path";
import { jsonText, readJsonFile, writeFileAtomic } from "../lib/fs.js";

export interface RoomState {
  activeRoles: Record<string, string>;
  agentCursors: Record<string, number>;
  runtimeDetails: Record<string, RuntimeMessageDetails>;
  // Set on a summon's child sub-room: the room that spawned it. Drives the
  // nested (recursive, collapsed) rooms tree. Absent on top-level rooms.
  parentRoomId?: string;
}

export interface RuntimeToolDetails {
  id: string;
  toolName: string;
  status: "running" | "complete" | "error";
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
}

export interface RuntimeMessageDetails {
  /** Model that produced this message, e.g. "openai/gpt-5.1-codex (oauth)". */
  model?: string;
  thinkingStarted?: boolean;
  thinking?: string;
  tools?: RuntimeToolDetails[];
}

export function defaultRoomState(): RoomState {
  return {
    activeRoles: {},
    agentCursors: {},
    runtimeDetails: {},
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

function runtimeToolDetails(value: unknown): RuntimeToolDetails | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.toolName !== "string") return undefined;
  const status = value.status === "running" || value.status === "error" ? value.status : "complete";
  return {
    id: value.id,
    toolName: value.toolName,
    status,
    ...(value.args !== undefined ? { args: value.args } : {}),
    ...(value.partialResult !== undefined ? { partialResult: value.partialResult } : {}),
    ...(value.result !== undefined ? { result: value.result } : {}),
  };
}

function runtimeMessageDetails(value: unknown): RuntimeMessageDetails | undefined {
  if (!isRecord(value)) return undefined;
  const tools = Array.isArray(value.tools) ? value.tools.map(runtimeToolDetails).filter((tool): tool is RuntimeToolDetails => Boolean(tool)) : undefined;
  const details: RuntimeMessageDetails = {
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    ...(value.thinkingStarted === true ? { thinkingStarted: true } : {}),
    ...(typeof value.thinking === "string" && value.thinking.length > 0 ? { thinking: value.thinking } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
  return details.model || details.thinkingStarted || details.thinking || details.tools?.length ? details : undefined;
}

function runtimeDetailsRecord(value: unknown): Record<string, RuntimeMessageDetails> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, details]) => [key, runtimeMessageDetails(details)] as const)
      .filter((entry): entry is [string, RuntimeMessageDetails] => Boolean(entry[1])),
  );
}

export function normalizeRoomState(value: unknown): RoomState {
  if (!isRecord(value)) return defaultRoomState();

  return {
    activeRoles: stringRecord(value.activeRoles),
    agentCursors: cursorRecord(value.agentCursors),
    runtimeDetails: runtimeDetailsRecord(value.runtimeDetails),
    ...(typeof value.parentRoomId === "string" && value.parentRoomId.trim() ? { parentRoomId: value.parentRoomId } : {}),
  };
}

export async function readRoomState(path: string): Promise<RoomState> {
  return normalizeRoomState(await readJsonFile(path));
}

// State is normalized on read; in-process mutations keep the shape, so writes
// serialize directly instead of deep-rebuilding the whole map every turn.
export async function writeRoomState(path: string, state: RoomState): Promise<void> {
  await writeFileAtomic(path, jsonText(state));
}
