import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { GaiaConfig } from "../config/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { PersonaId, Mode } from "../personas/types.js";
import { GaiaSessionFactory, type PersonaSessionBundle } from "../pi/session-factory.js";
import { HELP_TEXT, parseCommand } from "../tui/commands.js";
import { AppView } from "../tui/app-view.js";
import { assistantHeader, toolLine } from "../tui/message-renderer.js";
import { routeMessage } from "./mode-router.js";

export class GaiaApp {
  private mode: Mode = "gaia";
  private sessions!: Record<PersonaId, PersonaSessionBundle>;
  private readonly view = new AppView();

  constructor(
    private readonly cwd: string,
    private readonly config: GaiaConfig,
    private readonly memoryStore: MemoryStore,
  ) {}

  async start(): Promise<void> {
    await this.memoryStore.init();
    this.sessions = await new GaiaSessionFactory(this.cwd, this.config, this.memoryStore).createAll();
    this.view.start();
    this.view.line("GAIA Pi Wrapper — /help for commands, /quit to exit.");

    try {
      while (true) {
        const input = await this.view.prompt(this.mode, this.sessions[this.mode].modelLabel);
        const command = parseCommand(input);
        if (command.type === "quit") break;
        if (command.type === "help") {
          this.view.line(HELP_TEXT);
          continue;
        }
        if (command.type === "unknown") {
          this.view.line(`Unknown command: /${command.command}. Try /help.`);
          continue;
        }
        if (command.type === "mode") {
          this.mode = command.mode;
          this.view.line(`Switched to ${command.mode}.`);
          continue;
        }
        if (!command.text.trim()) continue;
        await routeMessage(this.mode, command.text, this.config, (persona, message) => this.sendToPersona(persona, message));
      }
    } finally {
      this.view.close();
      for (const bundle of Object.values(this.sessions)) bundle.session.dispose();
    }
  }

  private async sendToPersona(persona: PersonaId, message: string): Promise<string> {
    const bundle = this.sessions[persona];
    const session = bundle.session;
    let collected = "";
    this.view.write(assistantHeader(persona) + "\n");

    const unsubscribe = this.subscribeForConsole(session, (delta) => {
      collected += delta;
      this.view.write(delta);
    });

    try {
      await session.prompt(message, { source: "interactive" });
      this.view.line("\n");
      return collected.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.view.line(`\n[error] ${message}\n`);
      return collected.trim();
    } finally {
      unsubscribe();
    }
  }

  private subscribeForConsole(session: AgentSession, onText: (delta: string) => void): () => void {
    return session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        onText(event.assistantMessageEvent.delta);
      }
      if (!this.config.ui.showToolEvents) return;
      if (event.type === "tool_execution_start") {
        this.view.write(toolLine("start", event.toolName));
      }
      if (event.type === "tool_execution_end") {
        this.view.write(toolLine("end", event.toolName, event.isError ? "(error)" : "(ok)"));
      }
    });
  }
}
