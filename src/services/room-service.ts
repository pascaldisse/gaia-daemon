// RoomService — one per (workspace, room). The v1 GaiaController's eleven jobs,
// redistributed: parsing lives in commands.ts, turn streaming in turns.ts,
// summon policy in summons.ts, monad in monad.ts, durability in RoomHandle's
// WAL protocol. What remains here is orchestration: task lifecycle, the durable
// queue, and the command handler registry.
//
// Durability differences from v1 (each closes a real hole):
// - Queued messages persist in state.queue and re-drain on boot (v1 held them
//   in a private array; a crash ate them).
// - A turn's transcript event id is reserved BEFORE streaming; commit is
//   append-then-one-state-write, and resume can tell "committed but not
//   acknowledged" from "needs re-run" (v1 could double-run that window).
// - Runtime details commit onto the transcript event itself (v1 kept a
//   50-entry LRU side-table: metadata amnesia by design).

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Bus } from "../core/bus.js";
import { newId } from "../core/ids.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import { workspacePaths } from "../core/paths.js";
import type { AgentDef, AgentEvent, EventDetails, PendingTurn, RoomEvent, Snapshot, Task, UiEvent, Workspace } from "../core/types.js";
import { newRoomEventId, normalizeRoomState, RoomHandle } from "../domain/rooms.js";
import { listAgentRoles, resolveAgentRole } from "../domain/roles.js";
import type { MemoryStore, MemoryAction, MemoryMutationResult } from "../domain/memory.js";
import type { AgentRuntime, HarnessHost } from "../harness/spec.js";
import { HELP_TEXT, SLASH_COMMANDS, hasExplicitMention, parseCommand, planMentionRoute, type SlashCommand } from "./commands.js";
import { runAgentTurn } from "./turns.js";
import type { EpisodeCapture } from "./memory-service.js";
import type { ConsolidateResult } from "./consolidate.js";
import { allowSummonForTurn, isTrusted, type SummonHost } from "./summons.js";
import { MonadEngine } from "./monad.js";
import { activateSetup, deactivateMonad, discoverSetups } from "./setups.js";
import { sdkThinkingLevels } from "./hints.js";
import { createAgentRuntime } from "../harness/host.js";
import { resolveSandboxPolicy } from "../harness/sandbox/spec.js";

export interface RoomServiceOptions {
  workspaceId: string;
  workspace: Workspace;
  roomId?: string;
  /** Workspace-scoped store shared by every room service (single writer). */
  memoryStore: MemoryStore;
  runtimeFactory?: (agent: AgentDef) => AgentRuntime;
  /** Host-provided thinking setter (scopes to an active voice call first). */
  setThinking?: (agentId: string, level: string) => Promise<string>;
  harnessHost?: (options: { allowSummon: boolean }) => HarnessHost;
  summonHost?: SummonHost;
  /** Memory v3 hooks (auto-recall, episodic capture, consolidation). Absent →
   * turns run exactly as before; the hooks are additive. */
  memory?: RoomMemoryHooks;
  /** Workspace-scoped scheduler surface backing /schedule. */
  scheduler?: RoomSchedulerHooks;
}

/** What /schedule needs from the scheduler (daemon-provided, workspace-bound). */
export interface RoomSchedulerHooks {
  list(): Promise<string>;
  runNow(jobId: string): Promise<string>;
}

/** The narrow slice of MemoryService a room needs (kept as an interface so
 * tests can fake it and the room never learns about embeddings/LLMs). */
export interface RoomMemoryHooks {
  autoRecallBlock(agentId: string, query: string): Promise<string>;
  capture(agentId: string, capture: EpisodeCapture): Promise<void>;
  consolidate(agentId: string, options?: { force?: boolean }): Promise<ConsolidateResult>;
}

export interface SendMessageOptions {
  targets?: string[];
  channel?: "text" | "voice";
  /** Synthetic prompts (call greetings, silence nudges) skip the user event. */
  recordUserMessage?: boolean;
  thinking?: string;
}

/** Min gap between durable partial-reply flushes during a streaming turn. */
const PARTIAL_FLUSH_MS = 1000;

/** Command handlers, keyed by parsed type. Adding a command = one entry here
 * plus one line in SLASH_COMMANDS. Each returns the system reply text. */
type CommandHandler = (service: RoomService, command: SlashCommand) => Promise<string>;

