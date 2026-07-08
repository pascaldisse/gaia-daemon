// The Pi harness: one persistent Pi SDK session per room, in-process gaia
// tools (memory/recall/summon), hot-applied system prompt + thinking level.
// Everything harness-specific lives HERE; shared code sees only the
// HarnessSpec registered at the bottom (AGENTS.md §RULE #0).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadNativeImages } from "../core/attachments.js";
import type { AgentDef, AgentEvent, CompactResult, Workspace } from "../core/types.js";
import { workspacePaths } from "../core/paths.js";
import type { MemoryStore } from "../domain/memory.js";
import { agentSkillNames, resolveSkillRefs } from "../domain/skills.js";
import { buildPiTools } from "./tools.js";
import {
  type AgentInput,
  type AgentRuntime,
  type HarnessCapabilities,
  registerHarness,
  type RuntimeCreateContext,
  type RecallSearch,
  type SummonCreate,
} from "./spec.js";
import { createEventChannel } from "./events.js";
import { SessionMap } from "./sessions.js";
import { RUNNER_ENV } from "./protocol.js";
import { liveModelLabel } from "./model-label.js";
import { buildBaseSystemPrompt, buildTurnPrompt } from "./prompt.js";

// ---------------------------------------------------------------------------
// Subprocess-side egress redirect for the credential proxy (v1's
// llm-proxy-fetch.ts, now local to the only harness that needs it). A proxied
// Pi turn must reach the loopback proxy instead of the real provider WITHOUT
// changing the model's baseUrl — Pi keys per-provider request compatibility
// off the baseUrl string (e.g. `deepseek.com`), so rewriting it would silently
// change the request shape. We leave the model untouched and rewrite the HTTP
// egress: Pi uses globalThis.fetch, so we wrap it and re-point only the
// provider origin at the proxy mount. The per-turn token Pi attaches as the
// bearer rides along; the daemon swaps it for the real key.
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;

// realBaseUrl (trailing slash trimmed) -> proxy mount (trailing slash trimmed).
const redirects = new Map<string, string>();
let fetchWrapped = false;

/** Rewrite a request URL if it targets a redirected provider origin, else return
 *  undefined. Pure + exported so the path math is unit-testable without patching
 *  the global. The api-relative suffix is preserved verbatim, so the daemon can
 *  re-join it onto the real provider base URL. */
export function rewriteProviderUrl(url: string, table: Map<string, string> = redirects): string | undefined {
  for (const [from, to] of table) {
    if (url === from || url.startsWith(`${from}/`)) return to + url.slice(from.length);
  }
  return undefined;
}

/** Register a provider origin to redirect, installing the global wrapper once.
 *  Idempotent and additive: multiple providers can be redirected in one process. */
export function redirectProviderFetch(realBaseUrl: string, proxyUrl: string): void {
  redirects.set(realBaseUrl.replace(/\/+$/, ""), proxyUrl.replace(/\/+$/, ""));
  if (fetchWrapped) return;
  fetchWrapped = true;
  const original: FetchFn = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
    const rewritten = url !== undefined ? rewriteProviderUrl(url) : undefined;
    return rewritten !== undefined ? original(rewritten, init) : original(input, init);
  }) as FetchFn;
}

// ---------------------------------------------------------------------------
// Session abstraction (injectable for tests)
// ---------------------------------------------------------------------------

export interface PiRuntimeOptions extends RuntimeCreateContext {
  sessionFactory?: PiRuntimeSessionFactory;
}

export interface PiSessionLike {
  readonly model?: { provider: string; id: string } | undefined;
  readonly thinkingLevel?: string;
  setThinkingLevel?(level: string): void;
  subscribe(listener: (event: any) => void): () => void;
  prompt(text: string, options?: { source?: "interactive"; images?: { type: "image"; data: string; mimeType: string }[] }): Promise<void>;
  /** Queue a steering message into the running prompt (pi SDK). */
  steer?(text: string): Promise<void>;
  /** Window-relative context accounting (pi SDK getContextUsage). `tokens`
   * is null right after a compaction, until the next assistant reply. */
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  /** Native session compaction — the same call the pi CLI's /compact runs. */
  compact?(customInstructions?: string): Promise<{ summary: string; tokensBefore: number; estimatedTokensAfter?: number }>;
  abort(): Promise<void>;
  reload(): Promise<void>;
  dispose(): void;
}

