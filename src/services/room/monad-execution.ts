import type { RoomEvent, Task } from "../../core/types.js";
import { newRoomEventId } from "../../domain/rooms.js";
import { resolveAgentRole } from "../../domain/roles.js";
import { MonadEngine } from "../monad.js";
import type { SendMessageOptions } from "../room-service.js";
import type { RoomMonadExecutionPort } from "./ports.js";

/** Monad-room turn execution: a monad run is a turn like any other, so it
 * shares the WAL shape of runAgentTask (see ./queue.ts) — reserve the final
 * answer's event id and persist a monad-flagged pendingTurn BEFORE the engine
 * runs, then commit through the SAME atomic write (append + cursor advance)
 * on success. Split from room-service.ts (Pascal 2026-09-03 A6g); the
 * markPendingTurn → engine.run → commitTurn sequence stays whole in this one
 * method — do not split the atomic write across files. */
export class RoomMonadExecutionMixin {
  async runMonadTask(task: Task, text: string, options: SendMessageOptions): Promise<void> {
    try {
      const state = await this.room.state();
      const monad = state.monad;
      const summonHost = this.options.summonHost;
      if (!monad || !summonHost) {
        this.settleTask(task, "error", new Error("This room is not a monad room."));
        return;
      }

      if (options.recordUserMessage !== false) {
        const userEvent = await this.room.addUserMessage(text, task.targets);
        this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event: userEvent });
      }

      // WAL: a monad run is a turn like any other — reserve the final answer's
      // event id and persist a monad-flagged marker BEFORE the engine runs, so
      // a daemon crash mid-monad leaves a resumable record (boot re-dispatches
      // through the engine; step results already live in child rooms) instead
      // of a recorded user message that is silently never answered. The same
      // atomic write consumes the drained queue entry, as in runAgentTask.
      const [author] = await this.monadAuthor();
      const eventId = newRoomEventId();
      await this.room.markPendingTurn(
        {
          id: task.id,
          eventId,
          prompt: text,
          targets: task.targets.length > 0 ? task.targets : [author],
          agentId: author,
          partialReply: "",
          startedAt: new Date().toISOString(),
          monad: true,
        },
        options.queued ? { consumeQueuedTaskId: options.queued.taskId } : undefined,
      );

      const engine = new MonadEngine({
        config: monad,
        parentRoomId: this.roomId,
        dispatch: (agentId, stepTask) => summonHost.summonAndWait(this.roomId, agentId, stepTask),
        resolveRolePrompt: async (agentId, role) => {
          const agent = this.workspace.agents[agentId];
          if (!agent) return "";
          const resolved = await resolveAgentRole(agent, role);
          return resolved?.prompt ?? "";
        },
      });

      const result = await engine.run(text, { isCancelled: () => this.taskCancelled(task) });
      if (this.taskCancelled(task)) {
        await this.room.clearPendingTurn();
        return;
      }

      const final = result.final.trim();
      if (final) {
        // Commit through the WAL like every turn: append under the reserved id
        // and retire the marker + advance the author's cursor in one write.
        const event: RoomEvent = { id: eventId, timestamp: new Date().toISOString(), author, text: final };
        await this.room.commitTurn(event);
        this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
      } else {
        await this.room.clearPendingTurn();
      }
      this.settleTask(task, "complete");
    } catch (error) {
      // Cancelled or terminally failed: retire the marker either way — never
      // replay a poison monad run on boot.
      await this.room.clearPendingTurn().catch(() => {});
      if (this.taskCancelled(task)) return;
      this.settleTask(task, "error", error);
    }
  }
}
export interface RoomMonadExecutionMixin extends RoomMonadExecutionPort {}
export function installRoomMonadExecution(target: object): void {
  for (const name of Object.getOwnPropertyNames(RoomMonadExecutionMixin.prototype)) {
    if (name === "constructor") continue;
    Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(RoomMonadExecutionMixin.prototype, name)!);
  }
}
