import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { resolveSkillRefs } from "../skills/skill-resolver.js";
import { createMemoryTool } from "../tools/memory-tool.js";
import type { Workspace } from "../workspace/types.js";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt-assembly.js";
import type { AgentEvent, AgentInput, AgentRuntime } from "./types.js";

export interface PiSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  subscribe(listener: (event: any) => void): () => void;
  prompt(text: string, options?: { source?: "interactive" }): Promise<void>;
  reload(): Promise<void>;
  dispose(): void;
}

export interface PiRuntimeSessionFactoryOptions {
  cwd: string;
  roomId: string;
  agent: AgentDefinition;
  loader: DefaultResourceLoader;
  systemPromptRef: { current: string };
  skillPaths: string[];
  builtInTools: string[];
  customTools: unknown[];
  model: Model<any> | undefined;
  sessionDir: string;
}

export type PiRuntimeSessionFactory = (
  options: PiRuntimeSessionFactoryOptions,
) => Promise<{ session: PiSessionLike; modelFallbackMessage?: string }>;

interface ManagedPiSession {
  session: PiSessionLike;
  loader: DefaultResourceLoader;
  systemPromptRef: { current: string };
  skillPathsKey: string;
}

export function piRoomSessionDir(workspace: Pick<Workspace, "roomsDir">, roomId: string, agentId: string): string {
  return join(workspace.roomsDir, roomId, "pi-sessions", agentId);
}

function skillPathsKey(paths: string[]): string {
  return JSON.stringify(paths);
}

export class PiRuntime implements AgentRuntime {
  readonly modelLabel: string;
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly sessions = new Map<string, ManagedPiSession>();

  constructor(
    private readonly cwd: string,
    private readonly workspace: Workspace,
    readonly agent: AgentDefinition,
    private readonly memoryStore: MemoryStore,
    private readonly sessionFactory?: PiRuntimeSessionFactory,
  ) {
    this.modelLabel = this.resolveModelLabel();
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const managed = await this.ensureSession(input);
    const session = managed.session;

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

  dispose(): void {
    for (const managed of this.sessions.values()) managed.session.dispose();
    this.sessions.clear();
  }

  private async ensureSession(input: AgentInput): Promise<ManagedPiSession> {
    const systemPrompt = await this.buildSystemPrompt(input);
    const skillResolution = input.activeRole ? resolveSkillRefs(this.workspace, input.activeRole.skills) : { paths: [], diagnostics: [] };
    for (const diagnostic of skillResolution.diagnostics) console.warn(diagnostic);

    const key = skillPathsKey(skillResolution.paths);
    const existing = this.sessions.get(input.roomId);

    if (existing && existing.skillPathsKey === key) {
      if (existing.systemPromptRef.current !== systemPrompt) {
        existing.systemPromptRef.current = systemPrompt;
        try {
          await existing.loader.reload();
          await existing.session.reload();
        } catch {
          existing.session.dispose();
          this.sessions.delete(input.roomId);
          const recreated = await this.createManagedSession(input.roomId, systemPrompt, skillResolution.paths, key);
          this.sessions.set(input.roomId, recreated);
          return recreated;
        }
      }
      return existing;
    }

    if (existing) existing.session.dispose();
    const managed = await this.createManagedSession(input.roomId, systemPrompt, skillResolution.paths, key);
    this.sessions.set(input.roomId, managed);
    return managed;
  }

  private async createManagedSession(roomId: string, systemPrompt: string, skillPaths: string[], key: string): Promise<ManagedPiSession> {
    const model = this.resolveModel();
    const builtInTools = this.agent.tools.filter((tool) => tool !== "memory");
    const customTools = this.agent.tools.includes("memory") ? [createMemoryTool(this.memoryStore, this.agent)] : [];
    const systemPromptRef = { current: systemPrompt };

    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      additionalSkillPaths: skillPaths,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => systemPromptRef.current,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const sessionDir = piRoomSessionDir(this.workspace, roomId, this.agent.id);
    const { session, modelFallbackMessage } = this.sessionFactory
      ? await this.sessionFactory({
          cwd: this.cwd,
          roomId,
          agent: this.agent,
          loader,
          systemPromptRef,
          skillPaths,
          builtInTools,
          customTools,
          model,
          sessionDir,
        })
      : await createAgentSession({
          cwd: this.cwd,
          authStorage: this.authStorage,
          modelRegistry: this.modelRegistry,
          model,
          thinkingLevel: this.agent.thinking,
          tools: builtInTools,
          customTools,
          resourceLoader: loader,
          sessionManager: SessionManager.continueRecent(this.cwd, sessionDir),
          settingsManager: SettingsManager.create(this.cwd),
        });

    if (modelFallbackMessage) console.warn(modelFallbackMessage);

    return {
      session: session as PiSessionLike,
      loader,
      systemPromptRef,
      skillPathsKey: key,
    };
  }

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