export interface PiRuntimeSessionFactoryOptions {
  cwd: string;
  roomId: string;
  agent: AgentDef;
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

/** Per-room session metadata tracked by the uniform SessionMap. */
interface PiSessionMeta {
  session: PiSessionLike;
  loader: DefaultResourceLoader;
  systemPromptRef: { current: string };
  skillPathsKey: string;
  // Thinking level the session was created with; turns without an explicit
  // override restore it (voice mode may have switched it off).
  baseThinking?: string;
}

export function piRoomSessionDir(workspace: Pick<Workspace, "rootDir">, roomId: string, agentId: string): string {
  return join(workspacePaths.piSessionsDir(workspace.rootDir, roomId), agentId);
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

const PI_CAPABILITIES: HarnessCapabilities = {
  gaiaTools: ["memory", "recall", "summon"],
  nativeTools: ["web"],
  granularTools: true,
  supportsPermissionMode: false,
  // Pi core has no MCP client (an adapter package exists but is not wired).
  supportsMcp: false,
  supportsSteer: true,
  supportsCompact: true,
  // Pi has no claude-style slash-command passthrough surface.
  supportsNativeCommands: false,
  // Pi's only fan-out surface IS the gaia summon tool — nothing to suppress.
  fanOutTools: [],
};

export class PiRuntime implements AgentRuntime {
  readonly capabilities = PI_CAPABILITIES;
  readonly agent: AgentDef;
  private readonly workspace: Workspace;
  private readonly memoryStore: MemoryStore;
  private readonly sessionFactory?: PiRuntimeSessionFactory;
  private readonly summonCreate?: SummonCreate;
  private readonly recallSearch?: RecallSearch;
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly sessions = new SessionMap<PiSessionMeta>((meta) => meta.session.dispose());
  private readonly configuredModelLabel: string;
  private liveModelLabel: string | undefined;
  private readonly cwd: string;

  constructor(options: PiRuntimeOptions) {
    this.workspace = options.workspace;
    this.agent = options.agent;
    this.memoryStore = options.memoryStore;
    this.sessionFactory = options.sessionFactory;
    this.summonCreate = options.summonCreate;
    this.recallSearch = options.recallSearch;
    this.cwd = options.workspace.rootDir;
    this.applyCredentialProxy();
    this.configuredModelLabel = this.resolveModelLabel();
  }

  // When the daemon enabled the credential proxy for this turn (GAIA_LLM_PROXY_URL
  // set), route this agent's provider calls through the loopback proxy so the real
  // key never enters this (sandboxed) process. Two moves, deliberately split:
  //
  //  1. Auth: register the provider with the per-turn token as its key (authHeader
  //     so it rides as `Authorization: Bearer <token>`). This does NOT touch the
  //     model's baseUrl — Pi detects per-provider request compatibility from the
  //     baseUrl string (e.g. deepseek's reasoning/role quirks), so rewriting it
  //     would silently corrupt the request. The empty cred store (PI_CODING_AGENT_DIR)
  //     + stripped env keys ensure this token, not a real key, is what's sent.
  //  2. Egress: redirect the provider's real origin to the proxy mount at the fetch
  //     layer. The daemon strips the mount prefix and re-joins the suffix onto the
  //     real provider base URL, reconstructing the exact upstream call — then swaps
  //     the token for the real key host-side.
  private applyCredentialProxy(): void {
    const proxyUrl = process.env[RUNNER_ENV.llmProxyUrl]?.trim();
    const token = process.env[RUNNER_ENV.daemonToken]?.trim();
    const provider = this.agent.model?.provider;
    const name = this.agent.model?.name;
    if (!proxyUrl || !token || !provider || !name) return;
    this.modelRegistry.registerProvider(provider, { apiKey: token, authHeader: true });
    const realBaseUrl = this.modelRegistry.find(provider, name)?.baseUrl;
    if (realBaseUrl) redirectProviderFetch(realBaseUrl, proxyUrl);
  }

  // Reports the model the live session actually uses once a turn has run;
  // before that, the configured model or "Pi default".
  get modelLabel(): string {
    return this.liveModelLabel ?? this.configuredModelLabel;
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const meta = await this.ensureSession(input);
    const session = meta.session;
    this.applyThinkingLevel(meta, input.thinking);

    const sessionModel = session.model;
    if (sessionModel) {
      const registryModel = this.modelRegistry.find(sessionModel.provider, sessionModel.id);
      const subscription = registryModel ? this.modelRegistry.isUsingOAuth(registryModel) : false;
      this.liveModelLabel = liveModelLabel(sessionModel.provider, sessionModel.id, subscription);
      yield { type: "model-info", provider: sessionModel.provider, modelId: sessionModel.id, subscription };
    }

    // Memory travels in the turn prompt only when it changed (SessionMap's
    // uniform diff), so memory-tool writes never force a session reload.
    const memory = await this.memoryStore.promptBlock(this.agent.memoryDir);
    const memoryChanged = this.sessions.memoryChanged(input.roomId, memory);

    const channel = createEventChannel();

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        channel.push({ type: "text-delta", delta: event.assistantMessageEvent.delta });
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start") {
        channel.push({ type: "thinking-start" });
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
        channel.push({ type: "thinking-delta", delta: event.assistantMessageEvent.delta });
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_end") {
        channel.push({ type: "thinking-end", content: event.assistantMessageEvent.content });
      }
      if (event.type === "tool_execution_start") {
        channel.push({ type: "tool-start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args });
      }
      if (event.type === "tool_execution_update") {
        channel.push({ type: "tool-update", toolName: event.toolName, toolCallId: event.toolCallId, partialResult: event.partialResult });
      }
      if (event.type === "tool_execution_end") {
        channel.push({ type: "tool-end", toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError });
      }
      // Pi's stream contract encodes every provider/request failure (rate
      // limit, bad key, network) as a final assistant message with
      // stopReason "error" instead of throwing - surface it as a turn
      // failure so the task settles as "error", not a silent empty reply.
      // "aborted" is the cancel path and stays non-fatal.
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
        channel.fail(new Error(event.message.errorMessage || "model request failed"));
      }
      // Window-relative context accounting after each assistant message; the
      // SDK returns tokens:null right after a compaction (no fresh usage yet).
      if (event.type === "message_end" && event.message.role === "assistant") {
        const usage = session.getContextUsage?.();
        if (usage && usage.tokens !== null) {
          channel.push({ type: "context-usage", usedTokens: usage.tokens, maxTokens: usage.contextWindow });
        }
      }
    });

    const prompt = buildTurnPrompt({
      roomId: input.roomId,
      agentId: this.agent.id,
      message: input.message,
      events: input.transcript,
      memory: memoryChanged ? memory : undefined,
      recall: input.recall,
      channel: input.channel,
      attachments: input.attachments,
    });
    // Pasted images ride the SDK's native channel (PromptOptions.images, the
    // same ImageContent[] the pi CLI builds for clipboard pastes); the prompt
    // text keeps the uniform path breadcrumbs for non-image files.
    const images = (await loadNativeImages(input.attachments)).map(({ attachment, base64 }) => ({
      type: "image" as const,
      data: base64,
      mimeType: attachment.mime,
    }));
    session
      .prompt(prompt, { source: "interactive", ...(images.length ? { images } : {}) })
      .catch((cause) => channel.fail(cause))
      .finally(() => {
        unsubscribe();
        channel.close();
      });

    for await (const event of channel.stream()) yield event;
  }

