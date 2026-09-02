import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import type { AgentEvent, BackgroundTask } from "../../core/types.js";
import type { RoomHandle } from "../../domain/rooms.js";

const BACKGROUND_TASK_MAX = 20;
const BACKGROUND_TASK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BACKGROUND_TASK_OUTPUT_BYTES = 16 * 1024;
/** `lsof` binary used to probe whether a tracked background process still has
 * a live writer on its output file (see pids). Env-overridable — never
 * hardcode a bare path as the only option. */
const LSOF_BIN = process.env.GAIA_LSOF_BIN || "/usr/sbin/lsof";
/** How long pids waits for `lsof` before giving up and reporting no live
 * writers (a hung/missing lsof must never wedge a snapshot). */
const BACKGROUND_TASK_LSOF_TIMEOUT_MS = 2000;

export interface BackgroundTasksOptions {
  room: RoomHandle;
  roomId: string;
  emitSnapshot(): Promise<void>;
}

/** Durable background-task tray lifecycle: record, inspect output, stop. */
export class BackgroundTasks {
  constructor(private readonly options: BackgroundTasksOptions) {}

  async record(agentId: string, event: Extract<AgentEvent, { type: "background-task" }>): Promise<void> {
    const now = Date.now();
    const startedAt = new Date(now).toISOString();
    const cutoff = now - BACKGROUND_TASK_MAX_AGE_MS;
    await this.options.room.updateState((state) => {
      const recent = (state.backgroundTasks ?? []).filter(
        (task) => Date.parse(task.startedAt) >= cutoff && task.taskId !== event.taskId,
      );
      recent.push({
        taskId: event.taskId,
        toolName: event.toolName,
        ...(event.command !== undefined ? { command: event.command } : {}),
        ...(event.description !== undefined ? { description: event.description } : {}),
        ...(event.outputPath !== undefined ? { outputPath: event.outputPath } : {}),
        startedAt,
        agentId,
        roomId: this.options.roomId,
      });
      state.backgroundTasks = recent.slice(-BACKGROUND_TASK_MAX);
    });
    await this.options.emitSnapshot();
  }

  private async pids(task: BackgroundTask): Promise<number[]> {
    const outputPath = task.outputPath;
    if (!outputPath) return [];
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(LSOF_BIN, ["-t", outputPath], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          reject(new Error("lsof timed out"));
        }, BACKGROUND_TASK_LSOF_TIMEOUT_MS);
        child.stdout?.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
        });
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(out);
        });
      });
      return stdout
        .split(/\s+/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  /** The tail of a tracked background process's output plus its live-writer state. */
  async output(taskId: string): Promise<{ text: string; running: boolean } | undefined> {
    const task = (await this.options.room.state()).backgroundTasks?.find((candidate) => candidate.taskId === taskId);
    if (!task?.outputPath) return undefined;
    const running = (await this.pids(task)).length > 0;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(task.outputPath, "r");
      const { size } = await file.stat();
      const length = Math.min(size, BACKGROUND_TASK_OUTPUT_BYTES);
      if (length === 0) return { text: "", running };
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, Math.max(0, size - length));
      return { text: buffer.subarray(0, bytesRead).toString("utf8"), running };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    } finally {
      await file?.close();
    }
  }

  /** Stop live writers and remove the durable tray entry. */
  async stop(taskId: string): Promise<boolean> {
    const task = (await this.options.room.state()).backgroundTasks?.find((candidate) => candidate.taskId === taskId);
    if (!task) return false;
    for (const pid of await this.pids(task)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await this.options.room.updateState((state) => {
      state.backgroundTasks = (state.backgroundTasks ?? []).filter((candidate) => candidate.taskId !== taskId);
    });
    await this.options.emitSnapshot();
    return true;
  }
}
