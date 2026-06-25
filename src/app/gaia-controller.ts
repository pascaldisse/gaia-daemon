import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition } from "../agents/types.js";
import { readJsonFile, writeJsonFile } from "../lib/fs.js";
import { newId } from "../lib/ids.js";
import { MemoryStore, type MemoryAction, type MemoryMutationResult } from "../memory/memory-store.js";
import { Room } from "../room/room.js";
import { defaultRoomState, readRoomState, roomStatePath, writeRoomState, type RoomState, type RuntimeMessageDetails, type RuntimeToolDetails } from "../room/state.js";
import type { RoomEvent } from "../room/transcript.js";
import { planMentionRoute } from "../router/mention-router.js";
import { listAgentRoles, resolveAgentRole } from "../roles/roles.js";
import { createAgentRuntime } from "../runtime/runtime-factory.js";
import { resolveSandboxPolicy } from "../runtime/sandbox/index.js";
import type { AgentEvent, AgentRuntime } from "../runtime/types.js";
import type { Workspace } from "../workspace/types.js";
import type { HarnessHost } from "./harness-bridge.js";
import { HELP_TEXT, parseCommand, SLASH_COMMANDS } from "./commands.js";
import { MonadEngine } from "./monad-engine.js";
import { sdkThinkingLevels } from "./settings-hints.js";
import { activateSetup, deactivateMonad, discoverSetups } from "../setups/setup-loader.js";
import type { SummonHost } from "./summon-coordinator.js";
import { allowSummonForTurn, isTrusted } from "./summon-policy.js";
import { runAgentTurn } from "./turn-runner.js";

export interface AgentStatus {
  id: string;
  displayName: string;
  icon: string;
  modelLabel: string;
  tools: string[];
  voice?: string;
  thinking?: string;
  activeRole?: string;
  roles: string[];
  status: "idle" | "running" | "error";
  isDefault: boolean;
}

