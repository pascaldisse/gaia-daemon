import type { AgentDefinition } from "../agents/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import { Room } from "../room/room.js";
import { planMentionRoute } from "../router/mention-router.js";
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
          const transcript = await this.room.recentEvents();
          const reply = await this.sendToAgent(agent, runtime, command.text, transcript);
          if (reply.trim()) await this.room.addAgentMessage(agent.id, reply.trim());
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
  ): Promise<string> {
    let collected = "";
    this.view.write(assistantHeader(agent) + "\n");

    try {
      for await (const event of runtime.send({ roomId: this.room.id, message, transcript })) {
        if (event.type === "text-delta") {
          collected += event.delta;
          this.view.write(event.delta);
          continue;
        }
        if (event.type === "tool-start") {
          this.view.write(toolLine("start", event.toolName));
          continue;
        }
        this.view.write(toolLine("end", event.toolName, event.isError ? "(error)" : "(ok)"));
      }
      this.view.line("\n");
      return collected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.view.line(`\n[error] ${message}\n`);
      return collected;
    }
  }

  private promptPreviews() {
    return {
      slashCommands: SLASH_COMMANDS.map((command) => ({ label: command.name, description: command.description })),
      agents: Object.values(this.workspace.agents).map((agent) => {
        const defaultMark = agent.id === this.workspace.config.defaultAgent ? "default" : undefined;
        const tools = agent.tools.length > 0 ? `tools: ${agent.tools.join(", ")}` : "no tools";
        return {
          label: agent.id,
          description: [agent.displayName, defaultMark, tools].filter(Boolean).join(" — "),
        };
      }),
    };
  }

  private renderAgentsLine(): string {
    return `Agents: ${Object.values(this.workspace.agents)
      .map((agent) => `${agent.icon} @${agent.id}`)
      .join("  ")}`;
  }

  private renderAgentsList(): string {
    return Object.values(this.workspace.agents)
      .map((agent) => {
        const defaultMark = agent.id === this.workspace.config.defaultAgent ? " (default)" : "";
        return `${agent.icon} @${agent.id}${defaultMark} — ${agent.displayName} [tools: ${agent.tools.join(", ") || "none"}]`;
      })
      .join("\n");
  }
}
