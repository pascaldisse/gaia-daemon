import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime, SessionManager, } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, ExtensionRunner, PackageManager } from "@earendil-works/pi-coding-agent";
import { loadNativeImages } from "../../core/attachments.js";
import { type AgentDef, type AgentEvent, type CompactResult, type MessageAttachment, type UiPromptReplyValue, type Workspace, } from "../../core/types.js";
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
import { createUiBridge } from "./ui-bridge.js";
import { bindPiLifecycle, bindPiShortcuts, buildPiUiContext } from "./ui-context.js";
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
  supportsUi: true,
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
  private readonly extensionsConfig?: RuntimeCreateContext["extensions"];
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
    this.extensionsConfig = options.extensions;
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
    // LANE-D: repoint this session's ui bridge at the LIVE turn's stream (see
    // createSessionMeta's turnEmit doc comment) so ui.*/auth.request/
    // ext.lifecycle events interleave with everything else this turn yields;
    // reset to a no-op once the turn settles so a late ui-bridge push after
    // this channel closes doesn't try to write into a drained stream.
    meta.turnEmit.current = (event) => channel.push(event);
    // First turn this session ever streams to a client: NOW there is
    // somewhere for ui.shortcut/ext.lifecycle to land (see createSessionMeta's
    // comment on why this can't run any earlier).
    if (!meta.uiBound && meta.extensionRunner) {
      meta.uiBound = true;
      bindPiShortcuts(meta.extensionRunner, meta.uiBridge);
      bindPiLifecycle(meta.loader, meta.extensionRunner, meta.uiBridge);
    }
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
        meta.turnEmit.current = () => {};
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
  /** Route a client's `ui.reply` back to whichever `ui.prompt`/`auth.request`
   * this session's ui bridge is holding pending for `id` (see
   * AgentRuntime.uiReply — host.ts/runner.ts already drive this in from the
   * daemon; capabilities.supportsUi:true above is what turns that on). */
  async uiReply(
    roomId: string,
    id: string,
    value: UiPromptReplyValue,
  ): Promise<boolean> {
    return this.sessions.get(roomId)?.uiBridge.resolvePrompt(id, value) ?? false;
  }
  /** Dispatch a client-fired hotkey `commandId` to the extension's OWN
   * registered shortcut handler (see AgentRuntime.uiShortcutFire). */
  async uiShortcutFire(roomId: string, commandId: string): Promise<boolean> {
    return this.sessions.get(roomId)?.uiBridge.fireShortcut(commandId) ?? false;
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
    // Extension discovery (data on HarnessSpec.extensions, threaded uniformly
    // by runner.ts — RULE #0, no harness-id branch here). `additionalExtensionPaths`
    // load unconditionally regardless of noExtensions (DefaultResourceLoader
    // loads them as "cliEnabledExtensions" ahead of the noExtensions gate — see
    // resource-loader.js reload()/loadCurrentExtensionSet), so the workspace's
    // own .pi/extensions is added explicitly here rather than relying on
    // packageManager.resolve()'s project-trust-gated auto-discovery (which
    // would otherwise need an interactive trust prompt this headless runner
    // can never answer).
    const discover = this.extensionsConfig?.discover ?? false;
    const loader = new DefaultResourceLoader({
      cwd: this.workDir,
      agentDir: getAgentDir(),
      additionalSkillPaths: skillPaths,
      noExtensions: !discover,
      ...(discover
        ? {
            additionalExtensionPaths: [
              ...(this.extensionsConfig?.additionalPaths ?? []),
              join(this.workDir, ".pi", "extensions"),
            ],
          }
        : {}),
      // Loaded regardless of noExtensions/discover (disk-discovered extensions
      // stay off when discover is false) — see compaction.extension() above.
      // Uses the CONFIGURED model provider/name strings, never the resolved
      // Model object, so constructing this factory never needs the model
      // registry populated yet (see the resolveModel() ordering fix below).
      extensionFactories: [
        this.compaction.extension(
          roomId,
          this.agent.model?.provider,
          this.agent.model?.name,
        ),
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
    // Scoped, per-loader-instance — NOT process.env.PI_OFFLINE (rejected,
    // Pascal 09-05: that flag is read process-wide by core/model-runtime.js:71
    // (kills remote model-catalog refresh for EVERY lane sharing this daemon
    // process, not just this one), utils/tools-manager.js, utils/version-check.js
    // — a global env mutation for a per-lane concern, forbidden). Every
    // `loader.reload()` call — regardless of `discover`/noExtensions — runs
    // `packageManager.resolve()` UNCONDITIONALLY (resource-loader.js reload():
    // resolve() happens before noExtensions is ever consulted; noExtensions
    // only filters which of the RESOLVED extension paths get merged
    // afterward). `resolve()` reads settings.json "packages" for ALL FOUR
    // resource kinds (extensions/skills/prompts/themes) and, given no
    // `onMissing` callback, auto-INSTALLS any not-yet-present source over the
    // network (package-manager.js resolvePackageSources -> installMissing()).
    // DefaultResourceLoader.reload() never forwards an onMissing callback to
    // PackageManager.resolve() itself (verified: zero occurrences of
    // "onMissing" in resource-loader.js/.d.ts — ResourceLoaderReloadOptions
    // only exposes resolveProjectTrust), and DefaultResourceLoaderOptions has
    // no constructor hook to inject a custom PackageManager either. The
    // `packageManager` field is TS-private only (resource-loader.d.ts) — a
    // plain, real, JS-public property at runtime — so this reaches THIS
    // loader's own already-constructed instance and wraps only ITS resolve(),
    // never anything global or shared with another lane's loader.
    {
      const packageManager = (
        loader as unknown as { packageManager: PackageManager }
      ).packageManager;
      const originalResolve = packageManager.resolve.bind(packageManager);
      packageManager.resolve = (onMissing) =>
        originalResolve(
          onMissing ??
            (async () =>
              this.extensionsConfig?.installMissing ? "install" : "skip"),
        );
    }
    if (!this.sessionFactory) {
      await loader.reload();
      // Extensions discovered above may register model providers
      // (pi.registerProvider/registerNativeProvider) during load — flush them
      // into the modelRegistry resolveModel() below reads, and refresh so the
      // new provider's models are visible, BEFORE resolving the configured
      // model. Mirrors pi's own AgentSession.bindCore() ordering (flushes
      // pendingProviderRegistrations the same way before the runner is bound).
      // Gated behind `discover`: when it's false noExtensions is true and
      // these queues are always empty anyway.
      if (discover) {
        const extensionRuntime = loader.getExtensions().runtime;
        for (const { name, config } of extensionRuntime.pendingProviderRegistrations)
          this.modelRegistry.registerProvider(name, config);
        extensionRuntime.pendingProviderRegistrations = [];
        for (const { provider } of extensionRuntime.pendingNativeProviderRegistrations)
          this.modelRegistry.registerProvider(provider);
        extensionRuntime.pendingNativeProviderRegistrations = [];
        await this.modelRegistry.refresh();
      }
    }
    // Resolved AFTER extension providers are flushed above — an extension can
    // register the very provider agent.json configures (see ordering comment
    // above); resolving earlier throws before it gets the chance.
    const model = this.resolveModel();
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
    // LANE-D: ui bridge — bound once per session (pending prompts/shortcuts
    // must survive across turns — a ui.reply can land after the turn that
    // raised it ended, e.g. mid-steer). `turnEmit` is a mutable pointer
    // send() repoints to the CURRENT turn's EventChannel.push every turn (see
    // send() below) so ui.* events interleave in the exact stream listening
    // for them; between turns it's a no-op — nothing pushes a mid-session
    // ui.widget/lifecycle event without an active turn anyway (see
    // ui-context.ts's own doc comments for the full method-by-method table).
    const typedSession = session as PiSessionLike;
    const turnEmit: { current: (event: AgentEvent) => void } = { current: () => {} };
    const uiBridge = createUiBridge((event) => turnEmit.current(event));
    // bindExtensions() itself must run NOW (session creation) — an extension's
    // own session_start handler can call ctx.ui.* synchronously inside it, and
    // that needs the real uiContext already wired. What canNOT run yet is
    // bindPiShortcuts/bindPiLifecycle's EMIT side: turnEmit.current is still
    // this construction-time no-op (send() hasn't created a channel yet), so
    // those are deferred to send()'s first turn (meta.uiBound below) instead.
    let extensionRunner: ExtensionRunner | undefined;
    if (typedSession.bindExtensions) {
      await typedSession.bindExtensions({ uiContext: buildPiUiContext(uiBridge) });
      extensionRunner = typedSession.extensionRunner as ExtensionRunner | undefined;
    }
    const meta: PiSessionMeta = {
      session: typedSession,
      loader,
      systemPromptRef,
      skillPathsKey: key,
      uiBridge,
      turnEmit,
      ...(extensionRunner ? { extensionRunner } : {}),
    };
    const baseThinking = typedSession.thinkingLevel;
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