const COMMANDS: Record<string, CommandHandler> = {
  help: async () => HELP_TEXT,
  agents: (service) => service.renderAgentsList(),
  roles: (service, command) => service.renderRoles(command.type === "roles" ? command.agent : undefined),
  role: (service, command) => (command.type === "role" ? service.setRole(command.agent, command.role) : Promise.resolve("")),
  thinking: (service, command) => (command.type === "thinking" ? service.runThinkingCommand(command.agent, command.level) : Promise.resolve("")),
  summon: (service, command) => (command.type === "summon" ? service.runSummonCommand(command.agent, command.task) : Promise.resolve("")),
  setup: (service, command) => (command.type === "setup" ? service.runSetupCommand(command) : Promise.resolve("")),
  clear: (service) => service.runClearCommand(),
  consolidate: (service, command) => (command.type === "consolidate" ? service.runConsolidateCommand(command.agent) : Promise.resolve("")),
  schedule: (service, command) => (command.type === "schedule" ? service.runScheduleCommand(command.sub, command.id) : Promise.resolve("")),
  fork: (service) => service.runForkCommand(),
  unknown: async (_service, command) => `Unknown command: /${command.type === "unknown" ? command.command : "?"}. Try /help.`,
};

export class RoomService {
  readonly room: RoomHandle;
  private readonly runtimes: Record<string, AgentRuntime>;
  private readonly bus = new Bus<UiEvent>();
  private activeTask: Task | undefined;
  private recentTasks: Task[] = [];
  /** Tasks mirroring the DURABLE queue (state.queue) for snapshot chips. */
  private queuedTasks: Task[] = [];
  private initPromise: Promise<void> | undefined;

  constructor(private readonly options: RoomServiceOptions & { room: RoomHandle }) {
    this.room = options.room;
    this.runtimes = Object.fromEntries(
      Object.values(options.workspace.agents).map((agent) => [
        agent.id,
        options.runtimeFactory
          ? options.runtimeFactory(agent)
          : createAgentRuntime({
              workspace: options.workspace,
              agent,
              memoryStore: options.memoryStore,
              harnessHost: options.harnessHost,
              // Resolved at spawn (after init), when parentRoomId is known.
              allowSummon: () => allowSummonForTurn(agent, this.isSummonRoom),
              sandbox: () =>
                resolveSandboxPolicy(options.workspace.config.sandbox, agent.sandbox, this.isSummonRoom, {
                  trusted: isTrusted(agent),
                }),
            }),
      ]),
    );
  }

  static async open(options: RoomServiceOptions): Promise<RoomService> {
    const roomId = options.roomId ?? options.workspace.config.room;
    const room = await RoomHandle.open(options.workspace.rootDir, roomId);
    return new RoomService({ ...options, room });
  }

  private isSummonRoom = false;

  get workspace(): Workspace {
    return this.options.workspace;
  }

  get workspaceId(): string {
    return this.options.workspaceId;
  }

  get roomId(): string {
    return this.room.roomId;
  }

  get hasActiveTask(): boolean {
    return Boolean(this.activeTask);
  }

  /** Busy = running a turn OR has a live background summon. Guards a service
   * from LRU eviction while its background work would be killed with it. */
  get isBusy(): boolean {
    return Boolean(this.activeTask) || Boolean(this.options.summonHost?.runningChildren(this.roomId).length);
  }

  get activeTaskId(): string | undefined {
    return this.activeTask?.id;
  }

  init(): Promise<void> {
    this.initPromise ??= this.initOnce();
    return this.initPromise;
  }

  private async initOnce(): Promise<void> {
    await Promise.all(Object.values(this.workspace.agents).map((agent) => this.options.memoryStore.init(agent.memoryDir, agent.displayName)));
    const state = await this.room.state();
    this.isSummonRoom = Boolean(state.parentRoomId);

    // Interrupted turn? Resume in the background — never blocks opening.
    if (state.pendingTurn) void this.resumePendingTurn(state.pendingTurn).catch(() => {});
    // Durable queue survivors from a prior process: rebuild their task chips
    // and drain once idle. Voice-channel synthetics are dropped — their call
    // is gone.
    const queue = state.queue ?? [];
    if (queue.length > 0) {
      const stale = queue.filter((message) => message.channel === "voice");
      if (stale.length > 0) {
        await this.room.updateState((current) => {
          current.queue = current.queue?.filter((message) => message.channel !== "voice");
          if (current.queue?.length === 0) delete current.queue;
        });
      }
      this.queuedTasks = queue
        .filter((message) => message.channel !== "voice")
        .map((message) => ({
          id: message.taskId,
          roomId: this.roomId,
          text: message.text,
          targets: message.targets,
          status: "queued" as const,
          startedAt: message.queuedAt,
        }));
      if (!this.activeTask) void this.drain();
    }
  }

