import { readFile } from "node:fs/promises";
import type { Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "../agents/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt-assembly.js";
import { createMemoryTool } from "../tools/memory-tool.js";
import type { Workspace } from "../workspace/types.js";
import type { AgentEvent, AgentInput, AgentRuntime } from "./types.js";

export class PiRuntime implements AgentRuntime {
  readonly modelLabel: string;
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);

  constructor(
    private readonly cwd: string,
    private readonly workspace: Workspace,
    readonly agent: AgentDefinition,
    private readonly memoryStore: MemoryStore,
  ) {
    this.modelLabel = this.resolveModelLabel();
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const systemPrompt = await this.buildSystemPrompt(input);
    const model = this.resolveModel();
    const builtInTools = this.agent.tools.filter((tool) => tool !== "memory");
    const customTools = this.agent.tools.includes("memory") ? [createMemoryTool(this.memoryStore, this.agent)] : [];

    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model,
      thinkingLevel: this.agent.thinking,
      tools: builtInTools,
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.create(this.cwd),
      settingsManager: SettingsManager.create(this.cwd),
    });

    if (modelFallbackMessage) console.warn(modelFallbackMessage);

    const queue: AgentEvent[] = [];
    let done = false;
    let error: unknown;
    let notify: (() => void) | undefined;

    const push = (event: AgentEvent): void => {
      queue.push(event);
      notify?.();
      notify = undefined;
    };

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        push({ type: "text-delta", delta: event.assistantMessageEvent.delta });
      }
      if (event.type === "tool_execution_start") {
        push({ type: "tool-start", toolName: event.toolName });
      }
      if (event.type === "tool_execution_end") {
        push({ type: "tool-end", toolName: event.toolName, isError: event.isError });
      }
    });

    const prompt = buildTurnPrompt({ roomId: input.roomId, agentId: this.agent.id, message: input.message, events: input.transcript });
    session
      .prompt(prompt, { source: "interactive" })
      .catch((cause) => {
        error = cause;
      })
      .finally(() => {
        done = true;
        unsubscribe();
        session.dispose();
        notify?.();
        notify = undefined;
      });

    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      while (queue.length > 0) {
        const event = queue.shift();
        if (event) yield event;
      }
    }

    if (error) throw error;
  }

  dispose(): void {}

  private async buildSystemPrompt(input: AgentInput): Promise<string> {
    const [soulText, intentText, memory] = await Promise.all([
      readFile(this.agent.soulPath, "utf8"),
      this.readOptional(this.agent.projectIntentPath),
      this.memoryStore.readState(this.agent.memoryPath),
    ]);

    return buildSystemPrompt({
      agent: this.agent,
      soulText,
      role: input.activeRole,
      intentText,
      contextFiles: this.workspace.contextFiles,
      memory,
    });
  }

  private async readOptional(path: string | undefined): Promise<string> {
    if (!path) return "";
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }

  private resolveModel(): Model<any> | undefined {
    const provider = this.agent.model?.provider;
    const name = this.agent.model?.name;
    if (!provider || !name) return undefined;
    return this.modelRegistry.find(provider, name);
  }

  private resolveModelLabel(): string {
    const provider = this.agent.model?.provider;
    const name = this.agent.model?.name;
    if (!provider || !name) return "Pi default";
    return this.modelRegistry.find(provider, name) ? `${provider}/${name}` : "Pi default";
  }
}