export interface GaiaTask {
  id: string;
  roomId: string;
  text: string;
  targets: string[];
  status: "queued" | "running" | "complete" | "error" | "cancelled";
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export type UiRoomEvent = RoomEvent & {
  _model?: string;
  _thinkingStarted?: boolean;
  _thinking?: string;
  _tools?: RuntimeToolDetails[];
};

export interface RoomSummary {
  id: string;
  path: string;
  isCurrent: boolean;
  // Set on a summon's child room: the room that spawned it. Drives the nested,
  // collapsed rooms tree in the sidebar. Absent on top-level rooms.
  parentRoomId?: string;
  // True while this room is a summon whose first turn is still streaming.
  running?: boolean;
}

export interface GaiaSnapshot {
  workspace: {
    id: string;
    rootDir: string;
    configPath: string;
    defaultAgent: string;
  };
  room: {
    id: string;
    statePath: string;
    events: UiRoomEvent[];
  };
  rooms: RoomSummary[];
  commands: typeof SLASH_COMMANDS;
  agents: AgentStatus[];
  tasks: GaiaTask[];
  thinkingLevels: string[];
}

export type GaiaUiEvent =
  | { type: "snapshot"; workspaceId: string; roomId: string; snapshot: GaiaSnapshot }
  | { type: "room-event"; workspaceId: string; roomId: string; event: UiRoomEvent }
  | { type: "task-start"; workspaceId: string; roomId: string; task: GaiaTask }
  | { type: "model-info"; workspaceId: string; roomId: string; taskId: string; agentId: string; provider: string; modelId: string; subscription: boolean }
  | { type: "text-delta"; workspaceId: string; roomId: string; taskId: string; agentId: string; delta: string }
  | { type: "thinking-start"; workspaceId: string; roomId: string; taskId: string; agentId: string }
  | { type: "thinking-delta"; workspaceId: string; roomId: string; taskId: string; agentId: string; delta: string }
  | { type: "thinking-end"; workspaceId: string; roomId: string; taskId: string; agentId: string; content?: string }
  | { type: "tool-start"; workspaceId: string; roomId: string; taskId: string; agentId: string; toolName: string; toolCallId?: string; args?: unknown }
  | { type: "tool-update"; workspaceId: string; roomId: string; taskId: string; agentId: string; toolName: string; toolCallId?: string; partialResult?: unknown }
  | { type: "tool-end"; workspaceId: string; roomId: string; taskId: string; agentId: string; toolName: string; toolCallId?: string; result?: unknown; isError: boolean }
  | { type: "task-end"; workspaceId: string; roomId: string; task: GaiaTask }
  | { type: "task-error"; workspaceId: string; roomId: string; task: GaiaTask; error: string }
  | { type: "settings-saved"; workspaceId?: string; roomId?: string; fileId: string }
  | {
      type: "voice-status";
      workspaceId: string;
      roomId: string;
      voice: VoiceCallInfo | null;
      // Startup progress while the voice stack boots, before the call binds.
      pending?: { agentId: string; message: string };
    };

// Active voice call binding, broadcast to clients and returned by voice/start.
export interface VoiceCallInfo {
  agentId: string;
  roomId: string;
  unmuteUrl: string;
  voice?: string;
  // Thinking level in force for this call's spoken turns (auto-off or a
  // manual mid-call change); the agent's own setting returns on hang-up.
  thinking?: string;
  startedAt: string;
}

export interface GaiaControllerOptions {
  workspaceId: string;
  workspace: Workspace;
  // The room this controller is bound to. Defaults to the workspace's
  // configured room; the server passes an explicit id so it can hold one
  // long-lived controller per room (parent rooms and summon sub-rooms alike).
  roomId?: string;
  // Workspace-scoped memory store, shared by every room controller in the
  // workspace. Omitted by tests/standalone, which get a private store.
  memoryStore?: MemoryStore;
  runtimeFactory?: (agent: AgentDefinition) => AgentRuntime;
  // Host-provided thinking setter; the web server scopes changes to an active
  // voice call before falling back to persistence. Returns feedback text.
  setThinking?: (agentId: string, level: string) => Promise<string>;
  // Daemon bridge for the Claude harness's memory/recall/summon CLI. Absent in
  // tests and headless contexts; the Claude harness then has no write path.
  harnessHost?: (options: { allowSummon: boolean }) => HarnessHost;
  // Server-owned summon coordinator. A summon runs as a child room through its
  // own controller, so this is just the cross-room handle the controller can't
  // hold itself. Absent in tests/standalone (then /summon is unavailable).
  summonHost?: SummonHost;
}

export interface SendMessageOptions {
  // Bypass @mention routing and send to exactly these agents.
  targets?: string[];
  // Voice turns get a spoken-reply prompt overlay and a transcript marker.
  channel?: "text" | "voice";
  // Synthetic prompts (call greetings, silence nudges) skip the user event.
  recordUserMessage?: boolean;
  // Per-turn thinking level override (voice calls may force "off").
  thinking?: string;
}

// How many messages keep their thinking/tool details in room state. Details
// are only rendered for the recent transcript window, so the map stays small
// instead of accumulating every tool result the room has ever seen.
const RUNTIME_DETAILS_LIMIT = 50;

// Min gap between durable partial-reply flushes during a streaming turn. Bounds
// state.json write churn while keeping at most ~this much streamed text at risk on
// an abrupt kill (the rest is already on disk). See no-progress-lost.
const PARTIAL_FLUSH_MS = 1000;

export class GaiaController {
  private readonly room: Room;
  // Workspace-scoped, shared across that workspace's room controllers so the
  // daemon stays the single writer for an agent's memory even when several
  // rooms (and their summons) run at once. Defaults to a private store when the
  // host (tests, standalone) does not supply one.
  private readonly memoryStore: MemoryStore;
  private readonly runtimes: Record<string, AgentRuntime>;
  private readonly listeners = new Set<(event: GaiaUiEvent) => void>();
  private roomState: RoomState = defaultRoomState();
  private activeTask: GaiaTask | undefined;
  // Messages sent while a turn is running queue here and drain on settle, so the
  // user can steer/stack instead of hitting "room already has an active task".
  private pending: Array<{ task: GaiaTask; text: string; command: ReturnType<typeof parseCommand>; options: SendMessageOptions }> = [];
  private recentTasks: GaiaTask[] = [];
  private initialized = false;

  constructor(private readonly options: GaiaControllerOptions) {
    this.room = new Room(options.workspace, options.roomId);
    this.memoryStore = options.memoryStore ?? new MemoryStore();

    // Every agent runs in a uniform per-(room, agent) runner subprocess; its
    // tool I/O (memory writes, summon) reaches the daemon over the same HTTP
    // bridge, so there is no privileged in-process summon path anymore.
    this.runtimes = Object.fromEntries(
      Object.values(options.workspace.agents).map((agent) => [
        agent.id,
        options.runtimeFactory
          ? options.runtimeFactory(agent)
          : createAgentRuntime({
              workspace: options.workspace,
              agent,
              harnessHost: options.harnessHost,
              // Resolved at spawn (after init), when parentRoomId is known. A
              // summoned worker only gets summon rights if its agent opts in
              // (and isn't deepseek-tier); top-level turns always do.
              allowSummon: () => allowSummonForTurn(agent, Boolean(this.roomState.parentRoomId)),
              // Resolved at spawn (after init), so a summon child room is known
              // and can default the sandbox on (above the harness). An untrusted
              // agent is forced into a sandbox regardless of isSummon/config.
              sandbox: () =>
                resolveSandboxPolicy(options.workspace.config.sandbox, agent.sandbox, Boolean(this.roomState.parentRoomId), {
                  trusted: isTrusted(agent),
                }),
            }),
      ]),
    );
  }

  get workspace(): Workspace {
    return this.options.workspace;
  }

  get workspaceId(): string {
    return this.options.workspaceId;
  }

  get roomId(): string {
    return this.room.id;
  }

  get hasActiveTask(): boolean {
    return Boolean(this.activeTask);
  }

  // Busy = running a turn OR has a background summon still running. The server
  // keys controllers per room and evicts idle ones; this guards a controller
  // from being torn down (and its background work killed) while it is live.
  get isBusy(): boolean {
    return Boolean(this.activeTask) || Boolean(this.options.summonHost?.runningChildren(this.room.id).length);
  }