  subscribe(listener: (event: UiEvent) => void): () => void {
    return this.bus.on(listener);
  }

  dispose(): void {
    for (const runtime of Object.values(this.runtimes)) runtime.dispose();
  }

  // --- messaging -------------------------------------------------------------

  async sendMessage(text: string, options: SendMessageOptions = {}): Promise<Task> {
    await this.init();

    const command = parseCommand(text);
    // Validate routing up-front so unknown-agent errors surface immediately,
    // whether the turn runs now or is queued behind a busy one.
    let targets: string[] = [];
    if (command.type === "message") {
      targets = (await this.isMonadMessage(text, options)) ? await this.monadAuthor() : options.targets ?? this.routeTargets(text);
      for (const target of targets) {
        if (!this.workspace.agents[target]) throw new Error(this.unknownAgentMessage(target));
      }
    }

    const task = this.createTask(text, targets);

    // Busy? Persist to the durable queue and return — it runs on settle and
    // survives a daemon crash in between.
    if (this.activeTask) {
      task.status = "queued";
      await this.room.enqueue({
        taskId: task.id,
        text,
        targets,
        ...(options.channel === "voice" ? { channel: "voice" as const } : {}),
        queuedAt: task.startedAt,
      });
      this.queuedTasks.push(task);
      this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
      void this.emitSnapshot();
      return task;
    }

    // Idle. A command resolves synchronously so callers can read its system
    // reply right after awaiting; message turns start and stream asynchronously.
    if (command.type !== "message") {
      task.status = "running";
      task.startedAt = new Date().toISOString();
      this.activeTask = task;
      this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
      await this.runCommand(task, command);
      return task;
    }

    this.startTask(task, text, options);
    return task;
  }

