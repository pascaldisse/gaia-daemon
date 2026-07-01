// The scheduler: GAIA-owned proactive runs (the one capability no wrapped
// harness provides — REPLACEMENT.md gap #2, Hermes's local-cron design mapped
// onto rooms). One 60s tick across every initialized workspace; schedules.json
// is re-read each tick, so edits apply with no reload. A due job runs as a
// perfectly ordinary turn — isolated (a summon child room, result delivered to
// the target room) or in-room (a normal message) — under the existing
// sandbox/trust machinery. No approval gating: the sandbox IS the boundary.
//
// Durability: lastRunAt is stamped BEFORE dispatch (at-most-once), the run
// room id right after (crash-recovery mark). A run interrupted by a daemon
// crash resumes through the room WAL protocol when recovery reopens its room,
// and whatever reply exists is still delivered — no progress lost.

import type { Task, UiEvent, Workspace } from "../core/types.js";
import { workspacePaths } from "../core/paths.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import {
  isDue,
  nextRunAt,
  parseSchedule,
  parseScheduleFile,
  parseScheduleState,
  type ScheduleJob,
  type ScheduleRunRecord,
  type ScheduleState,
} from "../domain/schedules.js";
import { SUMMON_TIMEOUT_MS } from "./summons.js";

const TICK_MS = 60_000;
/** Chained/last output kept in state, capped like episode fields. */
const OUTPUT_CAP = 4_000;

/** The slice of RoomService a scheduled run needs (tests fake this). */
export interface ScheduleRoomAccess {
  readonly roomId: string;
  readonly workspace: Workspace;
  sendMessage(text: string, options: { targets: string[] }): Promise<Task>;
  waitForIdle(timeoutMs?: number): Promise<void>;
  latestReplyFrom(agentId: string): Promise<string>;
  postAgentNote(agentId: string, text: string): Promise<void>;
  subscribe(listener: (event: UiEvent) => void): () => void;
}

/** The slice of SummonCoordinator a scheduled isolated run needs. */
export interface ScheduleSummonAccess {
  launch(parentRoomId: string, agentId: string, task: string): Promise<{ roomId: string; done: Promise<string> }>;
}

export interface SchedulerOptions {
  /** Initialized workspaces to tick over (the daemon's registry). */
  listWorkspaces(): Promise<Array<{ id: string; path: string }>>;
  serviceFor(workspaceId: string, roomId?: string): Promise<ScheduleRoomAccess>;
  summonHost(workspaceId: string): Promise<ScheduleSummonAccess>;
  log?: (message: string) => void;
  now?: () => Date;
  tickMs?: number;
}