  dispose(): void {
    this.sessions.disposeAll();
  }

  // Tear down this room's Pi session so the next turn rebuilds it from an empty
  // transcript (backs /clear). SessionMap.reset also drops the memory diff, so
  // the fresh session gets memory again on its first turn.
  resetRoom(roomId: string): void {
    this.sessions.reset(roomId);
  }

  // Applies a per-turn thinking override (voice mode forces "off") and
  // restores the agent's own level on turns without one. Reading
  // agent.thinking live means a settings change hot-applies on the next
  // turn without recreating the session.
  private applyThinkingLevel(meta: PiSessionMeta, override: string | undefined): void {
    const session = meta.session;
    if (!session.setThinkingLevel) return;
    const target = override ?? this.agent.thinking ?? meta.baseThinking;
    if (target === undefined || session.thinkingLevel === target) return;
    session.setThinkingLevel(target);
  }

  async abort(): Promise<void> {
    await Promise.all(this.sessions.rooms().map((roomId) => this.sessions.get(roomId)?.session.abort()));
  }

  /** Inject guidance into the room's running prompt (backs /steer). */
  async steer(roomId: string, message: string): Promise<boolean> {
    const session = this.sessions.get(roomId)?.session;
    if (!session?.steer) return false;
    await session.steer(message);
    return true;
  }

  /** Native pi compaction (backs /compact). The SDK call aborts any running
   * prompt first and emits compaction_start/end on the session stream. */
  async compact(roomId: string): Promise<CompactResult> {
    const session = this.sessions.get(roomId)?.session;
    if (!session?.compact) return { compacted: false, message: "nothing to compact — no active session for this room." };
    const result = await session.compact();
    const after = result.estimatedTokensAfter !== undefined ? ` → ~${result.estimatedTokensAfter}` : "";
    return { compacted: true, message: `session compacted (${result.tokensBefore} tokens before${after}).` };
  }

