import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { AgentEvent, RoomEvent } from "../../core/types.js";
import { workspacePaths } from "../../core/paths.js";
import { RoomHandle } from "../../domain/rooms.js";
import { activateSetup, deactivateMonad, discoverSetups } from "../setups.js";
import type { RoomMaintenancePort } from "./ports.js";

/** Room setup, history maintenance, transcript inspection, and background-task controls. */
export class RoomMaintenanceMixin {
  async runSetupCommand(command: { sub?: string; id?: string; room?: string }): Promise<string> {
    const sub = command.sub ?? "list";

    if (sub === "list") {
      const setups = await discoverSetups(this.workspace.rootDir);
      if (setups.length === 0) return "No setups found. Bundled setups live under setups/, global under ~/.gaia/setups/, project under .gaia/setups/.";
      return [
        "Available setups:",
        ...setups.map((s) => `  - ${s.id}${s.displayName && s.displayName !== s.id ? ` — ${s.displayName}` : ""} [${s.source}]${s.description ? `\n      ${s.description}` : ""}`),
      ].join("\n");
    }

    if (sub === "status") {
      const monad = (await this.room.state()).monad;
      if (!monad) return "This room is not a monad room. Activate a setup with /setup activate <id>.";
      const pool = monad.slots.map((slot) => `${slot.agentId}${slot.defaultRole ? `(${slot.defaultRole})` : ""}`).join(" · ");
      return `Monad active — policy: ${monad.policy}, maxTurns: ${monad.maxTurns}, coordinator: @${monad.coordinatorAgentId ?? monad.slots[0]?.agentId}\nPool: ${pool}`;
    }

    if (sub === "off") {
      const cleared = await deactivateMonad(this.workspace, this.roomId);
      this.room.invalidate();
      await this.emitSnapshot();
      return cleared ? "Cleared the monad from this room. Plain messages now go to the default agent." : "This room had no active monad.";
    }

    if (sub === "activate") {
      if (!command.id) return "Usage: /setup activate <id> [room]";
      if (!this.options.summonHost) return "Setups need the summon system, which is unavailable here.";
      const targetRoom = command.room ?? this.roomId;
      try {
        const result = await activateSetup(this.workspace, command.id, targetRoom);
        if (targetRoom === this.roomId) {
          this.room.invalidate();
          await this.emitSnapshot();
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
  async runClearCommand(): Promise<string> {
    for (const runtime of Object.values(this.runtimes)) runtime.resetRoom(this.roomId);
    // One composite call: wiping the transcript and resetting the cursors that
    // index it must not be observable half-done by another process.
    await this.room.clearRoom();
    this.recentTasks = [];
    await this.emitSnapshot();
    return "Cleared room history and reset all agent sessions.";
  }

  async runRefreshCommand(): Promise<string> {
    for (const runtime of Object.values(this.runtimes)) runtime.refreshContext?.(this.roomId);
    return "context refreshed — fresh soul/AGENTS.md/skills apply from each agent's next turn";
  }

  /** /fork: branch into a sibling room. Transcript copies verbatim; cursors
   * RESET so the branch's first turn replays the whole transcript — the one
   * context-rebuild mechanism that works for every harness (sessions cannot
   * be branched). */
  async runForkCommand(): Promise<string> {
    const target = this.nextForkId(this.roomId);
    const dstDir = workspacePaths.roomDir(this.workspace.rootDir, target);
    // Reserve the target directory exclusively before touching it: a stale
    // nextForkId observation must abort, never seed over another fork.
    try {
      await mkdir(dstDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return `Fork aborted: room '${target}' was reserved concurrently — nothing was copied.`;
      throw error;
    }
    // Source transcript + state share one lock snapshot; release it before
    // opening the reserved target, so reciprocal forks never dual-lock.
    const snapshot = await this.room.snapshotRoom();
    const branch = await RoomHandle.open(this.workspace.rootDir, target);
    // Exclusive create: false means a room already owns that id, so the
    // snapshot was NOT written. Never report a fork that did not happen.
    if (!(await branch.seedTranscript(snapshot.transcript)))
      return `Fork aborted: room '${target}' already has a transcript — nothing was copied.`;
    await branch.updateState((next) => {
      next.activeRoles = { ...snapshot.state.activeRoles };
      next.thinkingOverrides = { ...snapshot.state.thinkingOverrides };
    });
    await this.emitSnapshot();
    return `Forked this room to '${target}'. Select it from the rooms list to continue the branch.`;
  }

  private nextForkId(base: string): string {
    const exists = (id: string): boolean => existsSync(workspacePaths.roomDir(this.workspace.rootDir, id));
    let candidate = `${base}-fork`;
    let n = 2;
    while (exists(candidate)) candidate = `${base}-fork-${n++}`;
    return candidate;
  }

  // --- snapshot ---------------------------------------------------------------

  /** One committed transcript event by id. `display: true` (read-aloud and
   * similar "what would a human see/hear" lookups) returns it through the
   * same command-plugin render cap every other display surface uses
   * (#getSnapshot, #eventsBefore, #commitReply's live emit) — default false
   * keeps the FULL stored text, for internal introspection (e.g.
   * toolResultSlice below, which needs the real content regardless of any
   * plugin-imposed cap). */
  async eventById(eventId: string, opts: { display?: boolean } = {}): Promise<RoomEvent | undefined> {
    await this.init();
    const { events } = await this.room.eventsFrom(0);
    const event = events.find((event) => event.id === eventId);
    if (!event) return undefined;
    return opts.display ? this.displayEvents([event])[0] : event;
  }

  /** Pages the ORIGINAL, uncollapsed call/args/result for a diet-collapsed own
   * tool-call stub back by (eventId, toolId) — backs `tool_result_fetch`
   * (09-MEMORY-CONTEXT). The canonical RoomEvent.details.tools entry is the
   * single durable source; nothing there is ever collapsed — only the
   * render-time renderRoomTranscript projection ever shows a stub, so this
   * always finds the full original. */
  async toolResultSlice(
    callerId: string,
    eventId: string,
    toolId: string,
    offset: number,
    limit: number,
  ): Promise<{ text: string; totalLength: number; hasMore: boolean } | undefined> {
    const event = await this.eventById(eventId);
    if (!event || "targets" in event || event.author !== callerId) return undefined; // only own agent activity is pageable
    const tool = event.details?.tools?.find((candidate) => candidate.id === toolId);
    if (!tool) return undefined;
    const full = JSON.stringify({ call: tool.toolName, args: tool.args, result: tool.result }, null, 2);
    const text = full.slice(offset, offset + limit);
    return { text, totalLength: full.length, hasMore: offset + text.length < full.length };
  }

  async recordBackgroundTask(agentId: string, event: Extract<AgentEvent, { type: "background-task" }>): Promise<void> {
    await this.backgroundTasks.record(agentId, event);
  }
  async backgroundTaskOutput(taskId: string): Promise<{ text: string; running: boolean } | undefined> {
    await this.init();
    return this.backgroundTasks.output(taskId);
  }
  async stopBackgroundTask(taskId: string): Promise<boolean> {
    await this.init();
    return this.backgroundTasks.stop(taskId);
  }
}

export interface RoomMaintenanceMixin extends RoomMaintenancePort {}
export function installRoomMaintenance(target: object): void {
  for (const name of Object.getOwnPropertyNames(RoomMaintenanceMixin.prototype)) {
    if (name === "constructor") continue;
    Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(RoomMaintenanceMixin.prototype, name)!);
  }
}
