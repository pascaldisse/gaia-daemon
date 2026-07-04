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
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { attachmentMime, sanitizeAttachmentName } from "../core/attachments.js";
import { Bus } from "../core/bus.js";
import { newId } from "../core/ids.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import { workspacePaths } from "../core/paths.js";
import type { SanitizeProposal, SanitizeStatus } from "../core/types.js";
import type {
  AgentDef,
  AgentEvent,
  AgentModelConfig,
  EventDetails,
  MessageAttachment,
  ModelFallback,
  PendingTurn,
  RoomEvent,
  Snapshot,
  Task,
  UiEvent,
  Workspace,
} from "../core/types.js";
import { newRoomEventId, normalizeRoomState, RoomHandle } from "../domain/rooms.js";
import { listAgentRoles, resolveAgentRole } from "../domain/roles.js";
import type { MemoryStore, MemoryAction, MemoryMutationResult } from "../domain/memory.js";
import { formatMemoryHits, type MemorySearchHit } from "../domain/memory-index.js";
import type { AgentRuntime, HarnessHost } from "../harness/spec.js";
import { HELP_TEXT, SLASH_COMMANDS, hasExplicitMention, parseCommand, planMentionRoute, type SlashCommand } from "./commands.js";
import { SANITIZE_REVIEWER_ID, buildSanitizePrompt, parseSanitizeProposal } from "./sanitize.js";
import { runAgentTurn } from "./turns.js";
import type { EpisodeCapture } from "./memory-service.js";
import type { ConsolidateResult } from "./consolidate.js";
import { allowSummonForTurn, isTrusted, type SummonHost } from "./summons.js";
import { HOOK_TEXT_CAP, runHooks, type HookEvent } from "./hooks.js";
import { MonadEngine } from "./monad.js";
import { activateSetup, deactivateMonad, discoverSetups } from "./setups.js";
import { sdkThinkingLevels } from "./hints.js";
import { createAgentRuntime } from "../harness/host.js";
import { configuredModelLabel } from "../harness/model-label.js";
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
  /** Daemon's settings-change reload (applySettingsChange): commands that
   * rewrite agent.json (/model, /thinking) fire this so every resident room
   * service rebuilds and the next turn spawns a runner that reads the new
   * config — runners snapshot agent.json at spawn, so an in-place mutation
   * alone never reaches a live subprocess. */
  settingsChanged?: (scope: "global" | "workspace") => Promise<void>;
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
  /** Ranked search over facts, episodes, and room history — backs /recall. */
  search(agentId: string, query: string, request?: { limit?: number }): Promise<MemorySearchHit[]>;
}

export interface SendMessageOptions {
  targets?: string[];
  channel?: "text" | "voice";
  /** Synthetic prompts (call greetings, silence nudges) skip the user event. */
  recordUserMessage?: boolean;
  thinking?: string;
  /** Files attached to the message (already stored in the room's files dir). */
  attachments?: MessageAttachment[];
}

/** Min gap between durable partial-reply flushes during a streaming turn. */
const PARTIAL_FLUSH_MS = 1000;

/** Max hits a /recall command reply lists. */
const RECALL_COMMAND_LIMIT = 8;

/** Command handlers, keyed by parsed type. Adding a command = one entry here
 * plus one line in SLASH_COMMANDS. Each returns the system reply text. */
type CommandHandler = (service: RoomService, command: SlashCommand) => Promise<string>;

