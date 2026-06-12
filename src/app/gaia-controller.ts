import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition } from "../agents/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import { Room } from "../room/room.js";
import { defaultRoomState, type RoomState, type RuntimeMessageDetails, type RuntimeToolDetails } from "../room/state.js";
import type { RoomEvent } from "../room/transcript.js";
import { planMentionRoute } from "../router/mention-router.js";
import { listAgentRoles, resolveAgentRole, type ResolvedRole } from "../roles/roles.js";
import { createAgentRuntime } from "../runtime/runtime-factory.js";
import type { AgentEvent, AgentRuntime } from "../runtime/types.js";
import type { Workspace } from "../workspace/types.js";
import { HELP_TEXT, parseCommand, SLASH_COMMANDS } from "./commands.js";
import { sdkThinkingLevels } from "./settings-hints.js";
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
  status: "idle" | "running" | "error";
  isDefault: boolean;
}

export interface GaiaTask {
  id: string;
  roomId: string;
  text: string;
  targets: string[];
  status: "running" | "complete" | "error" | "cancelled";
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
}

export interface GaiaSnapshot {
  workspace: {
    id: string;
    rootDir: string;
    dir: string;
    configPath: string;
    defaultAgent: string;
  };
  room: {
    id: string;
    transcriptPath: string;
    statePath: string;
    events: UiRoomEvent[];
    state: RoomState;
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
  cwd: string;
  workspaceId: string;
  workspace: Workspace;
  memoryStore?: MemoryStore;
  runtimeFactory?: (agent: AgentDefinition) => AgentRuntime;
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

export class GaiaController {
  private readonly room: Room;
  private readonly memoryStore: MemoryStore;
  private readonly runtimes: Record<string, AgentRuntime>;
  private readonly listeners = new Set<(event: GaiaUiEvent) => void>();
  private roomState: RoomState = defaultRoomState();
  private activeTask: GaiaTask | undefined;
  private recentTasks: GaiaTask[] = [];
  private cancelledTaskIds = new Set<string>();
  private initialized = false;

  constructor(private readonly options: GaiaControllerOptions) {
    this.memoryStore = options.memoryStore ?? new MemoryStore();
    this.room = new Room(options.workspace);
    this.runtimes = Object.fromEntries(
      Object.values(options.workspace.agents).map((agent) => [
        agent.id,
        options.runtimeFactory
          ? options.runtimeFactory(agent)
          : createAgentRuntime({ cwd: options.cwd, workspace: options.workspace, agent, memoryStore: this.memoryStore }),
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

  get activeTaskId(): string | undefined {
    return this.activeTask?.id;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await Promise.all(
      Object.values(this.workspace.agents).map((agent) => this.memoryStore.init(agent.memoryPath, `${agent.displayName} Memory`)),
    );
    this.roomState = await this.room.readState();
    this.initialized = true;
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
        dir: this.workspace.dir,
        configPath: this.workspace.configPath,
        defaultAgent: this.workspace.config.defaultAgent,
      },
      room: {
        id: this.room.id,
        transcriptPath: this.room.transcriptPath,
        statePath: this.room.statePath,
        events: this.applyRuntimeDetails(events),
        state: this.roomState,
      },
      rooms: await this.listRooms(),
      commands: SLASH_COMMANDS,
      agents: this.agentStatuses(),
      tasks: [...this.recentTasks, ...(this.activeTask ? [this.activeTask] : [])],
      thinkingLevels: sdkThinkingLevels(),
    };
  }

  async listRooms(): Promise<RoomSummary[]> {
    const fallback = [{ id: this.room.id, path: join(this.workspace.roomsDir, this.room.id), isCurrent: true }];
    if (!existsSync(this.workspace.roomsDir)) return fallback;
    const entries = await readdir(this.workspace.roomsDir, { withFileTypes: true });
    const rooms = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        id: entry.name,
        path: join(this.workspace.roomsDir, entry.name),
        isCurrent: entry.name === this.room.id,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return rooms.length > 0 ? rooms : fallback;
  }

  promptPreviews() {
    return {
      slashCommands: SLASH_COMMANDS.map((command) => ({ label: command.name, description: command.description })),
      agents: Object.values(this.workspace.agents).map((agent) => {
        const defaultMark = agent.id === this.workspace.config.defaultAgent ? "default" : undefined;
        const role = this.roomState.activeRoles[agent.id] ? `role: ${this.roomState.activeRoles[agent.id]}` : undefined;
        const tools = agent.tools.length > 0 ? `tools: ${agent.tools.join(", ")}` : "no tools";
        return {
          label: agent.id,
          description: [agent.displayName, defaultMark, role, tools].filter(Boolean).join(" - "),
        };
      }),
    };
  }

  async sendMessage(text: string, options: SendMessageOptions = {}): Promise<GaiaTask> {
    await this.init();
    if (this.activeTask) throw new Error(`Room already has an active task: ${this.activeTask.id}`);

    const command = parseCommand(text);
    if (command.type !== "message") {
      return this.runCommandTask(text, command);
    }

    const targets = options.targets ?? this.routeTargets(text);
    for (const target of targets) {
      if (!this.workspace.agents[target]) throw new Error(this.unknownAgentMessage(target));
    }

    const task = this.createTask(text, targets);
    this.activeTask = task;
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.room.id, task });

    void this.runAgentTask(task, text, options).catch((error) => {
      if (this.cancelledTaskIds.has(task.id)) return;
      this.failTask(task, error);
    });

    return task;
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
    const task = this.activeTask;
    if (!task) return undefined;

    this.cancelledTaskIds.add(task.id);
    await Promise.allSettled(task.targets.map((target) => this.runtimes[target]?.abort()).filter((promise): promise is Promise<void> => Boolean(promise)));
    this.cancelTask(task);
    return task;
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
    if (!agentId || !role) return "Usage: /role <agent> <role|none>";
    const agent = this.workspace.agents[agentId];
    if (!agent) return this.unknownAgentMessage(agentId);

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

  private async runAgentTask(task: GaiaTask, text: string, options: SendMessageOptions = {}): Promise<void> {
    const channel = options.channel === "voice" ? "voice" : undefined;
    if (options.recordUserMessage !== false) {
      const userEvent = await this.room.addUserMessage(text, task.targets, channel);
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.room.id, event: userEvent });
    }

    for (const target of task.targets) {
      if (this.cancelledTaskIds.has(task.id)) return;
      const agent = this.workspace.agents[target];
      const runtime = this.runtimes[target];
      const cursor = this.roomState.agentCursors[target] ?? 0;
      const { events } = await this.room.eventsAfterCursor(cursor);
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

      const turn = await runAgentTurn({
        runtime,
        input: { roomId: this.room.id, message: text, transcript: events, activeRole, channel: options.channel, thinking: options.thinking },
        isCancelled: () => this.cancelledTaskIds.has(task.id),
        onEvent: (event) => this.emit(this.toUiEvent(task.id, agent.id, event)),
      });
      if (turn.cancelled || this.cancelledTaskIds.has(task.id)) return;

      if (turn.reply.trim()) {
        const agentEvent = await this.room.addAgentMessage(agent.id, turn.reply.trim(), channel);
        this.persistRuntimeDetails(agentEvent, turn.details);
        this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.room.id, event: this.withRuntimeDetails(agentEvent) });
      }

      this.roomState.agentCursors[agent.id] = await this.room.eventCursor();
      await this.room.writeState(this.roomState);
    }

