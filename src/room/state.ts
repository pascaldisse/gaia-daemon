import { join } from "node:path";
import { jsonText, readJsonFile, writeFileAtomic } from "../lib/fs.js";
import type { MonadConfig, MonadSlot } from "../runtime/monad/types.js";

export interface RoomState {
  activeRoles: Record<string, string>;
  agentCursors: Record<string, number>;
  runtimeDetails: Record<string, RuntimeMessageDetails>;
  // Set on a summon's child sub-room: the room that spawned it. Drives the
  // nested (recursive, collapsed) rooms tree. Absent on top-level rooms.
  parentRoomId?: string;
  // Set when a setup is activated into this room: the active monad config. Its
  // presence makes the room a monad room — plain user messages route through
  // MonadEngine instead of a single agent turn. Written by setup activation.
  monad?: MonadConfig;
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

// Parse a persisted monad block, or undefined when malformed — a bad block must
// never brick a room; it just stops being a monad room until re-activated.
function monadConfigFrom(value: unknown): MonadConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.policy !== "string" || !value.policy.trim()) return undefined;
  if (!Array.isArray(value.slots)) return undefined;

  const slots: MonadSlot[] = [];
  for (const raw of value.slots) {
    if (!isRecord(raw) || typeof raw.agentId !== "string" || !raw.agentId.trim()) continue;
    const index = typeof raw.index === "number" && Number.isFinite(raw.index) ? Math.floor(raw.index) : slots.length;
    slots.push({
      index,
      agentId: raw.agentId,
      ...(typeof raw.label === "string" && raw.label.trim() ? { label: raw.label } : {}),
      ...(typeof raw.defaultRole === "string" && raw.defaultRole.trim() ? { defaultRole: raw.defaultRole } : {}),
    });
  }
  if (slots.length === 0) return undefined;

  const roles = Array.isArray(value.roles) ? value.roles.filter((role): role is string => typeof role === "string" && role.trim().length > 0) : [];
  const maxTurns = typeof value.maxTurns === "number" && Number.isFinite(value.maxTurns) && value.maxTurns > 0 ? Math.floor(value.maxTurns) : 5;
  const terminate =
    isRecord(value.terminate) && value.terminate.on === "verifier-accept" && typeof value.terminate.acceptToken === "string"
      ? { on: "verifier-accept" as const, acceptToken: value.terminate.acceptToken }
      : undefined;
  const rolePrompts = isRecord(value.rolePrompts)
    ? Object.fromEntries(Object.entries(value.rolePrompts).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;

  return {
    policy: value.policy,
    ...(value.policyConfig !== undefined ? { policyConfig: value.policyConfig } : {}),
    slots,
    roles,
    maxTurns,
    ...(typeof value.coordinatorAgentId === "string" && value.coordinatorAgentId.trim() ? { coordinatorAgentId: value.coordinatorAgentId } : {}),
    ...(terminate ? { terminate } : {}),
    ...(rolePrompts && Object.keys(rolePrompts).length > 0 ? { rolePrompts } : {}),
  };
}

export function normalizeRoomState(value: unknown): RoomState {
  if (!isRecord(value)) return defaultRoomState();

  const monad = monadConfigFrom(value.monad);
  return {
    activeRoles: stringRecord(value.activeRoles),
    agentCursors: cursorRecord(value.agentCursors),
    runtimeDetails: runtimeDetailsRecord(value.runtimeDetails),
    ...(typeof value.parentRoomId === "string" && value.parentRoomId.trim() ? { parentRoomId: value.parentRoomId } : {}),
    ...(monad ? { monad } : {}),
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
