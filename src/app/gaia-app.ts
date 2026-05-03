import type { AgentDefinition } from "../agents/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import { Room } from "../room/room.js";
import { defaultRoomState, type RoomState } from "../room/state.js";
import { planMentionRoute } from "../router/mention-router.js";
import { listAgentRoles, resolveAgentRole, type ResolvedRole } from "../roles/roles.js";
import { createAgentRuntime } from "../runtime/runtime-factory.js";
import type { AgentRuntime } from "../runtime/types.js";
import { AppView } from "../tui/app-view.js";
import { HELP_TEXT, parseCommand, SLASH_COMMANDS } from "../tui/commands.js";
import { assistantHeader, toolLine } from "../tui/message-renderer.js";
import type { Workspace } from "../workspace/types.js";

export class GaiaApp {
  private readonly room: Room;
  private readonly runtimes: Record<string, AgentRuntime>;
  private readonly view = new AppView();
  private roomState: RoomState = defaultRoomState();

  constructor(
    private readonly cwd: string,
    private readonly workspace: Workspace,
    private readonly memoryStore: MemoryStore,
  ) {
    this.room = new Room(workspace);
    this.runtimes = Object.fromEntries(
      Object.values(workspace.agents).map((agent) => [
        agent.id,
        createAgentRuntime({ cwd: this.cwd, workspace: this.workspace, agent, memoryStore: this.memoryStore }),
      ]),
    );
  }

  async start(): Promise<void> {
    await Promise.all(
      Object.values(this.workspace.agents).map((agent) => this.memoryStore.init(agent.memoryPath, `${agent.displayName} Memory`)),
    );
    this.roomState = await this.room.readState();

    this.view.start();
    this.view.line("GAIA project room — /help for commands, /quit to exit.");
    this.view.line(this.renderAgentsLine());

    try {
      while (true) {
        const input = await this.view.prompt(this.workspace.config.room, this.workspace.config.defaultAgent, this.promptPreviews());
        const command = parseCommand(input);

        if (command.type === "quit") break;
        if (command.type === "help") {
          this.view.line(HELP_TEXT);
          continue;
        }
        if (command.type === "agents") {
          this.view.line(this.renderAgentsList());
          continue;
        }
        if (command.type === "roles") {
          this.view.line(await this.renderRoles(command.agent));
          continue;
        }
        if (command.type === "role") {
          this.view.line(await this.setRole(command.agent, command.role));
          continue;
        }
        if (command.type === "unknown") {
          this.view.line(`Unknown command: /${command.command}. Try /help.`);
          continue;
        }
        if (!command.text.trim()) continue;

        const route = planMentionRoute(
          command.text,
          Object.keys(this.workspace.agents),
          this.workspace.config.defaultAgent,
        );

        if (!route.ok) {
          this.view.line(
            `Unknown agent: ${route.unknown.map((id) => `@${id}`).join(", ")}\nAvailable agents: ${Object.keys(this.workspace.agents)
              .map((id) => `@${id}`)
              .join(", ")}`,
          );
          continue;
        }

        await this.room.addUserMessage(command.text, route.plan.targets);

        for (const target of route.plan.targets) {
          const agent = this.workspace.agents[target];
          const runtime = this.runtimes[target];
          const cursor = this.roomState.agentCursors[target] ?? 0;
          const { events } = await this.room.eventsAfterCursor(cursor);
          const activeRoleName = this.roomState.activeRoles[target];
          const activeRole = activeRoleName ? await resolveAgentRole(agent, activeRoleName) : undefined;
          if (activeRoleName && !activeRole) {
            this.view.line(`Active role not found for @${agent.id}: ${activeRoleName}`);
          }

          const reply = await this.sendToAgent(agent, runtime, command.text, events, activeRole);
          if (reply.trim()) await this.room.addAgentMessage(agent.id, reply.trim());

          // Cursor is a transcript line count. Update after the turn finishes, including partial/error replies,
          // so the same room events are not injected again on the next turn.
          this.roomState.agentCursors[agent.id] = await this.room.eventCursor();
          await this.room.writeState(this.roomState);
        }
      }
    } finally {
      this.view.close();
      Object.values(this.runtimes).forEach((runtime) => runtime.dispose());
    }
  }