const COMMANDS: Record<string, CommandHandler> = {
  help: async () => HELP_TEXT,
  agents: (service) => service.renderAgentsList(),
  roles: (service, command) => service.renderRoles(command.type === "roles" ? command.agent : undefined),
  role: (service, command) => (command.type === "role" ? service.setRole(command.agent, command.role) : Promise.resolve("")),
  thinking: (service, command) => (command.type === "thinking" ? service.runThinkingCommand(command.agent, command.level) : Promise.resolve("")),
  model: (service, command) => (command.type === "model" ? service.runModelCommand(command.agent, command.spec) : Promise.resolve("")),
  summon: (service, command) => (command.type === "summon" ? service.runSummonCommand(command.agent, command.task) : Promise.resolve("")),
  setup: (service, command) => (command.type === "setup" ? service.runSetupCommand(command) : Promise.resolve("")),
  clear: (service) => service.runClearCommand(),
  consolidate: (service, command) => (command.type === "consolidate" ? service.runConsolidateCommand(command.agent) : Promise.resolve("")),
  compact: (service, command) => (command.type === "compact" ? service.runCompactCommand(command.agent) : Promise.resolve("")),
  schedule: (service, command) => (command.type === "schedule" ? service.runScheduleCommand(command.sub, command.id) : Promise.resolve("")),
  rewind: (service, command) => (command.type === "rewind" ? service.runRewindCommand(command.count) : Promise.resolve("")),
  recall: (service, command) => (command.type === "recall" ? service.runRecallCommand(command.agent, command.query) : Promise.resolve("")),
  "thanks-dario": (service, command) => (command.type === "thanks-dario" ? service.runThanksDarioCommand(command.sub) : Promise.resolve("")),
  // steer and cancel never reach this registry: both must run WHILE a task is
  // active, so sendMessage handles them before the busy-queue branch.
  steer: (service, command) => (command.type === "steer" ? service.runSteerCommand(command.text) : Promise.resolve("")),
  cancel: (service) => service.runCancelCommand(),
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
  /** Last sanitize proposal marker (full body lives in sanitize.json). */
  private sanitizeStatus: SanitizeStatus | undefined;
  /** Last provider-side model switch per agent; cleared by the next turn that
   * completes without one. Transient — the durable record is the transcript
   * event's details.modelFallback. */
  private modelFallbacks: Record<string, ModelFallback> = {};
  /** Latest harness-reported context accounting per agent (transient). */
  private contextUsage: Record<string, { usedTokens: number; maxTokens?: number }> = {};
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

    // Surface a previously saved sanitize proposal (popup reopens after restart).
    const savedProposal = (await readJson(this.sanitizeProposalPath)) as SanitizeProposal | null;
    if (savedProposal?.at && Array.isArray(savedProposal.suggestions)) {
      this.sanitizeStatus = {
        at: savedProposal.at,
        suggestions: savedProposal.suggestions.length,
        ...(savedProposal.appliedAt ? { appliedAt: savedProposal.appliedAt } : {}),
      };
    }

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

    // /steer and /cancel must run WHILE a turn is active — steer injects into
    // the running turn, cancel stops it — so neither queues behind it.
    if (command.type === "steer" || command.type === "cancel") {
      this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
      const reply = command.type === "steer" ? await this.runSteerCommand(command.text) : await this.runCancelCommand();
      const event: RoomEvent = { id: `system_${task.id}`, timestamp: new Date().toISOString(), author: "system", text: reply };
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
      task.status = "complete";
      task.endedAt = new Date().toISOString();
      this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.roomId, task });
      return task;
    }

    // Busy? Persist to the durable queue and return — it runs on settle and
    // survives a daemon crash in between.
    if (this.activeTask) {
      task.status = "queued";
      await this.room.enqueue({
        taskId: task.id,
        text,
        targets,
        ...(options.channel === "voice" ? { channel: "voice" as const } : {}),
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
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
      this.startTask(task, next.text, {
        targets: next.targets,
        ...(next.channel ? { channel: next.channel } : {}),
        ...(next.attachments?.length ? { attachments: next.attachments } : {}),
      });
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
    const attachments = options.attachments?.length ? options.attachments : undefined;
    if (options.recordUserMessage !== false) {
      const userEvent = await this.room.addUserMessage(text, task.targets, channel, attachments);
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
        ...(attachments ? { attachments } : {}),
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

      this.fireHooks("preTurn", { agentId: target, message: text.slice(0, HOOK_TEXT_CAP), ...(channel ? { channel } : {}) });

      let turn: Awaited<ReturnType<typeof runAgentTurn>>;
      try {
        turn = await runAgentTurn({
          runtime,
          input: {
            roomId: this.roomId,
            message: text,
            ...(attachments ? { attachments } : {}),
            transcript: events,
            activeRole,
            channel: options.channel,
            thinking: options.thinking,
            recall,
          },
          isCancelled: () => this.taskCancelled(task),
          onEvent: (event) => {
            if (event.type === "model-fallback") {
              this.modelFallbacks[target] = { from: event.fromModel, to: event.toModel, reason: event.reason };
            }
            if (event.type === "context-usage") {
              this.contextUsage[target] = { usedTokens: event.usedTokens, ...(event.maxTokens ? { maxTokens: event.maxTokens } : {}) };
            }
            this.emit(this.toUiEvent(task.id, agent.id, eventId, event));
            if (event.type === "tool-end") {
              this.fireHooks("toolUse", { agentId: target, toolName: event.toolName, isError: event.isError });
            }
          },
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

      // A turn that ran clean on the configured model retires the standing
      // fallback warning; one that fell back (re)arms it.
      if (!turn.details.modelFallback) delete this.modelFallbacks[target];

      // Cancelled or completed: both commit what was produced. A user cancel is
      // a deliberate stop, so the marker clears either way (commit does it).
      const reply = turn.reply.trim();
      if (reply) await this.commitReply(target, eventId, reply, turn.details, channel, nextCursor);
      else await this.room.clearPendingTurn();

      const cancelled = turn.cancelled || this.taskCancelled(task);
      if (reply) await this.captureEpisode(target, text, reply, cancelled ? "cancelled" : "complete", turn.details, channel);
      this.fireHooks("postTurn", {
        agentId: target,
        reply: reply.slice(0, HOOK_TEXT_CAP),
        outcome: cancelled ? "cancelled" : "complete",
        tools: [...new Set((turn.details.tools ?? []).map((tool) => tool.toolName))],
      });

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

  /** /steer: inject guidance into the RUNNING turn (capability-gated data —
   * pi session.steer, codex turn/steer; claude declines). The guidance is
   * recorded as a user event for history, but the running harness already
   * received it, and the commit cursor advances past it — so it is never
   * replayed as fresh context. */
  async runSteerCommand(text?: string): Promise<string> {
    const guidance = text?.trim();
    if (!guidance) return "Usage: /steer <guidance for the running turn>";
    const task = this.activeTask;
    const target = task?.targets.find((candidate) => this.runtimes[candidate]);
    if (!task || !target) return "No agent turn is running — just send a normal message.";
    const runtime = this.runtimes[target];
    if (!runtime.capabilities.supportsSteer) return `@${target}'s harness does not support mid-turn steering. Cancel and resend instead.`;
    const event = await this.room.addUserMessage(guidance, [target]);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
    const ok = (await runtime.steer?.(this.roomId, guidance)) ?? false;
    return ok ? `Steering @${target}'s running turn.` : `Could not steer @${target} — the turn may have just finished.`;
  }

  /** /compact: hand the agent's session to its HARNESS's own compaction
   * (pi session.compact, claude /compact, codex thread/compact/start) — gaia
   * never re-implements summarization. Uniform: capability-gated, never
   * id-branched. */
  async runCompactCommand(agent?: string): Promise<string> {
    const target = agent ?? this.workspace.config.defaultAgent;
    if (!this.workspace.agents[target]) return this.unknownAgentMessage(target);
    const runtime = this.runtimes[target];
    if (!runtime.capabilities.supportsCompact || !runtime.compact) {
      return `@${target}'s harness has no native session compaction.`;
    }
    if (this.activeTask) return "A turn is running — /cancel it first, or wait for it to finish.";
    try {
      const message = await runtime.compact(this.roomId);
      await this.emitSnapshot();
      return `@${target}: ${message}`;
    } catch (error) {
      return `Compaction failed for @${target}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** /cancel: panic stop from any client — drops the durable queue and cancels
   * the running turn. Partial progress commits (WAL), so nothing is lost. */
  async runCancelCommand(): Promise<string> {
    const queued = this.queuedTasks.length;
    const cancelled = await this.cancelActiveTask();
    if (!cancelled && queued === 0) return "Nothing is running.";
    const parts: string[] = [];
    if (cancelled) parts.push("Cancelled the running turn (partial progress is kept)");
    if (queued > 0) parts.push(`dropped ${queued} queued message${queued === 1 ? "" : "s"}`);
    return `${parts.join("; ")}.`;
  }

  /** /recall: user-facing search over the same index the recall tool and
   * auto-recall use — facts, episodes, and full room history. */
  async runRecallCommand(agent?: string, query?: string): Promise<string> {
    const trimmed = query?.trim();
    if (!trimmed) return "Usage: /recall [@agent] <query> — search memory and room history.";
    const target = agent ?? this.workspace.config.defaultAgent;
    if (!this.workspace.agents[target]) return this.unknownAgentMessage(target);
    if (!this.options.memory) return "Memory recall is not available in this workspace.";
    const hits = await this.options.memory.search(target, trimmed, { limit: RECALL_COMMAND_LIMIT });
    if (!hits.length) return `No matches for "${trimmed}" in @${target}'s memory or room history.`;
    return `Recall @${target} — "${trimmed}":\n${formatMemoryHits(hits)}`;
  }

  /** /rewind: room-level checkpoint rollback. Truncates the transcript after
   * the n-th-last user message, resets every cursor and harness session, and
   * lets the next turn replay the kept transcript window — the one rewind
   * mechanism that works identically for every harness (sessions cannot be
   * rewound). */
  async runRewindCommand(countRaw?: string): Promise<string> {
    const count = countRaw ? Number.parseInt(countRaw, 10) : 1;
    if (!Number.isInteger(count) || count < 1) return "Usage: /rewind [n] — undo the last n user turns and their replies.";
    const dropped = await this.room.rewindTranscript(count);
    if (!dropped) return `Nothing to rewind: this room has fewer than ${count} user message${count === 1 ? "" : "s"}.`;
    await this.resetAfterTruncation();
    return `Rewound ${count} user turn${count === 1 ? "" : "s"} (${dropped.length} event${dropped.length === 1 ? "" : "s"} removed). Agent sessions reset; the next turn replays the kept history.`;
  }

  /** /thanks-dario: run a review now, or toggle auto-review on model fallback. */
  async runThanksDarioCommand(sub: "on" | "off" | "run"): Promise<string> {
    if (sub === "on" || sub === "off") {
      await this.room.updateState((state) => {
        if (sub === "on") state.thanksDario = true;
        else delete state.thanksDario;
      });
      await this.emitSnapshot();
      return sub === "on"
        ? "Thanks-Dario mode ON: when a provider-side safeguard reroutes this room's model, Dario reviews the transcript and proposes redactions — popup with a diff, nothing rewritten without your approval."
        : "Thanks-Dario mode OFF.";
    }
    const proposal = await this.sanitizePreview();
    const window = `${proposal.window} message${proposal.window === 1 ? "" : "s"}`;
    if (proposal.parseError) {
      return `Dario reviewed ${window} but his reply did not parse as suggestions (${proposal.parseError}). His raw notes are in the review popup.`;
    }
    if (proposal.suggestions.length === 0) {
      return `Dario reviewed ${window} and found nothing that should trip a classifier. ${proposal.summary}`.trim();
    }
    return `Dario reviewed ${window}: ${proposal.suggestions.length} suggested edit${proposal.suggestions.length === 1 ? "" : "s"} ready in the review popup. Nothing is rewritten until you approve.`;
  }

  /** Run the reviewer persona over the events a fresh session would replay
   * and persist his proposal. Read-only — apply is a separate, human-approved
   * step. The reviewer runs through the ordinary summon path (sandboxed child
   * room, any harness/provider), so there is nothing harness-specific here. */
  async sanitizePreview(): Promise<SanitizeProposal> {
    const host = this.options.summonHost;
    if (!host) throw new Error("Summons are not available in this workspace — the reviewer needs them to run.");
    if (!this.workspace.agents[SANITIZE_REVIEWER_ID]) {
      throw new Error(`No "${SANITIZE_REVIEWER_ID}" persona is loaded — restart the daemon to seed it, then retry.`);
    }
    const events = await this.room.recentEvents(this.workspace.config.transcriptWindow);
    if (events.length === 0) throw new Error("Nothing to review — this room's transcript is empty.");
    const reply = await host.summonAndWait(this.roomId, SANITIZE_REVIEWER_ID, buildSanitizePrompt(events));
    const proposal = parseSanitizeProposal(reply, events, {
      roomId: this.roomId,
      reviewer: SANITIZE_REVIEWER_ID,
      at: new Date().toISOString(),
    });
    await writeJsonAtomic(this.sanitizeProposalPath, proposal);
    this.sanitizeStatus = { at: proposal.at, suggestions: proposal.suggestions.length };
    await this.emitSnapshot();
    return proposal;
  }

  /** Apply approved edits: rewrite the selected events in place (originals
   * preserved append-only in redactions.jsonl), then fresh sessions + capped
   * cursors so the next turn replays the sanitized window. Every quote is
   * re-validated against the live transcript — a stale or hallucinated quote
   * is skipped, never guessed at. */
  async sanitizeApply(edits: { eventId: string; quote: string; replacement: string }[]): Promise<{ applied: number; skipped: number }> {
    if (this.activeTask) throw new Error("A turn is running — wait for it to finish (or /cancel) before rewriting context.");
    if (edits.length === 0) throw new Error("No edits selected.");
    const { events } = await this.room.eventsFrom(0);
    const texts = new Map(events.map((event) => [event.id, event.text]));
    const next = new Map<string, string>();
    let skipped = 0;
    for (const edit of edits) {
      const current = next.get(edit.eventId) ?? texts.get(edit.eventId);
      if (current === undefined || !edit.quote || !current.includes(edit.quote)) {
        skipped++;
        continue;
      }
      next.set(edit.eventId, current.replace(edit.quote, edit.replacement));
    }
    if (next.size === 0) throw new Error("None of the selected edits matched the current transcript.");
    const edited = await this.room.redactEvents(next);

    const proposal = (await readJson(this.sanitizeProposalPath)) as SanitizeProposal | null;
    if (proposal?.at) {
      proposal.appliedAt = new Date().toISOString();
      await writeJsonAtomic(this.sanitizeProposalPath, proposal);
      this.sanitizeStatus = {
        at: proposal.at,
        suggestions: Array.isArray(proposal.suggestions) ? proposal.suggestions.length : 0,
        appliedAt: proposal.appliedAt,
      };
    }
    await this.resetAfterTruncation();
    this.emit({
      type: "room-event",
      workspaceId: this.workspaceId,
      roomId: this.roomId,
      event: {
        id: `system_sanitize_${Date.now().toString(36)}`,
        timestamp: new Date().toISOString(),
        author: "system",
        text: `✂ Rewrote ${edited.length} message${edited.length === 1 ? "" : "s"}${skipped > 0 ? ` (${skipped} skipped)` : ""}. Originals are preserved in redactions.jsonl; fresh sessions replay the sanitized history on the next turn.`,
      },
    });
    return { applied: edited.length, skipped };
  }

  /** The last saved proposal (popup re-open + the GET route). */
  async getSanitizeProposal(): Promise<SanitizeProposal | null> {
    const proposal = (await readJson(this.sanitizeProposalPath)) as SanitizeProposal | null;
    return proposal?.at ? proposal : null;
  }

  private get sanitizeProposalPath(): string {
    return join(workspacePaths.roomDir(this.workspace.rootDir, this.roomId), "sanitize.json");
  }

  /** Retry a reply: fork the room at the user message that produced the
   * given event and re-run it verbatim. Works on an agent reply (regenerate
   * it) or on a user message (re-send it). */
  async retryMessage(eventId: string): Promise<Task> {
    const origin = await this.forkAtUserMessage(eventId);
    return this.sendMessage(origin.text, {
      ...(origin.targets.length ? { targets: origin.targets } : {}),
      ...(origin.attachments?.length ? { attachments: origin.attachments } : {}),
    });
  }

  /** Edit a user message: fork the room at that message and re-run with the
   * new text. An explicit @mention in the edited text wins; otherwise the
   * original routing is kept. Original attachments ride along (claude.ai
   * edit semantics: the text changes, the files stay). */
  async editMessage(eventId: string, text: string): Promise<Task> {
    const origin = await this.forkAtUserMessage(eventId);
    const mentioned = hasExplicitMention(text, new Set(Object.keys(this.workspace.agents)));
    return this.sendMessage(text, {
      ...(!mentioned && origin.targets.length ? { targets: origin.targets } : {}),
      ...(origin.attachments?.length ? { attachments: origin.attachments } : {}),
    });
  }

  /** The fork-from-message primitive behind edit and retry: truncate the
   * transcript at the originating USER message (dropped events are preserved
   * in rewound.jsonl), reset every harness session, and cap cursors so the
   * next turn replays the kept transcript window. Claude.ai-style "edit
   * deletes the rest" — except nothing is actually lost. Uniform for every
   * harness: the room WAL is the fork; native session forks are never used. */
  private async forkAtUserMessage(eventId: string): Promise<{ text: string; targets: string[]; attachments?: MessageAttachment[] }> {
    if (this.activeTask) throw new Error("A turn is running — cancel it first, then edit or retry.");
    const { events } = await this.room.eventsFrom(0);
    let index = events.findIndex((event) => event.id === eventId);
    if (index < 0) throw new Error("Message not found in this room's transcript.");
    while (index >= 0 && events[index].author !== "user") index--;
    if (index < 0) throw new Error("No user message precedes that event to fork from.");
    const origin = events[index];
    await this.room.rewindToEvent(origin.id);
    await this.resetAfterTruncation();
    return {
      text: origin.text,
      targets: "targets" in origin ? origin.targets : [],
      ...("attachments" in origin && origin.attachments?.length ? { attachments: origin.attachments } : {}),
    };
  }

  /** After any transcript truncation: fresh harness sessions for every agent
   * and cursors capped to the kept window, so the next turn replays recent
   * history without ever flooding the prompt in a long room. */
  private async resetAfterTruncation(): Promise<void> {
    const kept = (await this.room.eventsFrom(0)).events.length;
    const base = Math.max(0, kept - this.workspace.config.transcriptWindow);
    for (const runtime of Object.values(this.runtimes)) runtime.resetRoom(this.roomId);
    await this.room.updateState((state) => {
      state.agentCursors = Object.fromEntries(Object.keys(this.workspace.agents).map((id) => [id, base]));
      delete state.runtimeDetails;
    });
    this.recentTasks = [];
    await this.emitSnapshot();
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
        ...(pending.attachments?.length ? { attachments: pending.attachments } : {}),
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
   * override wins). The in-place mutation updates THIS process's snapshot;
   * the settingsChanged reload is what carries it into the runner
   * subprocesses (they snapshot agent.json at spawn). */
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
    await this.reloadAfterAgentConfigWrite(agent);
    return `Set @${agent.id} thinking to ${level || "unset"}.`;
  }

  /** After a command rewrites agent.json: rebuild the affected services so
   * live runners respawn on the NEW config. Runners are subprocesses that
   * read agent.json once at spawn — without this, /model and /thinking only
   * changed the chip, never the next turn (the bug where /model opus kept
   * running fable). The reload defers while a turn runs and harness sessions
   * resume from their on-disk stores, so the conversation continues. */
  private async reloadAfterAgentConfigWrite(agent: AgentDef): Promise<void> {
    await this.options.settingsChanged?.(agent.projectConfigPath ? "workspace" : "global");
  }

  async runModelCommand(agentId: string | undefined, spec: string | undefined): Promise<string> {
    const target = agentId ?? this.workspace.config.defaultAgent;
    const agent = this.workspace.agents[target];
    if (!agent) return this.unknownAgentMessage(target);
    const current = agent.model ? `${agent.model.provider ?? "?"}/${agent.model.name ?? "?"}` : "workspace default";
    if (!spec) {
      return `Usage: /model [agent] <provider/name> (or "none" to clear)\n@${agent.id} model is ${current}.`;
    }
    try {
      return await this.setAgentModel(agent.id, spec);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Persists an agent's model to the effective agent.json (project override
   * wins). "none"/"default"/"off" clears the override, falling back to the
   * workspace default. A bare name keeps the current provider;
   * "provider/name" sets both. The settingsChanged reload carries the change
   * into the runner subprocesses — the manual pick sticks until the next
   * /model, while a provider-side auto-reroute (fable → opus safeguard)
   * stays per-message and never rewrites this config. */
  async setAgentModel(agentId: string, spec: string): Promise<string> {
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));

    const configPath = agent.projectConfigPath ?? agent.configPath;
    const config = ((await readJson(configPath)) ?? {}) as Record<string, unknown>;

    if (["none", "default", "off", ""].includes(spec.toLowerCase())) {
      delete config.model;
      await writeJsonAtomic(configPath, config);
      agent.model = undefined;
      await this.emitSnapshot();
      await this.reloadAfterAgentConfigWrite(agent);
      return `Cleared @${agent.id} model override — using workspace default. Applies from the next turn (the session continues).`;
    }

    const slash = spec.indexOf("/");
    const model: AgentModelConfig =
      slash > 0
        ? { provider: spec.slice(0, slash), name: spec.slice(slash + 1) }
        : { provider: agent.model?.provider ?? "anthropic", name: spec };
    if (!model.name) throw new Error(`Invalid model: ${spec}. Use <name> or <provider/name>.`);

    config.model = model;
    await writeJsonAtomic(configPath, config);
    agent.model = model;
    await this.emitSnapshot();
    await this.reloadAfterAgentConfigWrite(agent);
    return `Set @${agent.id} model to ${model.provider}/${model.name}. Applies from the next turn (the session continues).`;
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

  /** One committed transcript event by id (read-aloud and similar lookups). */
  async eventById(eventId: string): Promise<RoomEvent | undefined> {
    await this.init();
    const { events } = await this.room.eventsFrom(0);
    return events.find((event) => event.id === eventId);
  }

  /** Page backwards through committed history: the `limit` events immediately
   * before `beforeId` (or the transcript tail when it's absent/unknown). Backs
   * the transcript's "load older" — the snapshot only carries the tail window. */
  async eventsBefore(beforeId: string | undefined, limit: number): Promise<{ events: RoomEvent[]; hasMore: boolean }> {
    await this.init();
    const { events } = await this.room.eventsFrom(0);
    const found = beforeId ? events.findIndex((event) => event.id === beforeId) : -1;
    const end = found >= 0 ? found : events.length;
    const start = Math.max(0, end - Math.max(1, limit));
    return { events: events.slice(start, end), hasMore: start > 0 };
  }

  async getSnapshot(): Promise<Snapshot> {
    await this.init();
    const all = (await this.room.eventsFrom(0)).events;
    const events = all.slice(-this.workspace.config.transcriptWindow);
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
        eventTotal: all.length,
        ...(state.thanksDario ? { thanksDario: true } : {}),
        ...(this.sanitizeStatus ? { sanitize: this.sanitizeStatus } : {}),
      },
      rooms: await this.listRooms(),
      commands: SLASH_COMMANDS,
      agents: await Promise.all(
        Object.values(this.workspace.agents).map(async (agent) => ({
          id: agent.id,
          displayName: agent.displayName,
          icon: agent.icon,
          modelLabel: this.runtimes[agent.id]?.modelLabel ?? "unknown",
          configuredModel: configuredModelLabel(agent.model, "default"),
          ...(this.modelFallbacks[agent.id] ? { modelFallback: this.modelFallbacks[agent.id] } : {}),
          ...(this.contextUsage[agent.id] ? { context: this.contextUsage[agent.id] } : {}),
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
          // Rooms are chats: order by last transcript write, like a chat list.
          // The importer stamps original chat dates onto imported transcripts,
          // so archives sit at their historical position until touched again.
          const activity = await stat(workspacePaths.transcript(this.workspace.rootDir, entry.name)).then(
            (info) => info.mtimeMs,
            () => 0,
          );
          return {
            activity,
            summary: {
              id: entry.name,
              path: join(roomsDir, entry.name),
              isCurrent: entry.name === this.roomId,
              ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}),
              ...(running.has(entry.name) ? { running: true } : {}),
              ...(state.title ? { title: state.title } : {}),
              ...(state.imported ? { imported: state.imported } : {}),
            },
          };
        }),
    );
    rooms.sort((a, b) => b.activity - a.activity || a.summary.id.localeCompare(b.summary.id));
    return rooms.length > 0 ? rooms.map((room) => room.summary) : fallback;
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

  // --- attachments -------------------------------------------------------------

  /** Persist a pasted file into this room's files/ dir (backs the upload
   * route). The daemon issues the on-disk id; `name` stays the original
   * client-side filename for display and prompts. */
  async storeAttachment(name: string, data: Buffer, mime?: string): Promise<MessageAttachment & { id: string }> {
    const safe = sanitizeAttachmentName(name);
    const id = `${newId("f")}-${safe}`;
    const dir = workspacePaths.roomFilesDir(this.workspace.rootDir, this.roomId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, id);
    await writeFile(path, data);
    return { id, name: name.trim() || safe, mime: mime?.trim() || attachmentMime(safe), size: data.byteLength, path };
  }

  /** Re-resolve client-sent attachment refs against this room's files dir.
   * Only the server-issued id is trusted for path math (basename'd, must
   * exist inside the dir); name/mime are display strings from the upload
   * response. Throws on an unknown id so a bad send fails loudly. */
  async resolveAttachments(refs: { id: string; name?: string; mime?: string }[]): Promise<MessageAttachment[]> {
    const dir = workspacePaths.roomFilesDir(this.workspace.rootDir, this.roomId);
    const attachments: MessageAttachment[] = [];
    for (const ref of refs) {
      const id = basename(ref.id.trim());
      if (!id || id.startsWith(".")) throw new Error(`Invalid attachment id: ${ref.id}`);
      const path = join(dir, id);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`Unknown attachment: ${id} — upload it first.`);
      attachments.push({
        name: ref.name?.trim() || id,
        mime: ref.mime?.trim() || attachmentMime(id),
        size: info.size,
        path,
      });
    }
    return attachments;
  }

  /** Absolute path of a stored attachment by id, for the serve route. */
  attachmentPath(id: string): string {
    return join(workspacePaths.roomFilesDir(this.workspace.rootDir, this.roomId), basename(id));
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
      this.fireHooks("error", { taskId: task.id, agentIds: task.targets, error: (task.error ?? "").slice(0, HOOK_TEXT_CAP) });
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

  /** Observer hooks (config.json `hooks`), fire-and-forget: run at the room
   * layer, so they behave identically for every harness. Never awaited on the
   * turn path — a hook can neither block nor fail a turn. */
  private fireHooks(event: HookEvent, payload: Record<string, unknown>): void {
    const hooks = this.workspace.config.hooks?.[event];
    if (!hooks?.length) return;
    void runHooks(hooks, event, { roomId: this.roomId, ...payload }, {
      cwd: this.workspace.rootDir,
      log: (message) => console.warn(`[gaia] ${message}`),
    });
  }

  private toUiEvent(taskId: string, agentId: string, eventId: string, event: AgentEvent): UiEvent {
    const scope = { workspaceId: this.workspaceId, roomId: this.roomId, taskId, agentId, eventId };
    switch (event.type) {
      case "model-info":
        return { ...scope, type: "model-info", provider: event.provider, modelId: event.modelId, subscription: event.subscription };
      case "model-fallback":
        return { ...scope, type: "model-fallback", fromModel: event.fromModel, toModel: event.toModel, reason: event.reason };
      case "context-usage":
        return { ...scope, type: "context-usage", usedTokens: event.usedTokens, maxTokens: event.maxTokens };
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
