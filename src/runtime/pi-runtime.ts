import { existsSync, readFileSync } from "node:fs";
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
import { createRecallTool } from "../tools/recall-tool.js";
import type { Workspace } from "../workspace/types.js";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt-assembly.js";
import type { AgentEvent, AgentInput, AgentRuntime } from "./types.js";

export interface PiSessionLike {
  readonly model?: { provider: string; id: string } | undefined;
  readonly thinkingLevel?: string;
  setThinkingLevel?(level: string): void;
  subscribe(listener: (event: any) => void): () => void;
  prompt(text: string, options?: { source?: "interactive" }): Promise<void>;
  abort(): Promise<void>;
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
  /** Allowlist passed to Pi; includes custom tool names (memory, recall). */
  tools: string[];
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
  // Memory content last delivered to this session. Memory travels in the turn
  // prompt (only when changed), not the system prompt, so memory-tool writes
  // never force a session reload.
  lastMemoryContent?: string;
  // Thinking level the session was created with; turns without an explicit
  // override restore it (voice mode may have switched it off).
  baseThinking?: string;
}

export function piRoomSessionDir(workspace: Pick<Workspace, "roomsDir">, roomId: string, agentId: string): string {
  return join(workspace.roomsDir, roomId, "pi-sessions", agentId);
}

// Pi sessions persist "last used" model and thinking level back into the
// user's pi settings (~/.pi/agent/settings.json). GAIA controls both per
// agent.json - and voice calls toggle thinking every call - so its sessions
// must read the user's pi defaults without ever rewriting them. Reads pass
// through to the real files; writes are dropped.
function readOnlyPiSettings(cwd: string): SettingsManager {
  const paths = {
    global: join(getAgentDir(), "settings.json"),
    project: join(cwd, ".pi", "settings.json"),
  };
  return SettingsManager.fromStorage({
    withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
      const path = paths[scope];
      fn(existsSync(path) ? readFileSync(path, "utf8") : undefined);
    },
  });
}

function skillPathsKey(paths: string[]): string {
  return JSON.stringify(paths);
}

export class PiRuntime implements AgentRuntime {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly sessions = new Map<string, ManagedPiSession>();
  private readonly configuredModelLabel: string;
  private liveModelLabel: string | undefined;

  private readonly cwd: string;

  constructor(
    private readonly workspace: Workspace,
    readonly agent: AgentDefinition,
    private readonly memoryStore: MemoryStore,
    private readonly sessionFactory?: PiRuntimeSessionFactory,
  ) {
    this.cwd = workspace.rootDir;
    this.configuredModelLabel = this.resolveModelLabel();
  }

  // Reports the model the live session actually uses once a turn has run;
  // before that, the configured model or "Pi default".
  get modelLabel(): string {
    return this.liveModelLabel ?? this.configuredModelLabel;
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const managed = await this.ensureSession(input);
    const session = managed.session;
    this.applyThinkingLevel(managed, input.thinking);

    const sessionModel = session.model;
    if (sessionModel) {
      const registryModel = this.modelRegistry.find(sessionModel.provider, sessionModel.id);
      const subscription = registryModel ? this.modelRegistry.isUsingOAuth(registryModel) : false;
      this.liveModelLabel = `${sessionModel.provider}/${sessionModel.id}${subscription ? " (oauth)" : ""}`;
      yield { type: "model-info", provider: sessionModel.provider, modelId: sessionModel.id, subscription };
    }

    const memory = await this.memoryStore.promptBlock(this.agent.memoryDir);
    const memoryChanged = managed.lastMemoryContent !== memory;

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
      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start") {
        push({ type: "thinking-start" });
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
        push({ type: "thinking-delta", delta: event.assistantMessageEvent.delta });
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_end") {
        push({ type: "thinking-end", content: event.assistantMessageEvent.content });
      }
      if (event.type === "tool_execution_start") {
        push({ type: "tool-start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args });
      }
      if (event.type === "tool_execution_update") {
        push({ type: "tool-update", toolName: event.toolName, toolCallId: event.toolCallId, partialResult: event.partialResult });
      }
      if (event.type === "tool_execution_end") {
        push({ type: "tool-end", toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError });
      }
      // Pi's stream contract encodes every provider/request failure (rate
      // limit, bad key, network) as a final assistant message with
      // stopReason "error" instead of throwing - surface it as a turn
      // failure so the task settles as "error", not a silent empty reply.
      // "aborted" is the cancel path and stays non-fatal.
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
        error = new Error(event.message.errorMessage || "model request failed");
      }
    });

    const prompt = buildTurnPrompt({
      roomId: input.roomId,
      agentId: this.agent.id,
      message: input.message,
      events: input.transcript,
      memory: memoryChanged ? memory : undefined,
      channel: input.channel,
    });
    session
      .prompt(prompt, { source: "interactive" })
      .then(() => {
        managed.lastMemoryContent = memory;
      })
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

  // Applies a per-turn thinking override (voice mode forces "off") and
  // restores the agent's own level on turns without one. Reading
  // agent.thinking live means a settings change hot-applies on the next
  // turn without recreating the session.
  private applyThinkingLevel(managed: ManagedPiSession, override: string | undefined): void {
    const session = managed.session;
    if (!session.setThinkingLevel) return;
    const target = override ?? this.agent.thinking ?? managed.baseThinking;
    if (target === undefined || session.thinkingLevel === target) return;
    session.setThinkingLevel(target);
  }

  async abort(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((managed) => managed.session.abort()));
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
          if (!this.sessionFactory) await existing.loader.reload();
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
    const roomDir = join(this.workspace.roomsDir, roomId);
    const customTools = [
      ...(this.agent.tools.includes("memory") ? [createMemoryTool(this.memoryStore, this.agent)] : []),
      ...(this.agent.tools.includes("recall")
        ? [createRecallTool(join(roomDir, "transcript.jsonl"), join(roomDir, "recall.db"), roomId)]
        : []),
    ];
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
    if (!this.sessionFactory) await loader.reload();

    const sessionDir = piRoomSessionDir(this.workspace, roomId, this.agent.id);
    const { session, modelFallbackMessage } = this.sessionFactory
      ? await this.sessionFactory({
          cwd: this.cwd,
          roomId,
          agent: this.agent,
          loader,
          systemPromptRef,
          skillPaths,
          tools: this.agent.tools,
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
          // Pi treats `tools` as an allowlist over built-in AND custom tools,
          // so the custom tool names (memory, recall) must stay in the list.
          tools: this.agent.tools,
          customTools,
          resourceLoader: loader,
          sessionManager: SessionManager.continueRecent(this.cwd, sessionDir),
          settingsManager: readOnlyPiSettings(this.cwd),
        });

    if (modelFallbackMessage) console.warn(modelFallbackMessage);

    const managed: ManagedPiSession = {
      session: session as PiSessionLike,
      loader,
      systemPromptRef,
      skillPathsKey: key,
    };
    const baseThinking = (session as PiSessionLike).thinkingLevel;
    if (baseThinking !== undefined) managed.baseThinking = baseThinking;
    return managed;
  }

  private async buildSystemPrompt(input: AgentInput): Promise<string> {
    const [soulText, intentText] = await Promise.all([
      readFile(this.agent.soulPath, "utf8"),
      this.readOptional(this.agent.projectIntentPath),
    ]);

    return buildSystemPrompt({
      agent: this.agent,
      soulText,
      role: input.activeRole,
      intentText,
      contextFiles: this.workspace.contextFiles,
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