  private async sendToAgent(
    agent: AgentDefinition,
    runtime: AgentRuntime,
    message: string,
    transcript: Awaited<ReturnType<Room["recentEvents"]>>,
    activeRole: ResolvedRole | undefined,
  ): Promise<string> {
    let collected = "";
    this.view.write(assistantHeader(agent) + "\n");

    try {
      for await (const event of runtime.send({ roomId: this.room.id, message, transcript, activeRole })) {
        if (event.type === "text-delta") {
          collected += event.delta;
          this.view.write(event.delta);
          continue;
        }
        if (event.type === "tool-start") {
          this.view.write(toolLine("start", event.toolName));
          continue;
        }
        if (event.type === "tool-update" || event.type === "thinking-start" || event.type === "thinking-delta" || event.type === "thinking-end") {
          continue;
        }
        if (event.type === "tool-end") this.view.write(toolLine("end", event.toolName, event.isError ? "(error)" : "(ok)"));
      }
      this.view.line("\n");
      return collected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.view.line(`\n[error] ${message}\n`);
      return collected;
    }
  }

  private async renderRoles(agentId: string | undefined): Promise<string> {
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

  private async setRole(agentId: string | undefined, role: string | undefined): Promise<string> {
    if (!agentId || !role) return "Usage: /role <agent> <role|none>";
    const agent = this.workspace.agents[agentId];
    if (!agent) return this.unknownAgentMessage(agentId);

    if (role === "none") {
      delete this.roomState.activeRoles[agent.id];
      await this.room.writeState(this.roomState);
      await this.onRoleChanged(agent.id);
      return `Cleared role for @${agent.id}.`;
    }

    const roles = await listAgentRoles(agent);
    if (!roles.includes(role)) {
      return `Unknown role for @${agent.id}: ${role}\nAvailable roles: ${roles.length > 0 ? roles.join(", ") : "none"}`;
    }

    this.roomState.activeRoles[agent.id] = role;
    await this.room.writeState(this.roomState);
    await this.onRoleChanged(agent.id);
    return `Set @${agent.id} role to ${role}.`;
  }

  private async onRoleChanged(_agentId: string): Promise<void> {
    // Placeholder seam for Task 8: refresh or recreate the affected persistent runtime session.
  }

  private unknownAgentMessage(agentId: string): string {
    return `Unknown agent: @${agentId}\nAvailable agents: ${Object.keys(this.workspace.agents)
      .map((id) => `@${id}`)
      .join(", ")}`;
  }

  private activeRoleLabel(agentId: string): string | undefined {
    const role = this.roomState.activeRoles[agentId];
    return role ? `role: ${role}` : undefined;
  }

  private promptPreviews() {
    return {
      slashCommands: SLASH_COMMANDS.map((command) => ({ label: command.name, description: command.description })),
      agents: Object.values(this.workspace.agents).map((agent) => {
        const defaultMark = agent.id === this.workspace.config.defaultAgent ? "default" : undefined;
        const role = this.activeRoleLabel(agent.id);
        const tools = agent.tools.length > 0 ? `tools: ${agent.tools.join(", ")}` : "no tools";
        return {
          label: agent.id,
          description: [agent.displayName, defaultMark, role, tools].filter(Boolean).join(" — "),
        };
      }),
    };
  }

  private renderAgentsLine(): string {
    return `Agents: ${Object.values(this.workspace.agents)
      .map((agent) => `${agent.icon} @${agent.id}${this.roomState.activeRoles[agent.id] ? ` [${this.roomState.activeRoles[agent.id]}]` : ""}`)
      .join("  ")}`;
  }

  private renderAgentsList(): string {
    return Object.values(this.workspace.agents)
      .map((agent) => {
        const defaultMark = agent.id === this.workspace.config.defaultAgent ? " (default)" : "";
        const role = this.roomState.activeRoles[agent.id] ? ` [role: ${this.roomState.activeRoles[agent.id]}]` : "";
        return `${agent.icon} @${agent.id}${defaultMark}${role} — ${agent.displayName} [tools: ${agent.tools.join(", ") || "none"}]`;
      })
      .join("\n");
  }
}