  private startTask(task: Task, text: string, options: SendMessageOptions): void {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.activeTask = task;
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });

    void this.runAgentTask(task, text, options).catch((error) => {
      if (this.taskCancelled(task)) return;
      this.settleTask(task, "error", error);
    });
  }

  /** Dispatches the next durably-queued message once the room goes idle. */
  private async drain(): Promise<void> {
    if (this.activeTask) return;
    const next = await this.room.dequeue();
    if (!next) return;
    const chip = this.queuedTasks.find((task) => task.id === next.taskId);
    this.queuedTasks = this.queuedTasks.filter((task) => task.id !== next.taskId);
    const task = chip ?? this.createTask(next.text, next.targets);
    try {
      const command = parseCommand(next.text);
      if (command.type !== "message") {
        task.status = "running";
        task.startedAt = new Date().toISOString();
        this.activeTask = task;
        this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
        await this.runCommand(task, command);
        return;
      }
      this.startTask(task, next.text, { targets: next.targets, ...(next.channel ? { channel: next.channel } : {}) });
    } catch (error) {
      this.settleTask(task, "error", error);
    }
  }

  private routeTargets(text: string): string[] {
    const route = planMentionRoute(text, Object.keys(this.workspace.agents), this.workspace.config.defaultAgent);
    if (!route.ok) {
      throw new Error(
        `Unknown agent: ${route.unknown.map((id) => `@${id}`).join(", ")}. Available agents: ${Object.keys(this.workspace.agents)
          .map((id) => `@${id}`)
          .join(", ")}`,
      );
    }
    return route.targets;
  }

  async cancelActiveTask(): Promise<Task | undefined> {
    await this.init();
    // Panic stop clears the whole pipeline: queued messages first so the drain
    // after settling doesn't immediately start one.
    await this.clearQueued();

    const task = this.activeTask;
    if (!task) return undefined;
    // Mark first so in-flight event handling sees the cancellation.
    task.status = "cancelled";
    await Promise.allSettled(task.targets.map((target) => this.runtimes[target]?.abort()).filter(Boolean));
    this.settleTask(task, "cancelled");
    return task;
  }

  private async clearQueued(): Promise<void> {
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

  /** Resolves when no task is running; rejects after timeoutMs (when given). */
  async waitForIdle(timeoutMs?: number): Promise<void> {
    await this.init();
    if (!this.activeTask) return;
    await new Promise<void>((resolveIdle, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
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

  // --- the turn --------------------------------------------------------------

  private async runAgentTask(task: Task, text: string, options: SendMessageOptions): Promise<void> {
    if (await this.isMonadMessage(text, options)) {
      await this.runMonadTask(task, text, options);
      return;
    }

    const channel = options.channel === "voice" ? ("voice" as const) : undefined;
    if (options.recordUserMessage !== false) {
      const userEvent = await this.room.addUserMessage(text, task.targets, channel);
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event: userEvent });
    }

    const remaining = [...task.targets];
    for (const target of task.targets) {
      if (this.taskCancelled(task)) {
        await this.room.clearPendingTurn();
        return;
      }
      const agent = this.workspace.agents[target];
      const runtime = this.runtimes[target];
      const state = await this.room.state();
      const cursor = state.agentCursors[target] ?? 0;
      const { events, nextCursor } = await this.room.eventsFrom(cursor);
      const activeRoleName = state.activeRoles[target];
      const activeRole = activeRoleName ? await resolveAgentRole(agent, activeRoleName) : undefined;
      if (activeRoleName && !activeRole) {
        this.emit({
          type: "task-error",
          workspaceId: this.workspaceId,
          roomId: this.roomId,
          task,
          error: `Active role not found for @${agent.id}: ${activeRoleName}`,
        });
      }

      // WAL step 1: reserve the reply's event id and persist the in-flight
      // marker BEFORE streaming — an interruption leaves a resumable record.
      const eventId = newRoomEventId();
      await this.room.markPendingTurn({
        id: task.id,
        eventId,
        prompt: text,
        targets: [...remaining],
        agentId: target,
        partialReply: "",
        ...(channel ? { channel } : {}),
        startedAt: new Date().toISOString(),
      });
      let lastFlush = 0;

      // Auto-recall never blocks or fails a turn: the hook returns "" on any
      // miss and room-service treats "" as absent.
      const recall = (await this.options.memory?.autoRecallBlock(target, text)) || undefined;

      let turn: Awaited<ReturnType<typeof runAgentTurn>>;
      try {
        turn = await runAgentTurn({
          runtime,
          input: { roomId: this.roomId, message: text, transcript: events, activeRole, channel: options.channel, thinking: options.thinking, recall },
          isCancelled: () => this.taskCancelled(task),
          onEvent: (event) => this.emit(this.toUiEvent(task.id, agent.id, eventId, event)),
          onProgress: async (reply) => {
            const now = Date.now();
            if (now - lastFlush < PARTIAL_FLUSH_MS) return;
            lastFlush = now;
            await this.room.flushPartialReply(reply);
          },
        });
      } catch (error) {
        // Terminal failure: preserve any partial that streamed (the progress),
        // clear the marker (never replay a terminally-failed turn — poison pill).
        const pending = (await this.room.state()).pendingTurn;
        const partial = pending?.partialReply ?? "";
        if (partial.trim()) await this.commitReply(target, eventId, partial, {}, channel, nextCursor);
        else await this.room.clearPendingTurn();
        await this.captureEpisode(target, text, partial, "error", {}, channel);
        throw error;
      }

      // Cancelled or completed: both commit what was produced. A user cancel is
      // a deliberate stop, so the marker clears either way (commit does it).
      const reply = turn.reply.trim();
      if (reply) await this.commitReply(target, eventId, reply, turn.details, channel, nextCursor);
      else await this.room.clearPendingTurn();

      const cancelled = turn.cancelled || this.taskCancelled(task);
      if (reply) await this.captureEpisode(target, text, reply, cancelled ? "cancelled" : "complete", turn.details, channel);

      if (cancelled) return;
      remaining.shift();
    }

    if (!this.taskCancelled(task)) this.settleTask(task, "complete");
  }

  /** WAL step 2: append the reply event (details ON it), then one atomic state
   * write clearing the marker and advancing the cursor. */
  private async commitReply(agentId: string, eventId: string, reply: string, details: EventDetails, channel: "voice" | undefined, nextCursor: number): Promise<void> {
    const hasDetails = details.model || details.thinkingStarted || details.thinking || details.tools?.length;
    const event: RoomEvent = {
      id: eventId,
      timestamp: new Date().toISOString(),
      author: agentId,
      text: reply,
      ...(channel ? { channel } : {}),
      ...(hasDetails ? { details } : {}),
    };
    // The room is single-writer while a task runs: new cursor = line count at
    // read time + this agent's own appended reply.
    await this.room.commitTurn(event, nextCursor + 1);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
  }

  /** Episodic capture is best-effort derived data: a failure must never fail
   * the turn that produced it. */
  private async captureEpisode(
    agentId: string,
    task: string,
    reply: string,
    outcome: EpisodeCapture["outcome"],
    details: EventDetails,
    channel: "voice" | undefined,
  ): Promise<void> {
    if (!this.options.memory) return;
    const tools = [...new Set((details.tools ?? []).map((tool) => tool.toolName))];
    try {
      await this.options.memory.capture(agentId, {
        roomId: this.roomId,
        task,
        reply,
        outcome,
        ...(tools.length ? { tools } : {}),
        ...(channel ? { channel } : {}),
      });
    } catch {
      // Derived data; the transcript already has the full turn.
    }
  }

  async runConsolidateCommand(agentId?: string): Promise<string> {
    const target = agentId ?? this.workspace.config.defaultAgent;
    if (!this.workspace.agents[target]) return `Unknown agent: ${target}`;
    if (!this.options.memory) return "Memory consolidation is not available in this workspace.";
    const result = await this.options.memory.consolidate(target, { force: true });
    if (!result.ran) return `Consolidation skipped for @${target}: ${result.reason ?? "nothing to do"}.`;
    return `Consolidated @${target}: ${result.episodesSeen} episodes reviewed → ${result.factsAdded} facts added, ${result.factsInvalidated} superseded, ${result.memoryEdits} core-memory edits${result.opsSkipped ? `, ${result.opsSkipped} ops skipped` : ""}.`;
  }

  async runScheduleCommand(sub: "list" | "run", jobId?: string): Promise<string> {
    const hooks = this.options.scheduler;
    if (!hooks) return "The scheduler is not available in this workspace.";
    if (sub === "run") {
      if (!jobId) return "Usage: /schedule run <id>";
      return hooks.runNow(jobId);
    }
    return hooks.list();
  }

  /** Append an agent-authored event WITHOUT running a turn — how the scheduler
   * delivers an isolated run's result into its target room. */
  async postAgentNote(agentId: string, text: string): Promise<void> {
    await this.init();
    if (!this.workspace.agents[agentId]) throw new Error(this.unknownAgentMessage(agentId));
    const event: RoomEvent = { id: newRoomEventId(), timestamp: new Date().toISOString(), author: agentId, text };
    await this.room.appendEvent(event);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
  }

  /** Resume a turn a prior process left in-flight. Three cases:
   * - reply already in transcript (crash between append and ack) → finish the
   *   state write only;
   * - partial streamed → commit it as the preserved progress;
   * then re-dispatch any unfinished targets. Re-entrant: the replay re-marks a
   * fresh pendingTurn, so an interrupted resume is itself resumable. */
  private async resumePendingTurn(pending: PendingTurn): Promise<void> {
    const mode = await this.room.resumeMode(pending);
    if (mode === "finish-commit" && pending.eventId) {
      const state = await this.room.state();
      const cursor = state.agentCursors[pending.agentId] ?? 0;
      const { nextCursor } = await this.room.eventsFrom(cursor);
      await this.room.updateState((current) => {
        delete current.pendingTurn;
        current.agentCursors[pending.agentId] = nextCursor;
      });
    } else {
      await this.room.clearPendingTurn();
      if (pending.partialReply.trim()) {
        const state = await this.room.state();
        const cursor = state.agentCursors[pending.agentId] ?? 0;
        const { nextCursor } = await this.room.eventsFrom(cursor);
        // Details weren't durably captured mid-turn; preserve the text.
        await this.commitReply(pending.agentId, pending.eventId ?? newRoomEventId(), pending.partialReply, {}, pending.channel, nextCursor);
      }
    }

    const remaining = mode === "finish-commit" ? pending.targets.filter((t) => t !== pending.agentId) : pending.targets;
    if (remaining.length > 0) {
      // The user prompt is already on disk — replay without re-recording it.
      await this.sendMessage(pending.prompt, {
        targets: remaining,
        recordUserMessage: false,
        ...(pending.channel ? { channel: pending.channel } : {}),
      });
    }
  }

  // --- monad -----------------------------------------------------------------

  private async isMonadMessage(text: string, options: SendMessageOptions): Promise<boolean> {
    const state = await this.room.state();
    if (!state.monad || !this.options.summonHost) return false;
    if (options.targets) return false;
    return !hasExplicitMention(text, new Set(Object.keys(this.workspace.agents)));
  }

  private async monadAuthor(): Promise<string[]> {
    const state = await this.room.state();
    const monad = state.monad;
    return [monad?.coordinatorAgentId ?? monad?.slots[0]?.agentId ?? this.workspace.config.defaultAgent];
  }

  /** Runs the monad engine over a user message: each step is a real summon (a
   * visible child room); only the single final answer posts here. */
  private async runMonadTask(task: Task, text: string, options: SendMessageOptions): Promise<void> {
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
      if (this.taskCancelled(task)) return;

      const final = result.final.trim();
      if (final) {
        const [author] = await this.monadAuthor();
        const event: RoomEvent = { id: newRoomEventId(), timestamp: new Date().toISOString(), author, text: final };
        await this.room.appendEvent(event);
        this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
      }
      this.settleTask(task, "complete");
    } catch (error) {
      if (this.taskCancelled(task)) return;
      this.settleTask(task, "error", error);
    }
  }

  // --- commands ----------------------------------------------------------------

  private async runCommand(task: Task, command: SlashCommand): Promise<void> {
    try {
      const handler = COMMANDS[command.type];
      const text = handler ? await handler(this, command) : `Unknown command. Try /help.`;
      const event: RoomEvent = { id: `system_${task.id}`, timestamp: new Date().toISOString(), author: "system", text };
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
      this.settleTask(task, "complete");
    } catch (error) {
      this.settleTask(task, "error", error);
    }
  }

  async renderAgentsList(): Promise<string> {
    const state = await this.room.state();
    return Object.values(this.workspace.agents)
      .map((agent) => {
        const defaultMark = agent.id === this.workspace.config.defaultAgent ? " (default)" : "";
        const role = state.activeRoles[agent.id] ? ` [role: ${state.activeRoles[agent.id]}]` : "";
        return `${agent.icon} @${agent.id}${defaultMark}${role} - ${agent.displayName} [tools: ${agent.tools.join(", ") || "none"}]`;
      })
      .join("\n");
  }

  async renderRoles(agentId: string | undefined): Promise<string> {
    if (!agentId) return "Usage: /roles <agent>";
    const agent = this.workspace.agents[agentId];
    if (!agent) return this.unknownAgentMessage(agentId);
    const roles = await listAgentRoles(agent);
    if (roles.length === 0) return `No roles found for @${agent.id}. Add files under ${agent.rolesDir}`;
    const state = await this.room.state();
    const activeRole = state.activeRoles[agent.id];
    return roles.map((role) => `${role === activeRole ? "*" : "-"} ${role}${role === activeRole ? " (active)" : ""}`).join("\n");
  }

  async setRole(agentId: string | undefined, role: string | undefined): Promise<string> {
    if (!role) return "Usage: /role [agent] <role|none>";
    const targetId = agentId ?? this.workspace.config.defaultAgent;
    const agent = this.workspace.agents[targetId];
    if (!agent) return this.unknownAgentMessage(targetId);

    if (role === "none") {
      await this.room.updateState((state) => {
        delete state.activeRoles[agent.id];
      });
      await this.emitSnapshot();
      return `Cleared role for @${agent.id}.`;
    }

    const roles = await listAgentRoles(agent);
    if (!roles.includes(role)) {
      return `Unknown role for @${agent.id}: ${role}\nAvailable roles: ${roles.length > 0 ? roles.join(", ") : "none"}`;
    }
    await this.room.updateState((state) => {
      state.activeRoles[agent.id] = role;
    });
    await this.emitSnapshot();
    return `Set @${agent.id} role to ${role}.`;
  }

  async runThinkingCommand(agentId: string | undefined, level: string | undefined): Promise<string> {
    const target = agentId ?? this.workspace.config.defaultAgent;
    const agent = this.workspace.agents[target];
    if (!agent) return this.unknownAgentMessage(target);
    if (!level) {
      return `Usage: /thinking [agent] <${sdkThinkingLevels().join("|")}>\n@${agent.id} thinking is ${agent.thinking ?? "off"}.`;
    }
    try {
      if (this.options.setThinking) return await this.options.setThinking(agent.id, level);
      return await this.setAgentThinking(agent.id, level);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Persists an agent's thinking level to the effective agent.json (project
   * override wins) and hot-applies it — no session or service rebuild. */
  async setAgentThinking(agentId: string, level: string): Promise<string> {
    const levels = sdkThinkingLevels();
    if (level !== "" && !levels.includes(level)) {
      throw new Error(`Invalid thinking level: ${level}. Use one of: ${levels.join(", ")}`);
    }
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));

    const configPath = agent.projectConfigPath ?? agent.configPath;
    const config = ((await readJson(configPath)) ?? {}) as Record<string, unknown>;
    if (level === "") delete config.thinking;
    else config.thinking = level;
    await writeJsonAtomic(configPath, config);

    agent.thinking = level === "" ? undefined : (level as AgentDef["thinking"]);
    await this.emitSnapshot();
    return `Set @${agent.id} thinking to ${level || "unset"}.`;
  }

  async runSummonCommand(agentId: string | undefined, task: string | undefined): Promise<string> {
    if (!this.options.summonHost) return "Summon system is not available.";
    if (!agentId || !task) return "Usage: /summon <agent> <task>";
    const agent = this.workspace.agents[agentId];
    if (!agent) return this.unknownAgentMessage(agentId);
    const childRoomId = await this.options.summonHost.summon(this.roomId, agent.id, task);
    return `Summoned @${agent.id} in room '${childRoomId}'. Open it from the rooms list (under this room) to watch or steer.`;
  }

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
    await this.room.clearTranscript();
    await this.room.updateState((state) => {
      state.agentCursors = {};
      delete state.runtimeDetails;
    });
    this.recentTasks = [];
    await this.emitSnapshot();
    return "Cleared room history and reset all agent sessions.";
  }

  /** /fork: branch into a sibling room. Transcript copies verbatim; cursors
   * RESET so the branch's first turn replays the whole transcript — the one
   * context-rebuild mechanism that works for every harness (sessions cannot
   * be branched). */
  async runForkCommand(): Promise<string> {
    const target = this.nextForkId(this.roomId);
    const dstDir = workspacePaths.roomDir(this.workspace.rootDir, target);
    await mkdir(dstDir, { recursive: true });
    try {
      await copyFile(this.room.transcriptPath, join(dstDir, "transcript.jsonl"));
    } catch {
      // Never-written transcript — the branch starts empty.
    }
    const state = await this.room.state();
    await writeJsonAtomic(workspacePaths.roomState(this.workspace.rootDir, target), normalizeRoomState({ activeRoles: { ...state.activeRoles } }));
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

  async getSnapshot(): Promise<Snapshot> {
    await this.init();
    const events = await this.room.recentEvents(this.workspace.config.transcriptWindow);
    const state = await this.room.state();
    return {
      workspace: {
        id: this.workspaceId,
        rootDir: this.workspace.rootDir,
        configPath: this.workspace.configPath,
        defaultAgent: this.workspace.config.defaultAgent,
      },
      room: {
        id: this.roomId,
        statePath: this.room.statePath,
        events,
      },
      rooms: await this.listRooms(),
      commands: SLASH_COMMANDS,
      agents: await Promise.all(
        Object.values(this.workspace.agents).map(async (agent) => ({
          id: agent.id,
          displayName: agent.displayName,
          icon: agent.icon,
          modelLabel: this.runtimes[agent.id]?.modelLabel ?? "unknown",
          tools: agent.tools,
          voice: agent.voice,
          thinking: agent.thinking,
          activeRole: state.activeRoles[agent.id],
          roles: await listAgentRoles(agent),
          status: (this.activeTask?.targets.includes(agent.id) ? "running" : "idle") as "running" | "idle",
          isDefault: agent.id === this.workspace.config.defaultAgent,
        })),
      ),
      tasks: [...this.recentTasks, ...(this.activeTask ? [this.activeTask] : []), ...this.queuedTasks],
      thinkingLevels: sdkThinkingLevels(),
    };
  }

  async listRooms(): Promise<Snapshot["rooms"]> {
    const roomsDir = workspacePaths.roomsDir(this.workspace.rootDir);
    const fallback = [{ id: this.roomId, path: join(roomsDir, this.roomId), isCurrent: true }];
    if (!existsSync(roomsDir)) return fallback;
    const entries = await readdir(roomsDir, { withFileTypes: true });
    const running = new Set(this.options.summonHost?.runningChildren().map((child) => child.roomId) ?? []);
    const rooms = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const state = normalizeRoomState(await readJson(workspacePaths.roomState(this.workspace.rootDir, entry.name)));
          return {
            id: entry.name,
            path: join(roomsDir, entry.name),
            isCurrent: entry.name === this.roomId,
            ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}),
            ...(running.has(entry.name) ? { running: true } : {}),
          };
        }),
    );
    rooms.sort((a, b) => a.id.localeCompare(b.id));
    return rooms.length > 0 ? rooms : fallback;
  }

  /** The most recent reply text from an agent in this room (summon results). */
  async latestReplyFrom(agentId: string): Promise<string> {
    await this.init();
    const events = await this.room.recentEvents(this.workspace.config.transcriptWindow);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.author === agentId && "text" in event) return event.text;
    }
    return "";
  }

  /** Memory write for a harness subprocess (the `gaia mem` CLI). The daemon is
   * the single writer; caps and secret filter match the in-process path. */
  async mutateAgentMemory(
    agentId: string,
    file: string,
    action: MemoryAction,
    options: { content?: string; oldText?: string },
  ): Promise<MemoryMutationResult> {
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));
    return this.options.memoryStore.mutate(agent.memoryDir, file, action, options);
  }

  // --- internals ---------------------------------------------------------------

  private createTask(text: string, targets: string[]): Task {
    return { id: newId("task"), roomId: this.roomId, text, targets, status: "running", startedAt: new Date().toISOString() };
  }

  private settleTask(task: Task, status: "complete" | "error" | "cancelled", error?: unknown): void {
    task.status = status;
    task.endedAt = new Date().toISOString();
    if (error !== undefined) task.error = error instanceof Error ? error.message : String(error);
    this.recentTasks = [...this.recentTasks.slice(-9), task];
    if (this.activeTask?.id === task.id) this.activeTask = undefined;
    if (status === "error") {
      this.emit({ type: "task-error", workspaceId: this.workspaceId, roomId: this.roomId, task, error: task.error ?? "" });
    } else {
      this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.roomId, task });
    }
    void this.emitSnapshot();
    void this.drain();
  }

  private taskCancelled(task: Task): boolean {
    return task.status === "cancelled";
  }

  private toUiEvent(taskId: string, agentId: string, eventId: string, event: AgentEvent): UiEvent {
    const scope = { workspaceId: this.workspaceId, roomId: this.roomId, taskId, agentId, eventId };
    switch (event.type) {
      case "model-info":
        return { ...scope, type: "model-info", provider: event.provider, modelId: event.modelId, subscription: event.subscription };
      case "text-delta":
        return { ...scope, type: "text-delta", delta: event.delta };
      case "thinking-start":
        return { ...scope, type: "thinking-start" };
      case "thinking-delta":
        return { ...scope, type: "thinking-delta", delta: event.delta };
      case "thinking-end":
        return { ...scope, type: "thinking-end", content: event.content };
      case "tool-start":
        return { ...scope, type: "tool-start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args };
      case "tool-update":
        return { ...scope, type: "tool-update", toolName: event.toolName, toolCallId: event.toolCallId, partialResult: event.partialResult };
      case "tool-end":
        return { ...scope, type: "tool-end", toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError };
    }
  }

  private async emitSnapshot(): Promise<void> {
    this.emit({ type: "snapshot", workspaceId: this.workspaceId, roomId: this.roomId, snapshot: await this.getSnapshot() });
  }

  private emit(event: UiEvent): void {
    this.bus.emit(event);
  }

  private unknownAgentMessage(agentId: string): string {
    return `Unknown agent: @${agentId}\nAvailable agents: ${Object.keys(this.workspace.agents)
      .map((id) => `@${id}`)
      .join(", ")}`;
  }
}