  get activeTaskId(): string | undefined {
    return this.activeTask?.id;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await Promise.all(
      Object.values(this.workspace.agents).map((agent) => this.memoryStore.init(agent.memoryDir, agent.displayName)),
    );
    this.roomState = await this.room.readState();
    this.initialized = true;

    // A pendingTurn on a FRESH read means a prior process was interrupted mid-turn.
    // Resume it in the background (re-entrant: resume calls sendMessage, which awaits
    // init() — already true here, so no loop). Never blocks opening the room.
    if (this.roomState.pendingTurn) void this.resumePendingTurn().catch(() => {});
  }

  subscribe(listener: (event: GaiaUiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const runtime of Object.values(this.runtimes)) runtime.dispose();
    this.listeners.clear();
  }

  async getSnapshot(): Promise<GaiaSnapshot> {
    await this.init();
    const events = await this.room.recentEvents();
    return {
      workspace: {
        id: this.workspaceId,
        rootDir: this.workspace.rootDir,
        configPath: this.workspace.configPath,
        defaultAgent: this.workspace.config.defaultAgent,
      },
      room: {
        id: this.room.id,
        statePath: this.room.statePath,
        events: events.map((event) => this.withRuntimeDetails(event)),
      },
      rooms: await this.listRooms(),
      commands: SLASH_COMMANDS,
      agents: await this.agentStatuses(),
      tasks: [...this.recentTasks, ...(this.activeTask ? [this.activeTask] : []), ...this.pending.map((item) => item.task)],
      thinkingLevels: sdkThinkingLevels(),
    };
  }

