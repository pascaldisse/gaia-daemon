import type { Task } from "../../core/types.js";
import { DEFAULT_PET_NAME, listWorkspacePetBindings, loadPet } from "../../domain/pets.js";
import { hasExplicitMention } from "../commands.js";
import type { SendMessageOptions } from "../room-service.js";
import type { RoomTaskOperationsPort } from "./ports.js";


/** Non-WAL task controls: pets, agent-dialogue policy, cancellation, queue chips,
 * idle observation, and monad eligibility. Queue/WAL ownership stays in RoomService. */
export class RoomTaskOperationsMixin {
  async runPetCommand(command: { action: "list" | "off" | "set"; agent?: string; package?: string }): Promise<string> {
    if (command.action === "list") {
      const bindings = (await this.room.state()).petBindings ?? {};
      const rows = Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b));
      return rows.length > 0
        ? `Pet bindings in this room:\n${rows.map(([agentId, packageName]) => `  @${agentId} → ${packageName}`).join("\n")}`
        : "No pet bindings in this room. Pets are off by default.";
    }

    const target = command.agent ?? (await this.roomDefaultTarget());
    if (!this.workspace.agents[target]) return this.unknownAgentMessage(target);
    if (command.action === "off") {
      let removed = false;
      await this.room.updateState((state) => {
        if (!state.petBindings?.[target]) return;
        removed = true;
        delete state.petBindings[target];
        if (Object.keys(state.petBindings).length === 0) delete state.petBindings;
      });
      await this.emitPetBindings();
      return removed ? `Pet removed for @${target}.` : `No pet is bound to @${target} in this room.`;
    }

    const packageName = command.package?.trim() || DEFAULT_PET_NAME;
    try {
      await (this.options.petLoader ?? loadPet)(packageName);
    } catch (error) {
      return `Invalid pet package '${packageName}': ${error instanceof Error ? error.message : String(error)}`;
    }
    await this.room.updateState((state) => {
      state.petBindings = { ...(state.petBindings ?? {}), [target]: packageName };
    });
    await this.emitPetBindings();
    return `Pet '${packageName}' bound to @${target} in this room. The transparent always-on-top pet window is available in the desktop app only.`;
  }

  async emitPetBindings(): Promise<void> {
    this.emit({
      type: "pet-bindings",
      workspaceId: this.workspaceId,
      bindings: await listWorkspacePetBindings(this.workspaceId, this.workspace.rootDir),
    });
    await this.emitSnapshot();
  }

  async setAgentDialogue(on: boolean): Promise<void> {
    await this.init();
    await this.room.updateState((state) => {
      if (on) state.agentDialogue = true;
      else delete state.agentDialogue;
    });
    this.agentDialogueHops = 0;
    await this.emitSnapshot();
  }

  async cancelActiveTask(): Promise<Task | undefined> {
    await this.init();
    const task = this.activeTask;
    if (!task) return undefined;
    task.status = "cancelled";
    for (const target of this.compactingAgents) this.compactCancels.add(target);
    const targets = new Set([...task.targets, ...this.compactingAgents]);
    await Promise.allSettled([...targets].map((target) => this.runtimes[target]?.abort()).filter(Boolean));
    const unwind = this.activeTurnUnwind;
    if (unwind) await Promise.race([unwind, new Promise((resolve) => setTimeout(resolve, 10_000).unref?.())]);
    if (this.activeTask?.id === task.id) this.settleTask(task, "cancelled");
    return task;
  }

  async clearQueued(): Promise<void> {
    await this.room.clearQueue();
    const dropped = this.queuedTasks;
    this.queuedTasks = [];
    for (const task of dropped) {
      task.status = "cancelled";
      task.endedAt = new Date().toISOString();
      this.recentTasks = [...this.recentTasks.slice(-9), task];
      this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.roomId, task });
    }
  }

  async deleteQueuedMessage(taskId: string): Promise<Task | undefined> {
    await this.init();
    const task = this.queuedTasks.find((candidate) => candidate.id === taskId);
    if (!task) return undefined;
    await this.room.spliceQueued(taskId);
    this.queuedTasks = this.queuedTasks.filter((candidate) => candidate.id !== taskId);
    task.status = "cancelled";
    task.endedAt = new Date().toISOString();
    this.recentTasks = [...this.recentTasks.slice(-9), task];
    this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.roomId, task });
    return task;
  }

  async waitForIdle(timeoutMs?: number): Promise<void> {
    await this.init();
    if (!this.activeTask) return;
    await new Promise<void>((resolveIdle, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        unsubscribe();
        reject(new Error("Room is busy with another task"));
      }, timeoutMs);
      const unsubscribe = this.subscribe((event) => {
        if (event.type !== "task-end" && event.type !== "task-error") return;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolveIdle();
      });
    });
  }

  async isMonadMessage(text: string, options: SendMessageOptions): Promise<boolean> {
    const state = await this.room.state();
    if (!state.monad || !this.options.summonHost) return false;
    if (options.targets) return false;
    return !hasExplicitMention(text, new Set(Object.keys(this.workspace.agents)));
  }

  async monadAuthor(): Promise<string[]> {
    const state = await this.room.state();
    const monad = state.monad;
    return [monad?.coordinatorAgentId ?? monad?.slots[0]?.agentId ?? this.workspace.config.defaultAgent];
  }
}

export interface RoomTaskOperationsMixin extends RoomTaskOperationsPort {}

export function installRoomTaskOperations(target: object): void {
  for (const name of Object.getOwnPropertyNames(RoomTaskOperationsMixin.prototype)) {
    if (name === "constructor") continue;
    Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(RoomTaskOperationsMixin.prototype, name)!);
  }
}