  private async ensureSession(input: AgentInput): Promise<PiSessionMeta> {
    const systemPrompt = await buildBaseSystemPrompt({
      agent: this.agent,
      role: input.activeRole,
      contextFiles: this.workspace.contextFiles,
    });
    const skillNames = agentSkillNames(this.agent, input.activeRole);
    // Pi's translation of the harness-agnostic `web` tool: claude/codex expose a
    // native web tool, pi shells out to the brave-search skill (its search.js —
    // so a `web` pi agent also needs `bash` + a BRAVE_API_KEY). Local mapping,
    // never a shared-code branch. Deduped against explicitly assigned skills.
    if (this.agent.tools.includes("web") && !skillNames.includes("brave-search")) skillNames.push("brave-search");
    const skillResolution = skillNames.length ? resolveSkillRefs(this.workspace, skillNames) : { paths: [], diagnostics: [] };
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
          this.sessions.reset(input.roomId);
          const recreated = await this.createSessionMeta(input.roomId, systemPrompt, skillResolution.paths, key);
          this.sessions.set(input.roomId, recreated);
          return recreated;
        }
      }
      return existing;
    }

    // Skill paths changed (or no session yet): reset drops the old session AND
    // its memory diff, so the rebuilt session re-receives memory.
    if (existing) this.sessions.reset(input.roomId);
    const meta = await this.createSessionMeta(input.roomId, systemPrompt, skillResolution.paths, key);
    this.sessions.set(input.roomId, meta);
    return meta;
  }

  private async createSessionMeta(roomId: string, systemPrompt: string, skillPaths: string[], key: string): Promise<PiSessionMeta> {
    const model = this.resolveModel();
    const roomDir = workspacePaths.roomDir(this.workspace.rootDir, roomId);
    const customTools = await buildPiTools(this.agent.tools, {
      memoryStore: this.memoryStore,
      agent: this.agent,
      roomId,
      roomDir,
      summonCreate: this.summonCreate,
      recallSearch: this.recallSearch,
    });
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
          // The registry yields `unknown[]` (it imports no pi types to stay light);
          // this is the one site that knows they are pi tool definitions.
          customTools: customTools as NonNullable<Parameters<typeof createAgentSession>[0]>["customTools"],
          resourceLoader: loader,
          sessionManager: SessionManager.continueRecent(this.cwd, sessionDir),
          settingsManager: readOnlyPiSettings(this.cwd),
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
    return this.modelRegistry.find(provider, name);
  }

  private resolveModelLabel(): string {
    const provider = this.agent.model?.provider;
    const name = this.agent.model?.name;
    if (!provider || !name) return "Pi default";
    return this.modelRegistry.find(provider, name) ? `${provider}/${name}` : "Pi default";
  }
}

// The real Pi credential store the proxy hides: Pi reads its key here (and a dumb
// summon could `cat` it), so it is deny-read in the sandbox AND side-stepped by
// relocating Pi's agent dir to an empty scratch (PI_CODING_AGENT_DIR).
function realPiAuthJson(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

registerHarness({
  id: "pi",
  capabilities: PI_CAPABILITIES,
  ui: { label: "pi", description: "Pi coding agent (local SDK)" },
  create: (ctx) => new PiRuntime(ctx),
  // Pi self-persists sessions as files under the room's pi-sessions/<agent>/
  // dir (SessionManager.continueRecent resumes the most recent one). Any file
  // there means the conversation behind the cursor is resumable; an empty or
  // missing dir means a fresh session — its history must be replayed.
  hasDurableSession: (rootDir, roomId, agentId) => {
    try {
      return readdirSync(piRoomSessionDir({ rootDir }, roomId, agentId)).length > 0;
    } catch {
      return false; // no dir ⇒ nothing to resume
    }
  },
  // Pi's proxy wiring (the in-process fetch redirect lives in applyCredentialProxy):
  // relocate its agent dir to an empty store so AuthStorage resolves no real key
  // (the token registered against the proxy is then what reaches the wire), and
  // deny-read the real store. The runner sets GAIA_LLM_PROXY_URL uniformly.
  credentialProxy: ({ scratchDir }) => {
    const authJson = join(scratchDir, "auth.json");
    if (!existsSync(authJson)) writeFileSync(authJson, "{}\n");
    return { env: { PI_CODING_AGENT_DIR: scratchDir }, denyRead: [realPiAuthJson()] };
  },
});