export class SchedulerService {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  /** "workspaceId::jobId" of runs in flight (concurrency + re-dispatch guard). */
  private readonly running = new Set<string>();
  /** Workspaces whose crashed-run recovery sweep already happened. */
  private readonly recovered = new Set<string>();
  /** Serializes state-file read-modify-writes per workspace. */
  private readonly stateLocks = new Map<string, Promise<void>>();

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    const tickMs = this.options.tickMs ?? TICK_MS;
    this.timer = setInterval(() => void this.tick().catch((error) => this.log(`scheduler tick failed: ${String(error)}`)), tickMs);
    this.timer.unref?.();
    void this.tick().catch((error) => this.log(`scheduler tick failed: ${String(error)}`));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  // --- the tick -----------------------------------------------------------------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const workspace of await this.options.listWorkspaces()) {
        try {
          await this.tickWorkspace(workspace.id, workspace.path);
        } catch (error) {
          this.log(`scheduler: workspace ${workspace.path} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickWorkspace(workspaceId: string, path: string): Promise<void> {
    const file = parseScheduleFile(await readJson(workspacePaths.schedules(path)));
    if (!this.recovered.has(workspaceId)) {
      this.recovered.add(workspaceId);
      void this.recoverInterrupted(workspaceId, path).catch((error) => this.log(`scheduler recovery failed: ${String(error)}`));
    }
    if (!file.enabled || file.jobs.length === 0) return;

    const now = this.now();
    const jobIds = new Set(file.jobs.map((job) => job.id));
    let state = parseScheduleState(await readJson(workspacePaths.scheduleState(path)));

    // Seed fresh jobs (they fire at their NEXT instant, never at boot) and
    // prune state for jobs removed from the file.
    const stale = Object.keys(state).filter((id) => !jobIds.has(id) && !this.running.has(`${workspaceId}::${id}`));
    const fresh = file.jobs.filter((job) => !state[job.id]);
    if (stale.length > 0 || fresh.length > 0) {
      await this.updateState(path, (current) => {
        for (const id of stale) delete current[id];
        for (const job of fresh) current[job.id] ??= { lastRunAt: now.toISOString() };
      });
      state = parseScheduleState(await readJson(workspacePaths.scheduleState(path)));
    }

    for (const job of file.jobs) {
      if (!job.enabled || this.running.has(`${workspaceId}::${job.id}`)) continue;
      const parsed = parseSchedule(job.schedule);
      const record = state[job.id];
      if (!parsed || !record || record.status === "running") continue;
      if (!isDue(parsed, record.lastRunAt, now)) continue;
      void this.dispatch(workspaceId, path, job, record).catch((error) => this.log(`scheduled job ${job.id} failed: ${String(error)}`));
    }
  }

  // --- one run --------------------------------------------------------------------

  private async dispatch(workspaceId: string, path: string, job: ScheduleJob, previous: ScheduleRunRecord): Promise<void> {
    const key = `${workspaceId}::${job.id}`;
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      // At-most-once mark, durable before anything runs.
      await this.updateState(path, (state) => {
        state[job.id] = { lastRunAt: this.now().toISOString(), status: "running" };
      });

      const room = await this.options.serviceFor(workspaceId, job.room);
      const agentId = job.agent ?? room.workspace.config.defaultAgent;
      if (!room.workspace.agents[agentId]) throw new Error(`unknown agent: @${agentId}`);
      const prompt = this.buildPrompt(job, previous);

      let runRoomId: string;
      let done: Promise<string>;
      if (job.isolated) {
        const host = await this.options.summonHost(workspaceId);
        ({ roomId: runRoomId, done } = await host.launch(room.roomId, agentId, prompt));
      } else {
        runRoomId = room.roomId;
        const task = await room.sendMessage(prompt, { targets: [agentId] });
        done = awaitTask(room, task, SUMMON_TIMEOUT_MS).then(() => room.latestReplyFrom(agentId));
      }
      // Crash-recovery mark: where the run lives, where the result goes.
      await this.updateState(path, (state) => {
        const record = state[job.id] ?? { lastRunAt: this.now().toISOString() };
        state[job.id] = { ...record, status: "running", runRoomId, deliverRoomId: room.roomId, agentId };
      });

      const reply = (await done).trim();
      if (job.isolated && reply) await room.postAgentNote(agentId, `⏰ \`${job.id}\`\n\n${reply}`);

      await this.updateState(path, (state) => {
        const { lastError: _lastError, ...record } = state[job.id] ?? { lastRunAt: this.now().toISOString() };
        state[job.id] = {
          ...record,
          status: "complete",
          lastEndedAt: this.now().toISOString(),
          lastOutput: reply.slice(0, OUTPUT_CAP),
        };
      });
      this.log(`scheduled job ${job.id} completed (@${agentId} in ${runRoomId})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.updateState(path, (state) => {
        const record = state[job.id] ?? { lastRunAt: this.now().toISOString() };
        state[job.id] = { ...record, status: "error", lastEndedAt: this.now().toISOString(), lastError: message };
      }).catch(() => {});
      this.log(`scheduled job ${job.id} failed: ${message}`);
    } finally {
      this.running.delete(key);
    }
  }

  private buildPrompt(job: ScheduleJob, previous: ScheduleRunRecord): string {
    const parts = [
      `⏰ Scheduled task \`${job.id}\` (schedule: ${job.schedule}). This is an automated run — no user is present. Complete the task and reply with the result.`,
      job.prompt,
    ];
    if (job.chainOutput && previous.lastOutput?.trim()) {
      parts.push(`## Output of the previous run (${previous.lastEndedAt ?? previous.lastRunAt})\n\n${previous.lastOutput}`);
    }
    return parts.join("\n\n");
  }

  /** Force-run a job now (/schedule run <id>). Fire-and-forget: the turn
   * streams in its room; state records the outcome. */
  async runNow(workspaceId: string, path: string, jobId: string): Promise<string> {
    const file = parseScheduleFile(await readJson(workspacePaths.schedules(path)));
    const job = file.jobs.find((candidate) => candidate.id === jobId);
    if (!job) return `Unknown scheduled job: ${jobId}. Edit .gaia/schedules.json to add it, or /schedule to list.`;
    if (this.running.has(`${workspaceId}::${jobId}`)) return `Job '${jobId}' is already running.`;
    const state = parseScheduleState(await readJson(workspacePaths.scheduleState(path)));
    void this.dispatch(workspaceId, path, job, state[jobId] ?? { lastRunAt: this.now().toISOString() }).catch(() => {});
    return `Started scheduled job '${jobId}' (@${job.agent ?? "default agent"}${job.isolated ? ", isolated run" : `, in room '${job.room ?? "current"}'`}).`;
  }

