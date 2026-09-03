import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { workspacePaths } from "../../core/paths.js";
import type { AgentRuntime } from "../../harness/spec.js";
import { RoomHandle } from "../../domain/rooms.js";
import type { RoomEvent, Workspace } from "../../core/types.js";
import type { SummonHost } from "../summons.js";
import { activateSetup, deactivateMonad, discoverSetups } from "../setups.js";

export interface RoomMaintenanceContext {
  workspace: Workspace;
  roomId: string;
  room: RoomHandle;
  runtimes: Record<string, AgentRuntime>;
  summonHost?: SummonHost;
  clearRecentTasks(): void;
  emitSnapshot(): Promise<void>;
  init(): Promise<void>;
  displayEvents(events: RoomEvent[]): RoomEvent[];
}

export async function runSetupCommand(
  context: RoomMaintenanceContext,
  command: { sub?: string; id?: string; room?: string },
): Promise<string> {
  const sub = command.sub ?? "list";
  if (sub === "list") {
    const setups = await discoverSetups(context.workspace.rootDir);
    if (setups.length === 0) return "No setups found. Bundled setups live under setups/, global under ~/.gaia/setups/, project under .gaia/setups/.";
    return [
      "Available setups:",
      ...setups.map((setup) => `  - ${setup.id}${setup.displayName && setup.displayName !== setup.id ? ` — ${setup.displayName}` : ""} [${setup.source}]${setup.description ? `\n      ${setup.description}` : ""}`),
    ].join("\n");
  }
  if (sub === "status") {
    const monad = (await context.room.state()).monad;
    if (!monad) return "This room is not a monad room. Activate a setup with /setup activate <id>.";
    const pool = monad.slots.map((slot) => `${slot.agentId}${slot.defaultRole ? `(${slot.defaultRole})` : ""}`).join(" · ");
    return `Monad active — policy: ${monad.policy}, maxTurns: ${monad.maxTurns}, coordinator: @${monad.coordinatorAgentId ?? monad.slots[0]?.agentId}\nPool: ${pool}`;
  }
  if (sub === "off") {
    const cleared = await deactivateMonad(context.workspace, context.roomId);
    context.room.invalidate();
    await context.emitSnapshot();
    return cleared ? "Cleared the monad from this room. Plain messages now go to the default agent." : "This room had no active monad.";
  }
  if (sub === "activate") {
    if (!command.id) return "Usage: /setup activate <id> [room]";
    if (!context.summonHost) return "Setups need the summon system, which is unavailable here.";
    const targetRoom = command.room ?? context.roomId;
    try {
      const result = await activateSetup(context.workspace, command.id, targetRoom);
      if (targetRoom === context.roomId) {
        context.room.invalidate();
        await context.emitSnapshot();
      }
      const pool = result.monad.slots.map((slot) => `@${slot.agentId}`).join(" · ");
      return `Activated setup '${result.setupId}' into room '${targetRoom}' (policy: ${result.monad.policy}, pool: ${pool}). Send a message to run the monad; each step appears as a child room.`;
    } catch (error) {
      return `Setup activation failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return "Usage: /setup list | activate <id> [room] | status | off";
}

/** /clear: wipe transcript, reset cursors + legacy details, drop every
 * harness session for this room. Role assignments are configuration — kept. */
export async function runClearCommand(context: RoomMaintenanceContext): Promise<string> {
  for (const runtime of Object.values(context.runtimes)) runtime.resetRoom(context.roomId);
  // One composite call: wiping the transcript and resetting the cursors that
  // index it must not be observable half-done by another process.
  await context.room.clearRoom();
  context.clearRecentTasks();
  await context.emitSnapshot();
  return "Cleared room history and reset all agent sessions.";
}

export function runRefreshCommand(context: RoomMaintenanceContext): string {
  for (const runtime of Object.values(context.runtimes)) runtime.refreshContext?.(context.roomId);
  return "context refreshed — fresh soul/AGENTS.md/skills apply from each agent's next turn";
}

/** /fork: branch into a sibling room. Transcript copies verbatim; cursors
 * RESET so the branch's first turn replays the whole transcript — the one
 * context-rebuild mechanism that works for every harness (sessions cannot
 * be branched). */
export async function runForkCommand(context: RoomMaintenanceContext): Promise<string> {
  const target = nextForkId(context.workspace, context.roomId);
  const dstDir = workspacePaths.roomDir(context.workspace.rootDir, target);
  // Reserve the target directory exclusively before touching it: a stale
  // nextForkId observation must abort, never seed over another fork.
  try {
    await mkdir(dstDir);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      return `Fork aborted: room '${target}' was reserved concurrently — nothing was copied.`;
    }
    throw error;
  }
  // Source transcript + state share one lock snapshot; release it before
  // opening the reserved target, so reciprocal forks never dual-lock.
  const snapshot = await context.room.snapshotRoom();
  const branch = await RoomHandle.open(context.workspace.rootDir, target);
  // Exclusive create: false means a room already owns that id, so the
  // snapshot was NOT written. Never report a fork that did not happen.
  if (!(await branch.seedTranscript(snapshot.transcript))) {
    return `Fork aborted: room '${target}' already has a transcript — nothing was copied.`;
  }
  await branch.updateState((next) => {
    next.activeRoles = { ...snapshot.state.activeRoles };
    next.thinkingOverrides = { ...snapshot.state.thinkingOverrides };
  });
  await context.emitSnapshot();
  return `Forked this room to '${target}'. Select it from the rooms list to continue the branch.`;
}

export function nextForkId(workspace: Workspace, base: string): string {
  const exists = (id: string): boolean => existsSync(workspacePaths.roomDir(workspace.rootDir, id));
  let candidate = `${base}-fork`;
  let n = 2;
  while (exists(candidate)) candidate = `${base}-fork-${n++}`;
  return candidate;
}

/** One committed transcript event by id. `display: true` (read-aloud and
 * similar "what would a human see/hear" lookups) returns it through the
 * same command-plugin render cap every other display surface uses
 * (#getSnapshot, #eventsBefore, #commitReply's live emit) — default false
 * keeps the FULL stored text, for internal introspection (e.g.
 * toolResultSlice, which needs the real content regardless of any
 * plugin-imposed cap). */
export async function eventById(
  context: RoomMaintenanceContext,
  eventId: string,
  opts: { display?: boolean } = {},
): Promise<RoomEvent | undefined> {
  await context.init();
  const { events } = await context.room.eventsFrom(0);
  const event = events.find((candidate) => candidate.id === eventId);
  if (!event) return undefined;
  return opts.display ? context.displayEvents([event])[0] : event;
}