  async listRooms(): Promise<RoomSummary[]> {
    const fallback = [{ id: this.room.id, path: join(this.workspace.roomsDir, this.room.id), isCurrent: true }];
    if (!existsSync(this.workspace.roomsDir)) return fallback;
    const entries = await readdir(this.workspace.roomsDir, { withFileTypes: true });
    // A summon whose first turn is still streaming, so the tree can flag it live.
    const running = new Set(this.options.summonHost?.runningChildren().map((child) => child.roomId) ?? []);
    const rooms = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          // parentRoomId links a summon's child room to its spawner; read from
          // the room's own state so the sidebar can nest it under its parent.
          const state = await readRoomState(roomStatePath(this.workspace.roomsDir, entry.name));
          return {
            id: entry.name,
            path: join(this.workspace.roomsDir, entry.name),
            isCurrent: entry.name === this.room.id,
            ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}),
            ...(running.has(entry.name) ? { running: true } : {}),
          };
        }),
    );
    rooms.sort((a, b) => a.id.localeCompare(b.id));
    return rooms.length > 0 ? rooms : fallback;
  }

  async sendMessage(text: string, options: SendMessageOptions = {}): Promise<GaiaTask> {
    await this.init();

    const command = parseCommand(text);
    // Validate message routing up-front so unknown-agent errors surface
    // immediately, whether the turn runs now or is queued behind a busy one.
    let targets: string[] = [];
    if (command.type === "message") {
      // A monad room routes plain messages through the engine; the "target" is
      // the coordinator that authors the single final answer. Explicit @mentions
      // and host-set targets (voice/summon) bypass the monad to a direct turn.
      targets = this.isMonadMessage(text, options) ? [this.monadAuthor()] : options.targets ?? this.routeTargets(text);
      for (const target of targets) {
        if (!this.workspace.agents[target]) throw new Error(this.unknownAgentMessage(target));
      }
    }

    const task = this.createTask(text, targets);

    // Busy? Queue and return — the message runs when the current turn settles.
    if (this.activeTask) {
      task.status = "queued";
      this.pending.push({ task, text, command, options });
      this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.room.id, task });
      void this.emitSnapshot();
      return task;
    }

    // Idle. A command resolves synchronously so callers can read its system
    // reply right after awaiting; message turns start and stream asynchronously.
    if (command.type !== "message") {
      task.status = "running";
      task.startedAt = new Date().toISOString();
      this.activeTask = task;
      this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.room.id, task });
      await this.runCommand(task, command);
      return task;
    }

    this.startTask(task, text, command, options);
    return task;
  }

  // Begins a queued-or-fresh task immediately. The room is single-flight: this
  // is only ever entered when no task is active (sendMessage guard / drain).
  private startTask(task: GaiaTask, text: string, command: ReturnType<typeof parseCommand>, options: SendMessageOptions): void {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.activeTask = task;
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.room.id, task });

    if (command.type !== "message") {
      void this.runCommand(task, command).catch((error) => this.settleTask(task, "error", error));
      return;
    }

    void this.runAgentTask(task, text, options).catch((error) => {
      if (this.taskCancelled(task)) return;
      this.settleTask(task, "error", error);
    });
  }

  // Dispatches the next queued message once the room goes idle.
  private drain(): void {
    if (this.activeTask) return;
    const next = this.pending.shift();
    if (!next) return;
    try {
      this.startTask(next.task, next.text, next.command, next.options);
    } catch (error) {
      this.settleTask(next.task, "error", error);
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
    return route.plan.targets;
  }

  async cancelActiveTask(): Promise<GaiaTask | undefined> {
    await this.init();
    // Panic stop clears the whole pipeline: drop queued messages first so the
    // drain after settling the active task doesn't immediately start one.
    this.clearPending("cancelled");

    const task = this.activeTask;
    if (!task) return undefined;

    // Mark first so in-flight event handling sees the cancellation while the
    // runtimes abort.
    task.status = "cancelled";
    await Promise.allSettled(task.targets.map((target) => this.runtimes[target]?.abort()).filter((promise): promise is Promise<void> => Boolean(promise)));
    this.settleTask(task, "cancelled");
    return task;
  }

  // Drops every queued message, marking each as the given terminal status so the
  // UI clears its chip. Used by the panic stop.
  private clearPending(status: "cancelled"): void {
    const dropped = this.pending;
    this.pending = [];
    for (const item of dropped) {
      item.task.status = status;
      item.task.endedAt = new Date().toISOString();
      this.recentTasks = [...this.recentTasks.slice(-9), item.task];
      this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.room.id, task: item.task });
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

  async renderAgentsList(): Promise<string> {
    await this.init();
    return Object.values(this.workspace.agents)
      .map((agent) => {
        const defaultMark = agent.id === this.workspace.config.defaultAgent ? " (default)" : "";
        const role = this.roomState.activeRoles[agent.id] ? ` [role: ${this.roomState.activeRoles[agent.id]}]` : "";
        return `${agent.icon} @${agent.id}${defaultMark}${role} - ${agent.displayName} [tools: ${agent.tools.join(", ") || "none"}]`;
      })
      .join("\n");
  }

  async renderRoles(agentId: string | undefined): Promise<string> {
    await this.init();
    if (!agentId) return "Usage: /roles <agent>";
    const agent = this.workspace.agents[agentId];
    if (!agent) return this.unknownAgentMessage(agentId);

    const roles = await listAgentRoles(agent);
    if (roles.length === 0) return `No roles found for @${agent.id}. Add files under ${agent.rolesDir}`;

    const activeRole = this.roomState.activeRoles[agent.id];
    return roles
      .map((role) => `${role === activeRole ? "*" : "-"} ${role}${role === activeRole ? " (active)" : ""}`)
      .join("\n");
  }

  async setRole(agentId: string | undefined, role: string | undefined): Promise<string> {
    await this.init();
    if (!role) return "Usage: /role [agent] <role|none>";
    const targetId = agentId ?? this.workspace.config.defaultAgent;
    const agent = this.workspace.agents[targetId];
    if (!agent) return this.unknownAgentMessage(targetId);

    if (role === "none") {
      delete this.roomState.activeRoles[agent.id];
      await this.room.writeState(this.roomState);
      await this.emitSnapshot();
      return `Cleared role for @${agent.id}.`;
    }

    const roles = await listAgentRoles(agent);
    if (!roles.includes(role)) {
      return `Unknown role for @${agent.id}: ${role}\nAvailable roles: ${roles.length > 0 ? roles.join(", ") : "none"}`;
    }

    this.roomState.activeRoles[agent.id] = role;
    await this.room.writeState(this.roomState);
    await this.emitSnapshot();
    return `Set @${agent.id} role to ${role}.`;
  }

  /**
   * Persists an agent's thinking level to the agent.json that is effective
   * for this workspace (a project override wins over the global file) and
   * hot-applies it: the runtime reads agent.thinking live on the next turn,
   * so no session or controller rebuild is needed.
   */
  async setAgentThinking(agentId: string, level: string): Promise<string> {
    const levels = sdkThinkingLevels();
    if (level !== "" && !levels.includes(level)) {
      throw new Error(`Invalid thinking level: ${level}. Use one of: ${levels.join(", ")}`);
    }
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));

    const configPath = agent.projectConfigPath ?? agent.configPath;
    const config = ((await readJsonFile(configPath)) ?? {}) as Record<string, unknown>;
    if (level === "") delete config.thinking;
    else config.thinking = level;
    await writeJsonFile(configPath, config);

    agent.thinking = level === "" ? undefined : (level as AgentDefinition["thinking"]);
    await this.emitSnapshot();
    return `Set @${agent.id} thinking to ${level || "unset"}.`;
  }

  private async runAgentTask(task: GaiaTask, text: string, options: SendMessageOptions = {}): Promise<void> {
    // Monad rooms route a plain message through the engine instead of a single
    // agent turn. Detected the same way as in sendMessage so targets and run
    // path agree.
    if (this.isMonadMessage(text, options)) {
      await this.runMonadTask(task, text, options);
      return;
    }

    const channel = options.channel === "voice" ? "voice" : undefined;
    if (options.recordUserMessage !== false) {
      const userEvent = await this.room.addUserMessage(text, task.targets, channel);
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.room.id, event: userEvent });
    }

    // Targets still to run; the in-flight one stays here until it completes, so a
    // crash/kill leaves a pendingTurn that resumes the unfinished work.
    const remaining = [...task.targets];
    for (const target of task.targets) {
      if (this.taskCancelled(task)) {
        await this.clearPendingTurn();
        return;
      }
      const agent = this.workspace.agents[target];
      const runtime = this.runtimes[target];
      const cursor = this.roomState.agentCursors[target] ?? 0;
      const { events, nextCursor } = await this.room.eventsAfterCursor(cursor);
      const activeRoleName = this.roomState.activeRoles[target];
      const activeRole = activeRoleName ? await resolveAgentRole(agent, activeRoleName) : undefined;

      if (activeRoleName && !activeRole) {
        this.emit({
          type: "task-error",
          workspaceId: this.workspaceId,
          roomId: this.room.id,
          task,
          error: `Active role not found for @${agent.id}: ${activeRoleName}`,
        });
      }

      // Record the in-flight turn on disk BEFORE it streams, so an interruption
      // (crash, kill, abrupt shutdown) leaves a resumable marker — no progress lost.
      await this.markPendingTurn(task, text, remaining, target, channel);
      let lastFlush = 0;

      let turn: Awaited<ReturnType<typeof runAgentTurn>>;
      try {
        turn = await runAgentTurn({
          runtime,
          input: { roomId: this.room.id, message: text, transcript: events, activeRole, channel: options.channel, thinking: options.thinking },
          isCancelled: () => this.taskCancelled(task),
          onEvent: (event) => this.emit(this.toUiEvent(task.id, agent.id, event)),
          onProgress: async (reply) => {
            const now = Date.now();
            if (now - lastFlush < PARTIAL_FLUSH_MS) return;
            lastFlush = now;
            await this.flushPartialReply(reply);
          },
        });
      } catch (error) {
        // Terminal failure: the runtime threw (e.g. an upstream error). The error
        // is the recorded outcome (the caller settles the task as "error"), NOT
        // lost progress — so PRESERVE any partial that streamed, then CLEAR the
        // marker. Leaving it would make init() replay an already-failed turn on
        // every restart — a poison pill (see no-progress-lost: resume interrupted
        // work, don't re-run terminally-failed work).
        const partial = this.roomState.pendingTurn?.partialReply ?? "";
        if (partial) await this.commitTurnReply(agent.id, partial, {}, channel, nextCursor);
        await this.clearPendingTurn();
        throw error;
      }

      // Cancelled (user stop) or interrupted mid-stream: PRESERVE whatever was
      // produced — never discard it — then stop. The marker is cleared because a
      // user cancel is a deliberate stop, not a resume.
      if (turn.cancelled || this.taskCancelled(task)) {
        await this.commitTurnReply(agent.id, turn.reply, turn.details, channel, nextCursor);
        await this.clearPendingTurn();
        return;
      }

      await this.commitTurnReply(agent.id, turn.reply, turn.details, channel, nextCursor);
      remaining.shift();
    }

    await this.clearPendingTurn();
    if (!this.taskCancelled(task)) this.settleTask(task, "complete");
  }

  // Append the (possibly partial) reply, persist its runtime details, and advance
  // the agent's cursor — the single commit path for both a completed turn and a
  // preserved-on-interruption one.
  private async commitTurnReply(
    agentId: string,
    reply: string,
    details: RuntimeMessageDetails,
    channel: "voice" | undefined,
    nextCursor: number,
  ): Promise<void> {
    let appended = 0;
    if (reply.trim()) {
      const agentEvent = await this.room.addAgentMessage(agentId, reply.trim(), channel);
      this.persistRuntimeDetails(agentEvent, details);
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.room.id, event: this.withRuntimeDetails(agentEvent) });
      appended = 1;
    }
    // The room is single-writer while a task runs, so the new cursor is the line
    // count at read time plus this agent's own reply.
    this.roomState.agentCursors[agentId] = nextCursor + appended;
    await this.room.writeState(this.roomState);
  }

  private async markPendingTurn(task: GaiaTask, prompt: string, remaining: string[], agentId: string, channel: "voice" | undefined): Promise<void> {
    this.roomState.pendingTurn = {
      id: task.id,
      prompt,
      targets: [...remaining],
      agentId,
      partialReply: "",
      ...(channel ? { channel } : {}),
      startedAt: new Date().toISOString(),
    };
    await this.room.writeState(this.roomState);
  }

  // Throttled durable flush of the reply streamed so far (throttle lives in the caller).
  private async flushPartialReply(reply: string): Promise<void> {
    if (!this.roomState.pendingTurn) return;
    this.roomState.pendingTurn.partialReply = reply;
    await this.room.writeState(this.roomState);
  }

  private async clearPendingTurn(): Promise<void> {
    if (!this.roomState.pendingTurn) return;
    delete this.roomState.pendingTurn;
    await this.room.writeState(this.roomState);
  }

  // Resume a turn that a prior process left in-flight (its pendingTurn survived).
  // Preserve whatever streamed before the interruption, then re-dispatch the
  // unfinished targets so the agent CONTINUES — no progress is ever lost.
  private async resumePendingTurn(): Promise<void> {
    const pending = this.roomState.pendingTurn;
    if (!pending) return;
    // Take the marker first so a crash during resume re-marks cleanly instead of
    // looping on this stale record.
    delete this.roomState.pendingTurn;
    await this.room.writeState(this.roomState);

    if (pending.partialReply.trim()) {
      const cursor = this.roomState.agentCursors[pending.agentId] ?? 0;
      const { nextCursor } = await this.room.eventsAfterCursor(cursor);
      // Details weren't durably captured mid-turn; preserve the text (the progress).
      await this.commitTurnReply(pending.agentId, pending.partialReply, {}, pending.channel, nextCursor);
    }

    if (pending.targets.length > 0) {
      // The user prompt is already on disk — replay it to the unfinished targets
      // without re-recording it. This re-enters the normal turn path (and re-marks
      // a fresh pendingTurn), so an interrupted resume is itself resumable.
      await this.sendMessage(pending.prompt, {
        targets: pending.targets,
        recordUserMessage: false,
        ...(pending.channel ? { channel: pending.channel } : {}),
      });
    }
  }

  // A monad room turns a plain user message into a coordinated loop. True only
  // when this room has an active monad, a summon host is available to run the
  // steps, the host did not pin explicit targets (voice/summon), and the user
  // did not @mention a specific agent (which addresses that agent directly).
  private isMonadMessage(text: string, options: SendMessageOptions): boolean {
    if (!this.roomState.monad || !this.options.summonHost) return false;
    if (options.targets) return false;
    return !this.hasExplicitMention(text);
  }

  private hasExplicitMention(text: string): boolean {
    for (const match of text.matchAll(/@([a-z0-9_-]+)/gi)) {
      if (this.workspace.agents[match[1].toLowerCase()]) return true;
    }
    return false;
  }

  // The agent that authors a monad room's single final answer.
  private monadAuthor(): string {
    const monad = this.roomState.monad;
    return monad?.coordinatorAgentId ?? monad?.slots[0]?.agentId ?? this.workspace.config.defaultAgent;
  }

  // Runs the monad engine over a user message: each step is a real summon (a
  // visible child room), and only the single final answer is posted to this
  // room ("answer as one"). Never throws — settles its own task.
  private async runMonadTask(task: GaiaTask, text: string, options: SendMessageOptions): Promise<void> {
    try {
      const monad = this.roomState.monad;
      const summonHost = this.options.summonHost;
      if (!monad || !summonHost) {
        this.settleTask(task, "error", new Error("This room is not a monad room."));
        return;
      }

      if (options.recordUserMessage !== false) {
        const userEvent = await this.room.addUserMessage(text, task.targets);
        this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.room.id, event: userEvent });
      }

      const engine = new MonadEngine({
        config: monad,
        parentRoomId: this.room.id,
        dispatch: (agentId, stepTask) => summonHost.summonAndWait(this.room.id, agentId, stepTask),
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
        const agentEvent = await this.room.addAgentMessage(this.monadAuthor(), final);
        this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.room.id, event: this.withRuntimeDetails(agentEvent) });
      }
      this.settleTask(task, "complete");
    } catch (error) {
      if (this.taskCancelled(task)) return;
      this.settleTask(task, "error", error);
    }
  }

  // Cancellation mutates task.status from another call path mid-turn; a
  // method call keeps TypeScript from narrowing the comparison away.
  private taskCancelled(task: GaiaTask): boolean {
    return task.status === "cancelled";
  }

  private toUiEvent(taskId: string, agentId: string, event: AgentEvent): GaiaUiEvent {
    const base = { workspaceId: this.workspaceId, roomId: this.room.id, taskId, agentId };
    switch (event.type) {
      case "model-info":
        return { ...base, type: "model-info", provider: event.provider, modelId: event.modelId, subscription: event.subscription };
      case "text-delta":
        return { ...base, type: "text-delta", delta: event.delta };
      case "thinking-start":
        return { ...base, type: "thinking-start" };
      case "thinking-delta":
        return { ...base, type: "thinking-delta", delta: event.delta };
      case "thinking-end":
        return { ...base, type: "thinking-end", content: event.content };
      case "tool-start":
        return { ...base, type: "tool-start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args };
      case "tool-update":
        return { ...base, type: "tool-update", toolName: event.toolName, toolCallId: event.toolCallId, partialResult: event.partialResult };
      case "tool-end":
        return { ...base, type: "tool-end", toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError };
    }
  }

  private async runThinkingCommand(agentId: string | undefined, level: string | undefined): Promise<string> {
    const target = agentId ?? this.workspace.config.defaultAgent;
    const agent = this.workspace.agents[target];
    if (!agent) return this.unknownAgentMessage(target);
    if (!level) {
      return `Usage: /thinking [agent] <${sdkThinkingLevels().join("|")}>\n@${agent.id} thinking is ${agent.thinking ?? "off"}.`;
    }
    try {
      // The host hook scopes the change to an active voice call when there is
      // one; without a hook (or outside calls) it persists via setAgentThinking.
      if (this.options.setThinking) return await this.options.setThinking(agent.id, level);
      return await this.setAgentThinking(agent.id, level);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  // Runs a slash command for an already-active task (created by startTask).
  private async runCommand(task: GaiaTask, command: ReturnType<typeof parseCommand>): Promise<void> {
    try {
      let text = "";
      if (command.type === "help") text = HELP_TEXT;
      if (command.type === "agents") text = await this.renderAgentsList();
      if (command.type === "roles") text = await this.renderRoles(command.agent);
      if (command.type === "role") text = await this.setRole(command.agent, command.role);
      if (command.type === "thinking") text = await this.runThinkingCommand(command.agent, command.level);
      if (command.type === "summon") text = await this.runSummonCommand(command.agent, command.task);
      if (command.type === "setup") text = await this.runSetupCommand(command);
      if (command.type === "clear") text = await this.runClearCommand();
      if (command.type === "fork") text = await this.runForkCommand();
      if (command.type === "unknown") text = `Unknown command: /${command.command}. Try /help.`;

      const event: RoomEvent = { id: `system_${task.id}`, timestamp: new Date().toISOString(), author: "system", text };
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.room.id, event });
      this.settleTask(task, "complete");
    } catch (error) {
      this.settleTask(task, "error", error);
    }
  }

  // /clear: wipe the room transcript, reset per-agent cursors + cached runtime
  // details, and drop every harness's in-memory session for this room so the
  // next turn starts from a blank slate. Active role assignments are kept (they
  // are configuration, not conversation).
  private async runClearCommand(): Promise<string> {
    for (const runtime of Object.values(this.runtimes)) runtime.resetRoom(this.room.id);
    await this.room.clearTranscript();
    this.roomState.agentCursors = {};
    this.roomState.runtimeDetails = {};
    await this.room.writeState(this.roomState);
    this.recentTasks = [];
    await this.emitSnapshot();
    return "Cleared room history and reset all agent sessions.";
  }

  // /fork: branch this room into a new sibling room. Copies the transcript
  // verbatim and carries role assignments, but RESETS the per-agent cursors so
  // the branch's first turn replays the whole transcript.
  //
  // Why reset, not copy, the cursors: a fork starts with fresh harness sessions
  // — no Pi session dir, Claude --resume id, or Codex thread is carried, because
  // none of those can be branched (and replaying the transcript is the one
  // mechanism that works for every harness). The transcript IS how each agent
  // rebuilds context on its first turn. Copying the cursors-at-end (as the old
  // copy-state-verbatim did) pointed every agent past the end of the copied
  // history, leaving the branch amnesiac. Reset → replay → continuity.
  private async runForkCommand(): Promise<string> {
    const target = this.nextForkId(this.room.id);
    const dstDir = join(this.workspace.roomsDir, target);
    await mkdir(dstDir, { recursive: true });
    try {
      await copyFile(join(this.room.dir, "transcript.jsonl"), join(dstDir, "transcript.jsonl"));
    } catch {
      // Never-written transcript — nothing to copy; the branch starts empty.
    }
    const forked: RoomState = { activeRoles: { ...this.roomState.activeRoles }, agentCursors: {}, runtimeDetails: {} };
    await writeRoomState(roomStatePath(this.workspace.roomsDir, target), forked);
    await this.emitSnapshot();
    return `Forked this room to '${target}'. Select it from the rooms list to continue the branch.`;
  }

  private nextForkId(base: string): string {
    const exists = (id: string): boolean => existsSync(join(this.workspace.roomsDir, id));
    let candidate = `${base}-fork`;
    let n = 2;
    while (exists(candidate)) candidate = `${base}-fork-${n++}`;
    return candidate;
  }

  private createTask(text: string, targets: string[]): GaiaTask {
    return {
      id: newId("task"),
      roomId: this.room.id,
      text,
      targets,
      status: "running",
      startedAt: new Date().toISOString(),
    };
  }

  private settleTask(task: GaiaTask, status: "complete" | "error" | "cancelled", error?: unknown): void {
    task.status = status;
    task.endedAt = new Date().toISOString();
    if (error !== undefined) task.error = error instanceof Error ? error.message : String(error);
    this.recentTasks = [...this.recentTasks.slice(-9), task];
    if (this.activeTask?.id === task.id) this.activeTask = undefined;
    if (status === "error") {
      this.emit({ type: "task-error", workspaceId: this.workspaceId, roomId: this.room.id, task, error: task.error ?? "" });
    } else {
      this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.room.id, task });
    }
    void this.emitSnapshot();
    // Now idle — start the next queued message, if any.
    this.drain();
  }

  private async emitSnapshot(): Promise<void> {
    this.emit({ type: "snapshot", workspaceId: this.workspaceId, roomId: this.room.id, snapshot: await this.getSnapshot() });
  }

  private withRuntimeDetails(event: RoomEvent): UiRoomEvent {
    if (event.author === "user") return event;
    const details = this.roomState.runtimeDetails[event.id];
    if (!details) return event;
    return {
      ...event,
      ...(details.model ? { _model: details.model } : {}),
      ...(details.thinkingStarted ? { _thinkingStarted: true } : {}),
      ...(details.thinking ? { _thinking: details.thinking } : {}),
      ...(details.tools?.length ? { _tools: details.tools } : {}),
    };
  }

  private persistRuntimeDetails(event: RoomEvent, details: RuntimeMessageDetails): void {
    if (!details.model && !details.thinkingStarted && !details.thinking && !details.tools?.length) return;
    this.roomState.runtimeDetails[event.id] = details;
    const keys = Object.keys(this.roomState.runtimeDetails);
    for (const key of keys.slice(0, Math.max(0, keys.length - RUNTIME_DETAILS_LIMIT))) {
      delete this.roomState.runtimeDetails[key];
    }
  }

  private emit(event: GaiaUiEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async agentStatuses(): Promise<AgentStatus[]> {
    return Promise.all(
      Object.values(this.workspace.agents).map(async (agent) => ({
        id: agent.id,
        displayName: agent.displayName,
        icon: agent.icon,
        modelLabel: this.runtimes[agent.id]?.modelLabel ?? "unknown",
        tools: agent.tools,
        voice: agent.voice,
        thinking: agent.thinking,
        activeRole: this.roomState.activeRoles[agent.id],
        roles: await listAgentRoles(agent),
        status: this.activeTask?.targets.includes(agent.id) ? "running" : "idle",
        isDefault: agent.id === this.workspace.config.defaultAgent,
      })),
    );
  }

  async runSummonCommand(agentId: string | undefined, task: string | undefined): Promise<string> {
    if (!this.options.summonHost) return "Summon system is not available.";
    if (!agentId || !task) return "Usage: /summon <agent> <task>";
    const agent = this.workspace.agents[agentId];
    if (!agent) return this.unknownAgentMessage(agentId);
    const childRoomId = await this.options.summonHost.summon(this.room.id, agent.id, task);
    return `Summoned @${agent.id} in room '${childRoomId}'. Open it from the rooms list (under this room) to watch or steer.`;
  }

  // /setup list|activate|status|off — load a saved multi-agent setup into a room.
  // Activation writes the monad block onto room state; this controller then
  // re-reads its own state so the next plain message routes through the engine.
  async runSetupCommand(command: { sub?: string; id?: string; room?: string }): Promise<string> {
    const sub = command.sub ?? "list";

    if (sub === "list") {
      const setups = await discoverSetups(this.workspace.rootDir);
      if (setups.length === 0) return "No setups found. Bundled setups live under setups/, global under ~/.gaia/setups/, project under .gaia/setups/.";
      return ["Available setups:", ...setups.map((s) => `  - ${s.id}${s.displayName && s.displayName !== s.id ? ` — ${s.displayName}` : ""} [${s.source}]${s.description ? `\n      ${s.description}` : ""}`)].join("\n");
    }

    if (sub === "status") {
      const monad = this.roomState.monad;
      if (!monad) return "This room is not a monad room. Activate a setup with /setup activate <id>.";
      const pool = monad.slots.map((slot) => `${slot.agentId}${slot.defaultRole ? `(${slot.defaultRole})` : ""}`).join(" · ");
      return `Monad active — policy: ${monad.policy}, maxTurns: ${monad.maxTurns}, coordinator: @${monad.coordinatorAgentId ?? monad.slots[0]?.agentId}\nPool: ${pool}`;
    }

    if (sub === "off") {
      const cleared = await deactivateMonad(this.workspace, this.room.id);
      this.roomState = await this.room.readState();
      await this.emitSnapshot();
      return cleared ? "Cleared the monad from this room. Plain messages now go to the default agent." : "This room had no active monad.";
    }

    if (sub === "activate") {
      if (!command.id) return "Usage: /setup activate <id> [room]";
      if (!this.options.summonHost) return "Setups need the summon system, which is unavailable here.";
      const targetRoom = command.room ?? this.room.id;
      try {
        const result = await activateSetup(this.workspace, command.id, targetRoom);
        if (targetRoom === this.room.id) {
          this.roomState = await this.room.readState();
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

  /** The most recent reply text from an agent in this room (for summon results). */
  async latestReplyFrom(agentId: string): Promise<string> {
    await this.init();
    const events = await this.room.recentEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.author === agentId && "text" in event) return event.text;
    }
    return "";
  }

  /**
   * Memory write for a harness subprocess (the `gaia mem` CLI). The daemon is
   * the single writer; this reuses the controller's MemoryStore so caps and the
   * secret filter match the in-process (Pi) path exactly.
   */
  async mutateAgentMemory(
    agentId: string,
    file: string,
    action: MemoryAction,
    options: { content?: string; oldText?: string },
  ): Promise<MemoryMutationResult> {
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));
    return this.memoryStore.mutate(agent.memoryDir, file, action, options);
  }

  private unknownAgentMessage(agentId: string): string {
    return `Unknown agent: @${agentId}\nAvailable agents: ${Object.keys(this.workspace.agents)
      .map((id) => `@${id}`)
      .join(", ")}`;
  }
}
