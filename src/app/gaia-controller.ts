import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition } from "../agents/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import { Room } from "../room/room.js";
import { defaultRoomState, type RoomState } from "../room/state.js";
import type { RoomEvent } from "../room/transcript.js";
import { planMentionRoute } from "../router/mention-router.js";
import { listAgentRoles, resolveAgentRole, type ResolvedRole } from "../roles/roles.js";
import { createAgentRuntime } from "../runtime/runtime-factory.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { Workspace } from "../workspace/types.js";
import { HELP_TEXT, parseCommand, SLASH_COMMANDS } from "./commands.js";

export interface AgentStatus {
  id: string;
  displayName: string;
  icon: string;
  modelLabel: string;
  tools: string[];
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
    events: RoomEvent[];
    state: RoomState;
  };
  rooms: RoomSummary[];
  commands: typeof SLASH_COMMANDS;
  agents: AgentStatus[];
  tasks: GaiaTask[];
}

export type GaiaUiEvent =
  | { type: "snapshot"; workspaceId: string; roomId: string; snapshot: GaiaSnapshot }
  | { type: "room-event"; workspaceId: string; roomId: string; event: RoomEvent }
  | { type: "task-start"; workspaceId: string; roomId: string; task: GaiaTask }
  | { type: "text-delta"; workspaceId: string; roomId: string; taskId: string; agentId: string; delta: string }
  | { type: "thinking-delta"; workspaceId: string; roomId: string; taskId: string; agentId: string; delta: string }
  | { type: "tool-start"; workspaceId: string; roomId: string; taskId: string; agentId: string; toolName: string; toolCallId?: string; args?: unknown }
  | { type: "tool-update"; workspaceId: string; roomId: string; taskId: string; agentId: string; toolName: string; toolCallId?: string; partialResult?: unknown }
  | { type: "tool-end"; workspaceId: string; roomId: string; taskId: string; agentId: string; toolName: string; toolCallId?: string; result?: unknown; isError: boolean }
  | { type: "task-end"; workspaceId: string; roomId: string; task: GaiaTask }
  | { type: "task-error"; workspaceId: string; roomId: string; task: GaiaTask; error: string }
  | { type: "settings-saved"; workspaceId?: string; roomId?: string; fileId: string };

export interface GaiaControllerOptions {
  cwd: string;
  workspaceId: string;
  workspace: Workspace;
  memoryStore?: MemoryStore;
  runtimeFactory?: (agent: AgentDefinition) => AgentRuntime;
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
        events,
        state: this.roomState,
      },
      rooms: await this.listRooms(),
      commands: SLASH_COMMANDS,
      agents: this.agentStatuses(),
      tasks: [...this.recentTasks, ...(this.activeTask ? [this.activeTask] : [])],
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

  async sendMessage(text: string): Promise<GaiaTask> {
    await this.init();
    if (this.activeTask) throw new Error(`Room already has an active task: ${this.activeTask.id}`);

    const command = parseCommand(text);
    if (command.type !== "message") {
      return this.runCommandTask(text, command);
    }

    const route = planMentionRoute(text, Object.keys(this.workspace.agents), this.workspace.config.defaultAgent);
    if (!route.ok) {
      throw new Error(
        `Unknown agent: ${route.unknown.map((id) => `@${id}`).join(", ")}. Available agents: ${Object.keys(this.workspace.agents)
          .map((id) => `@${id}`)
          .join(", ")}`,
      );
    }

    const task = this.createTask(text, route.plan.targets);
    this.activeTask = task;
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.room.id, task });

    void this.runAgentTask(task, text).catch((error) => {
      if (this.cancelledTaskIds.has(task.id)) return;
      this.failTask(task, error);
    });

    return task;
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

  private async runAgentTask(task: GaiaTask, text: string): Promise<void> {
    const userEvent: RoomEvent = {
      timestamp: new Date().toISOString(),
      author: "user",
      targets: task.targets,
      text,
    };
    await this.room.addUserMessage(text, task.targets);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.room.id, event: userEvent });

    for (const target of task.targets) {
      if (this.cancelledTaskIds.has(task.id)) return;
      const agent = this.workspace.agents[target];
      const runtime = this.runtimes[target];
      const cursor = this.roomState.agentCursors[target] ?? 0;
      const { events } = await this.room.eventsAfterCursor(cursor);
      const activeRoleName = this.roomState.activeRoles[target];
      const activeRole = activeRoleName ? await resolveAgentRole(agent, activeRoleName) : undefined;
      let reply = "";

      if (activeRoleName && !activeRole) {
        this.emit({
          type: "task-error",
          workspaceId: this.workspaceId,
          roomId: this.room.id,
          task,
          error: `Active role not found for @${agent.id}: ${activeRoleName}`,
        });
      }

      for await (const event of runtime.send({ roomId: this.room.id, message: text, transcript: events, activeRole })) {
        if (this.cancelledTaskIds.has(task.id)) return;
        if (event.type === "text-delta") {
          reply += event.delta;
          this.emit({ type: "text-delta", workspaceId: this.workspaceId, roomId: this.room.id, taskId: task.id, agentId: agent.id, delta: event.delta });
          continue;
        }
        if (event.type === "thinking-delta") {
          this.emit({ type: "thinking-delta", workspaceId: this.workspaceId, roomId: this.room.id, taskId: task.id, agentId: agent.id, delta: event.delta });
          continue;
        }
        if (event.type === "tool-start") {
          this.emit({
            type: "tool-start",
            workspaceId: this.workspaceId,
            roomId: this.room.id,
            taskId: task.id,
            agentId: agent.id,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
          });
          continue;
        }
        if (event.type === "tool-update") {
          this.emit({
            type: "tool-update",
            workspaceId: this.workspaceId,
            roomId: this.room.id,
            taskId: task.id,
            agentId: agent.id,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            partialResult: event.partialResult,
          });
          continue;
        }
        this.emit({
          type: "tool-end",
          workspaceId: this.workspaceId,
          roomId: this.room.id,
          taskId: task.id,
          agentId: agent.id,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
        });
      }

      if (this.cancelledTaskIds.has(task.id)) return;
      if (reply.trim()) {
        const agentEvent: RoomEvent = { timestamp: new Date().toISOString(), author: agent.id, text: reply.trim() };
        await this.room.addAgentMessage(agent.id, reply.trim());
        this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.room.id, event: agentEvent });
      }

      this.roomState.agentCursors[agent.id] = await this.room.eventCursor();
      await this.room.writeState(this.roomState);
    }

    if (!this.cancelledTaskIds.has(task.id)) this.completeTask(task);
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
      if (command.type === "quit") text = "`/quit` is only available in the terminal UI.";
      if (command.type === "unknown") text = `Unknown command: /${command.command}. Try /help.`;

      const event: RoomEvent = { timestamp: new Date().toISOString(), author: "system", text };
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