    if (!this.cancelledTaskIds.has(task.id)) this.completeTask(task);
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

  private async runCommandTask(input: string, command: ReturnType<typeof parseCommand>): Promise<GaiaTask> {
    const task = this.createTask(input, []);
    this.activeTask = task;
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.room.id, task });

    try {
      let text = "";
      if (command.type === "help") text = HELP_TEXT;
      if (command.type === "agents") text = await this.renderAgentsList();
      if (command.type === "roles") text = await this.renderRoles(command.agent);
      if (command.type === "role") text = await this.setRole(command.agent, command.role);
      if (command.type === "unknown") text = `Unknown command: /${command.command}. Try /help.`;

      const event: RoomEvent = { id: `system_${task.id}`, timestamp: new Date().toISOString(), author: "system", text };
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.room.id, event });
      this.completeTask(task);
    } catch (error) {
      this.failTask(task, error);
    }

    return task;
  }

  private createTask(text: string, targets: string[]): GaiaTask {
    return {
      id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      roomId: this.room.id,
      text,
      targets,
      status: "running",
      startedAt: new Date().toISOString(),
    };
  }

  private completeTask(task: GaiaTask): void {
    task.status = "complete";
    task.endedAt = new Date().toISOString();
    this.recentTasks = [...this.recentTasks.slice(-9), task];
    this.activeTask = undefined;
    this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.room.id, task });
    void this.emitSnapshot();
  }

  private failTask(task: GaiaTask, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    task.status = "error";
    task.error = message;
    task.endedAt = new Date().toISOString();
    this.recentTasks = [...this.recentTasks.slice(-9), task];
    this.activeTask = undefined;
    this.emit({ type: "task-error", workspaceId: this.workspaceId, roomId: this.room.id, task, error: message });
    void this.emitSnapshot();
  }

  private cancelTask(task: GaiaTask): void {
    task.status = "cancelled";
    task.endedAt = new Date().toISOString();
    this.recentTasks = [...this.recentTasks.slice(-9), task];
    if (this.activeTask?.id === task.id) this.activeTask = undefined;
    this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.room.id, task });
    void this.emitSnapshot();
  }

  private async emitSnapshot(): Promise<void> {
    this.emit({ type: "snapshot", workspaceId: this.workspaceId, roomId: this.room.id, snapshot: await this.getSnapshot() });
  }

  private applyRuntimeDetails(events: RoomEvent[]): UiRoomEvent[] {
    return events.map((event) => this.withRuntimeDetails(event));
  }

  private withRuntimeDetails(event: RoomEvent): UiRoomEvent {
    if (event.author === "user") return event;
    const details = this.roomState.runtimeDetails[event.id] ?? this.roomState.runtimeDetails[this.legacyRuntimeDetailsKey(event)];
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
  }

  // Details written before room events carried ids were keyed by a content hash.
  private legacyRuntimeDetailsKey(event: RoomEvent): string {
    return createHash("sha256")
      .update(JSON.stringify({ timestamp: event.timestamp, author: event.author, text: event.text }))
      .digest("hex")
      .slice(0, 24);
  }

  private emit(event: GaiaUiEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private agentStatuses(): AgentStatus[] {
    return Object.values(this.workspace.agents).map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      icon: agent.icon,
      modelLabel: this.runtimes[agent.id]?.modelLabel ?? "unknown",
      tools: agent.tools,
      voice: agent.voice,
      thinking: agent.thinking,
      activeRole: this.roomState.activeRoles[agent.id],
      status: this.activeTask?.targets.includes(agent.id) ? "running" : "idle",
      isDefault: agent.id === this.workspace.config.defaultAgent,
    }));
  }

  private unknownAgentMessage(agentId: string): string {
    return `Unknown agent: @${agentId}\nAvailable agents: ${Object.keys(this.workspace.agents)
      .map((id) => `@${id}`)
      .join(", ")}`;
  }
}