  /** Human-readable job list for /schedule. */
  async describeWorkspace(workspaceId: string, path: string): Promise<string> {
    const file = parseScheduleFile(await readJson(workspacePaths.schedules(path)));
    if (file.jobs.length === 0) {
      return "No scheduled jobs. Add them to .gaia/schedules.json (settings → schedules.json), e.g.\n" +
        `  { "id": "daily-digest", "schedule": "0 9 * * *", "prompt": "Summarize yesterday's work.", "agent": "gaia" }`;
    }
    const state = parseScheduleState(await readJson(workspacePaths.scheduleState(path)));
    const lines = file.jobs.map((job) => {
      const record = state[job.id];
      const parsed = parseSchedule(job.schedule);
      const running = this.running.has(`${workspaceId}::${job.id}`) || record?.status === "running";
      const next = !file.enabled || !job.enabled ? undefined : parsed && record ? nextRunAt(parsed, record.lastRunAt) : undefined;
      const status = running
        ? "running now"
        : record?.status
          ? `last: ${record.status}${record.lastEndedAt ? ` at ${record.lastEndedAt}` : ""}`
          : "never ran";
      const bullet = job.enabled && file.enabled ? "●" : "○";
      const target = `@${job.agent ?? "default"} → ${job.isolated ? `isolated, delivers to '${job.room ?? "current room"}'` : `room '${job.room ?? "current"}'`}`;
      return `  ${bullet} ${job.id} — ${job.schedule} — ${target}\n      ${status}${next ? ` · next: ${next.toISOString()}` : ""}${job.enabled ? "" : " · disabled"}`;
    });
    const head = file.enabled ? `Scheduled jobs (${file.jobs.length}):` : `Scheduled jobs (${file.jobs.length}) — scheduler is OFF for this workspace:`;
    return [head, ...lines, "", "Run one now with /schedule run <id>. Edit .gaia/schedules.json to change jobs."].join("\n");
  }

  // --- crash recovery ----------------------------------------------------------------

  /** Runs marked "running" by a prior process: reopen the run room (the WAL
   * protocol resumes any interrupted turn), wait, and deliver what exists. */
  private async recoverInterrupted(workspaceId: string, path: string): Promise<void> {
    const state = parseScheduleState(await readJson(workspacePaths.scheduleState(path)));
    for (const [jobId, record] of Object.entries(state)) {
      if (record.status !== "running" || this.running.has(`${workspaceId}::${jobId}`)) continue;
      const key = `${workspaceId}::${jobId}`;
      this.running.add(key);
      try {
        if (!record.runRoomId || !record.agentId) {
          await this.markInterrupted(path, jobId, "daemon restarted before the run was dispatched");
          continue;
        }
        this.log(`scheduler: recovering interrupted job ${jobId} (room ${record.runRoomId})`);
        // Opening the room resumes its pendingTurn; idle means it settled.
        const runRoom = await this.options.serviceFor(workspaceId, record.runRoomId);
        await runRoom.waitForIdle(SUMMON_TIMEOUT_MS);
        const reply = (await runRoom.latestReplyFrom(record.agentId)).trim();
        const isolated = Boolean(record.deliverRoomId && record.deliverRoomId !== record.runRoomId);
        if (isolated && reply && record.deliverRoomId) {
          const deliverRoom = await this.options.serviceFor(workspaceId, record.deliverRoomId);
          await deliverRoom.postAgentNote(record.agentId, `⏰ \`${jobId}\` (recovered after restart)\n\n${reply}`);
        }
        await this.updateState(path, (current) => {
          const entry = current[jobId] ?? { lastRunAt: this.now().toISOString() };
          current[jobId] = {
            ...entry,
            status: reply ? "complete" : "interrupted",
            lastEndedAt: this.now().toISOString(),
            ...(reply ? { lastOutput: reply.slice(0, OUTPUT_CAP) } : { lastError: "interrupted by restart; no reply found" }),
          };
        });
      } catch (error) {
        await this.markInterrupted(path, jobId, error instanceof Error ? error.message : String(error)).catch(() => {});
      } finally {
        this.running.delete(key);
      }
    }
  }

  private markInterrupted(path: string, jobId: string, reason: string): Promise<void> {
    return this.updateState(path, (state) => {
      const record = state[jobId] ?? { lastRunAt: this.now().toISOString() };
      state[jobId] = { ...record, status: "interrupted", lastEndedAt: this.now().toISOString(), lastError: reason };
    });
  }

  // --- state file (serialized read-modify-write per workspace) ------------------------

  private updateState(path: string, mutate: (state: ScheduleState) => void): Promise<void> {
    const statePath = workspacePaths.scheduleState(path);
    const run = async (): Promise<void> => {
      const state = parseScheduleState(await readJson(statePath));
      mutate(state);
      await writeJsonAtomic(statePath, state);
    };
    const previous = this.stateLocks.get(path) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.stateLocks.set(path, next.then(
      () => {},
      () => {},
    ));
    return next;
  }
}

/** Resolve when `task` settles (its object is live-mutated by the service) or
 * after timeoutMs — a run past the cap keeps going in its room, like summons. */
function awaitTask(room: ScheduleRoomAccess, task: Task, timeoutMs: number): Promise<void> {
  const settled = (): boolean => task.status !== "running" && task.status !== "queued";
  if (settled()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    const unsubscribe = room.subscribe((event) => {
      if ((event.type === "task-end" || event.type === "task-error") && event.task.id === task.id) finish();
    });
    // Settled in the window before subscribing? The live object tells us.
    if (settled()) finish();
  });
}
