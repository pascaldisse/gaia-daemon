import type { Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime, SessionManager, } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadNativeImages } from "../../core/attachments.js";
import { type AgentDef, type AgentEvent, type CompactResult, type MessageAttachment, type Workspace, } from "../../core/types.js";
import { workspacePaths } from "../../core/paths.js";
import type { MemoryStore } from "../../domain/memory.js";
import type { ResolvedRole } from "../../domain/roles.js";
import { agentSkillNames, resolveSkillRefs } from "../../domain/skills.js";
import { agentRoster, buildPiTools } from "../tools.js";
import type { AgentInput, AgentRuntime, HarnessCapabilities, RuntimeCreateContext, RecallSearch, ResumeCreate, SummonCreate, ContextDietAccess, EndConversation, ToolResultFetch, } from "../spec.js";
import { createEventChannel } from "../events.js";
import { SessionMap } from "../sessions.js";
import { RUNNER_ENV } from "../protocol.js";
import { ModelLabel } from "../model-label.js";
import { findModelWithAlias } from "../model-aliases.js";
import { buildBaseSystemPrompt, buildTurnPromptFor, promptCacheKey, } from "../prompt.js";
import { redirectProviderFetch } from "./tools.js";
import { forwardPiEvent } from "./events.js";
import {
  loadCleanCompactionOverride,
  PiCompaction,
} from "./compaction.js";
import { hasPersistedPiSession, piRoomSessionDir, readOnlyPiSettings, skillPathsKey, toPiThinking, type PiRuntimeOptions, type PiRuntimeSessionFactory, type PiSessionLike, type PiSessionMeta, } from "./session.js";
export const PI_CAPABILITIES: HarnessCapabilities = {
  gaiaTools: ["memory", "recall", "artifact", "summon", "resume", "gaia"],
  nativeTools: ["web"],
  granularTools: true,
  supportsPermissionMode: false,
  supportsMcp: false,
  supportsSteer: true,
  supportsCompact: true,
  supportsCompactEdit: true,
  supportsForkAtMessage: true,
  supportsNativeCommands: true,
  fanOutTools: [],
};
export class PiRuntime implements AgentRuntime {
  readonly capabilities = PI_CAPABILITIES;
  readonly agent: AgentDef;
  private readonly workspace: Workspace;
  private readonly memoryStore: MemoryStore;
  private readonly sessionFactory?: PiRuntimeSessionFactory;
  private readonly summonCreate?: SummonCreate;
  private readonly resumeCreate?: ResumeCreate;
  private readonly recallSearch?: RecallSearch;
  private readonly toolResultFetch?: ToolResultFetch;
  private readonly contextDiet?: ContextDietAccess;
  private readonly endConversation?: EndConversation;
  private readonly toolProviders?: RuntimeCreateContext["toolProviders"];
  private modelRuntime!: ModelRuntime;
  private modelRegistry!: ModelRegistry;
  private readonly modelRuntimeReady: Promise<void>;
  private readonly sessions = new SessionMap<PiSessionMeta>((meta) =>
    meta.session.dispose(),
  );
  private readonly compaction: PiCompaction;
  private readonly label: ModelLabel;
  private readonly cwd: string;
  private readonly workDir: string;
  constructor(options: PiRuntimeOptions) {
    this.workspace = options.workspace;
    this.agent = options.agent;
    this.memoryStore = options.memoryStore;
    this.sessionFactory = options.sessionFactory;
    this.summonCreate = options.summonCreate;
    this.resumeCreate = options.resumeCreate;
    this.recallSearch = options.recallSearch;
    this.toolResultFetch = options.toolResultFetch;
    this.contextDiet = options.contextDiet;
    this.endConversation = options.endConversation;
    this.toolProviders = options.toolProviders;
    this.cwd = options.workspace.rootDir;
    this.workDir = process.cwd();
    this.compaction = new PiCompaction(
      this.sessions,
      async (roomId) => {
        let meta = this.sessions.get(roomId);
        if (
          !meta &&
          hasPersistedPiSession(this.workspace.rootDir, roomId, this.agent.id)
        )
          meta = await this.ensureSession(roomId, undefined);
        return meta?.session.compact ? meta.session : undefined;
      },
      this.agent.id,
      options.cleanCompactionIndexPath
        ? (roomId, agentId) =>
            loadCleanCompactionOverride(
              roomId,
              agentId,
              options.cleanCompactionIndexPath,
            )
        : undefined,
    );
    this.modelRuntimeReady = ModelRuntime.create().then((runtime) => {
      this.modelRuntime = runtime;
      this.modelRegistry = new ModelRegistry(runtime);
      this.applyCredentialProxy();
    });
    this.label = new ModelLabel(this.resolveModelLabel());
  }
  private applyCredentialProxy(): void {
    const proxyUrl = process.env[RUNNER_ENV.llmProxyUrl]?.trim();
    const token = process.env[RUNNER_ENV.daemonToken]?.trim();
    const provider = this.agent.model?.provider;
    const name = this.agent.model?.name;
    if (!proxyUrl || !token || !provider || !name) return;
    this.modelRegistry.registerProvider(provider, {
      apiKey: token,
      authHeader: true,
    });
    const realBaseUrl = findModelWithAlias(
      this.modelRegistry,
      provider,
      name,
    )?.baseUrl;
    if (realBaseUrl) redirectProviderFetch(realBaseUrl, proxyUrl);
  }
  get modelLabel(): string {
    return this.label.current;
  }
  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const meta = await this.ensureSession(
      input.roomId,
      input.activeRole,
      input.protocolThinkingLevel,
    );
    const session = meta.session;
    this.applyThinkingLevel(meta, input.thinking);
    const sessionModel = session.model;
    if (sessionModel) {
      const registryModel = this.modelRegistry.find(
        sessionModel.provider,
        sessionModel.id,
      );
      const subscription = registryModel
        ? this.modelRegistry.isUsingOAuth(registryModel)
        : false;
      const info = {
        type: "model-info",
        provider: sessionModel.provider,
        modelId: sessionModel.id,
        subscription,
      } as const;
      this.label.observe(info);
      yield info;
    }
    const channel = createEventChannel();
    const unsubscribe = session.subscribe((event) =>
      forwardPiEvent(event, session, channel),
    );
    const prompt = input.nativeCommand
      ? this.nativeCommandPrompt(meta, input.message)
      : await buildTurnPromptFor(
          this.agent,
          input,
          this.memoryStore,
          this.sessions,
          { workDir: this.workDir, rootDir: this.cwd },
        );
    const images = (await loadNativeImages(input.attachments)).map(
      ({ attachment, base64 }) => ({
        type: "image" as const,
        data: base64,
        mimeType: attachment.mime,
      }),
    );
    session
      .prompt(prompt, {
        source: "interactive",
        ...(images.length ? { images } : {}),
      })
      .catch((cause) => channel.fail(cause))
      .finally(() => {
        unsubscribe();
        channel.close();
      });
    for await (const event of channel.stream()) yield event;
  }
  private nativeCommandPrompt(meta: PiSessionMeta, message: string): string {
    const trimmed = message.trim();
    const match = /^\/([^\s]+)([\s\S]*)$/.exec(trimmed);
    if (!match || match[1].startsWith("skill:")) return trimmed;
    const skill = meta.loader
      .getSkills()
      .skills.find(({ name }) => name === match[1]);
    return skill ? `/skill:${skill.name}${match[2]}` : trimmed;
  }
  dispose(): void {
    this.sessions.disposeAll();
  }
  resetRoom(roomId: string): void {
    this.sessions.reset(roomId);
  }
  refreshContext(roomId: string): void {
    this.sessions.refreshPrompt(roomId);
  }
  private applyThinkingLevel(
    meta: PiSessionMeta,
    override: string | undefined,
  ): void {
    const session = meta.session;
    if (!session.setThinkingLevel) return;
    const target = override ?? this.agent.thinking ?? meta.baseThinking;
    if (target === undefined || session.thinkingLevel === target) return;
    session.setThinkingLevel(toPiThinking(target));
  }
  async abort(): Promise<void> {
    await Promise.all(
      this.sessions
        .rooms()
        .map((roomId) => this.sessions.get(roomId)?.session.abort()),
    );
  }
  async steer(
    roomId: string,
    message: string,
    attachments?: MessageAttachment[],
  ): Promise<boolean> {
    const session = this.sessions.get(roomId)?.session;
    if (!session?.steer) return false;
    const images = (await loadNativeImages(attachments)).map(
      ({ attachment, base64 }) => ({
        type: "image" as const,
        data: base64,
        mimeType: attachment.mime,
      }),
    );
    await session.steer(message, images.length ? images : undefined);
    return true;
  }
  async compact(roomId: string): Promise<CompactResult> {
    return this.compaction.compact(roomId);
  }
  async compactClean(roomId: string): Promise<CompactResult> {
    return this.compaction.clean(roomId);
  }
  async compactDraft(
    roomId: string,
  ): Promise<{ compacted: boolean; message: string; summary?: string }> {
    return this.compaction.draft(roomId);
  }
  async compactApply(
    roomId: string,
    editedSummary: string,
  ): Promise<CompactResult> {
    return this.compaction.apply(roomId, editedSummary);
  }
  async forkAtMessage(
    roomId: string,
    originEventId: string,
    userOrdinal: number,
  ): Promise<{ ok: boolean; message: string }> {
    let meta = this.sessions.get(roomId);
    if (!meta) {
      if (!hasPersistedPiSession(this.workspace.rootDir, roomId, this.agent.id))
        return { ok: false, message: "no active pi session for this room" };
      meta = await this.ensureSession(roomId, undefined);
    }
    const session = meta.session;
    if (!session.getUserMessagesForForking || !session.navigateTree) {
      return {
        ok: false,
        message: "this pi session build does not support native forking",
      };
    }
    const entries = session.getUserMessagesForForking();
    if (userOrdinal < 1 || userOrdinal > entries.length) {
      return {
        ok: false,
        message: `fork ordinal ${userOrdinal} out of range (session has ${entries.length} user entries; event ${originEventId})`,
      };
    }
    const target = entries[userOrdinal - 1];
    const result = await session.navigateTree(target.entryId);
    if (result?.cancelled) {
      return {
        ok: false,
        message: `pi navigateTree cancelled for entry ${target.entryId} (ordinal ${userOrdinal})`,
      };
    }
    return {
      ok: true,
      message: `forked pi session at user message ${userOrdinal} (entry ${target.entryId})`,
    };
  }
  private async ensureSession(
    roomId: string,
    activeRole: ResolvedRole | undefined,
    thinkingLevel?: number,
  ): Promise<PiSessionMeta> {
    await this.modelRuntimeReady;
    const roleKey = promptCacheKey(activeRole?.name, thinkingLevel);
    const systemPrompt = await this.sessions.systemPrompt(roomId, roleKey, () =>
      buildBaseSystemPrompt({
        agent: this.agent,
        role: activeRole,
        workspaceRoot: this.workspace.rootDir,
        thinkingLevel,
      }),
    );
    const skillNames = agentSkillNames(this.agent, activeRole);
    if (
      this.agent.tools.includes("web") &&
      !skillNames.includes("brave-search")
    )
      skillNames.push("brave-search");
    const skillResolution = skillNames.length
      ? resolveSkillRefs(this.workspace, skillNames)
      : { paths: [], diagnostics: [] };
    for (const diagnostic of skillResolution.diagnostics)
      console.warn(diagnostic);
    const key = skillPathsKey(skillResolution.paths);
    const existing = this.sessions.get(roomId);
    if (existing && existing.skillPathsKey === key) {
      if (existing.systemPromptRef.current !== systemPrompt) {
        existing.systemPromptRef.current = systemPrompt;
        try {
          if (!this.sessionFactory) await existing.loader.reload();
          await existing.session.reload();
        } catch {
          this.sessions.reset(roomId);
          const recreated = await this.createSessionMeta(
            roomId,
            systemPrompt,
            skillResolution.paths,
            key,
          );
          this.sessions.set(roomId, recreated);
          return recreated;
        }
      }
      return existing;
    }
    if (existing) this.sessions.reset(roomId);
    const meta = await this.createSessionMeta(
      roomId,
      systemPrompt,
      skillResolution.paths,
      key,
    );
    this.sessions.set(roomId, meta);
    return meta;
  }
  private async createSessionMeta(
    roomId: string,
    systemPrompt: string,
    skillPaths: string[],
    key: string,
  ): Promise<PiSessionMeta> {
    const model = this.resolveModel();
    const roomDir = workspacePaths.roomDir(this.workspace.rootDir, roomId);
    const customTools = await buildPiTools(this.agent.tools, {
      memoryStore: this.memoryStore,
      agent: this.agent,
      roomId,
      roomDir,
      workDir: this.workDir,
      imageRead: this.workspace.config.imageRead,
      availableAgents: agentRoster(this.workspace),
      summonCreate: this.summonCreate,
      resumeCreate: this.resumeCreate,
      recallSearch: this.recallSearch,
      toolResultFetch: this.toolResultFetch,
      contextDiet: this.contextDiet,
      endConversation: this.endConversation,
      toolProviders: this.toolProviders,
    });
    const systemPromptRef = { current: systemPrompt };
    const loader = new DefaultResourceLoader({
      cwd: this.workDir,
      agentDir: getAgentDir(),
      additionalSkillPaths: skillPaths,
      noExtensions: true,
      extensionFactories: [
        this.compaction.extension(roomId, model?.provider, model?.name),
        { name: "clean-compact", factory: this.compaction.cleanExtension(roomId) },
      ],
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      ...(this.agent.promptLaw
        ? {
            systemPromptOverride: () => systemPromptRef.current,
            appendSystemPromptOverride: () => [],
          }
        : { appendSystemPromptOverride: () => [systemPromptRef.current] }),
    });
    if (!this.sessionFactory) await loader.reload();
    const sessionDir = piRoomSessionDir(this.workspace, roomId, this.agent.id);
    const { session, modelFallbackMessage } = this.sessionFactory
      ? await this.sessionFactory({
          cwd: this.workDir,
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
          cwd: this.workDir,
          modelRuntime: this.modelRuntime,
          model,
          thinkingLevel: toPiThinking(this.agent.thinking),
          tools: this.agent.tools,
          customTools: customTools as NonNullable<
            Parameters<typeof createAgentSession>[0]
          >["customTools"],
          resourceLoader: loader,
          sessionManager: SessionManager.continueRecent(
            this.workDir,
            sessionDir,
          ),
          settingsManager: readOnlyPiSettings(this.workDir),
        });
    if (modelFallbackMessage) console.warn(modelFallbackMessage);
    const meta: PiSessionMeta = {
      session: session as PiSessionLike,
      loader,
      systemPromptRef,
      skillPathsKey: key,
    };
    const baseThinking = (session as PiSessionLike).thinkingLevel;
    if (baseThinking !== undefined) meta.baseThinking = baseThinking;
    return meta;
  }
  private resolveModel(): Model<any> | undefined {
    const provider = this.agent.model?.provider;
    const name = this.agent.model?.name;
    if (!provider || !name) return undefined;
    const resolved = findModelWithAlias(this.modelRegistry, provider, name);
    if (resolved) return resolved;
    const availableProviders = Array.from(
      new Set(this.modelRegistry.getAll().map((model) => model.provider)),
    ).sort();
    throw new Error(
      `agent "${this.agent.id}" is configured for model "${provider}/${name}", but that model is not in the pi model registry ` +
        `(known providers: ${availableProviders.join(", ") || "none"}). Refusing to silently fall back to the Pi default model — ` +
        `fix agent.json's model.provider/model.name (check for a typo, or that the model exists under this provider).`,
    );
  }
  private resolveModelLabel(): string {
    const provider = this.agent.model?.provider;
    const name = this.agent.model?.name;
    return provider && name ? `${provider}/${name}` : "Pi default";
  }
}
