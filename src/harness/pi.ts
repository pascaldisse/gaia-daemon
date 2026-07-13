// The Pi harness: one persistent Pi SDK session per room, in-process gaia
// tools (memory/recall/summon), hot-applied system prompt + thinking level.
// Everything harness-specific lives HERE; shared code sees only the
// HarnessSpec registered at the bottom (AGENTS.md §RULE #0).

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { NO_SESSION_TO_COMPACT, type AgentDef, type AgentEvent, type CompactResult, type MessageAttachment, type UsageProbeResult, type Workspace } from "../core/types.js";
import { gaiaHome, workspacePaths } from "../core/paths.js";
import type { MemoryStore } from "../domain/memory.js";
import { agentSkillNames, resolveSkillRefs } from "../domain/skills.js";
import { agentRoster, buildPiTools } from "./tools.js";
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
import { ModelLabel } from "./model-label.js";
import { buildBaseSystemPrompt, buildTurnPromptFor } from "./prompt.js";
import { emailFromJwt, expiryMsFromJwt, fetchAnthropicUsage, fetchChatGptUsage } from "./usage.js";

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
  /** Queue a steering message into the running prompt (pi SDK). Pasted images
   * ride the SDK's mid-turn image channel, the same shape prompt() takes. */
  steer?(text: string, images?: { type: "image"; data: string; mimeType: string }[]): Promise<void>;
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
  gaiaTools: ["memory", "recall", "summon", "resume"],
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
  private readonly label: ModelLabel;
  private readonly cwd: string;
  /** Where the agent child RUNS: this runner process's own cwd — RunnerHost
   * set it to the room's git worktree (RoomState.workDir) or the workspace
   * root. Distinct from this.cwd (workspace root), which anchors daemon
   * state paths (session stores, room dirs) that must never move with the
   * checkout. */
  private readonly workDir: string;

  constructor(options: PiRuntimeOptions) {
    this.workspace = options.workspace;
    this.agent = options.agent;
    this.memoryStore = options.memoryStore;
    this.sessionFactory = options.sessionFactory;
    this.summonCreate = options.summonCreate;
    this.recallSearch = options.recallSearch;
    this.cwd = options.workspace.rootDir;
    this.workDir = process.cwd();
    this.applyCredentialProxy();
    this.label = new ModelLabel(this.resolveModelLabel());
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
    return this.label.current;
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const meta = await this.ensureSession(input);
    const session = meta.session;
    this.applyThinkingLevel(meta, input.thinking);

    const sessionModel = session.model;
    if (sessionModel) {
      const registryModel = this.modelRegistry.find(sessionModel.provider, sessionModel.id);
      const subscription = registryModel ? this.modelRegistry.isUsingOAuth(registryModel) : false;
      const info = { type: "model-info", provider: sessionModel.provider, modelId: sessionModel.id, subscription } as const;
      this.label.observe(info);
      yield info;
    }

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

    // The uniform turn-prompt composition (memory travels only when it changed
    // — SessionMap's diff — so memory-tool writes never force a session
    // reload), shared with every runtime via buildTurnPromptFor.
    const prompt = await buildTurnPromptFor(this.agent, input, this.memoryStore, this.sessions, { workDir: this.workDir, rootDir: this.cwd });
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

  refreshContext(roomId: string): void {
    this.sessions.refreshPrompt(roomId);
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

  /** Inject guidance into the room's running prompt (backs /steer). Pasted
   * images ride the SDK's mid-turn image channel (session.steer's images arg —
   * the same ImageContent[] send() builds for a normal turn); non-image files
   * stay path breadcrumbs in the message text. */
  async steer(roomId: string, message: string, attachments?: MessageAttachment[]): Promise<boolean> {
    const session = this.sessions.get(roomId)?.session;
    if (!session?.steer) return false;
    const images = (await loadNativeImages(attachments)).map(({ attachment, base64 }) => ({
      type: "image" as const,
      data: base64,
      mimeType: attachment.mime,
    }));
    await session.steer(message, images.length ? images : undefined);
    return true;
  }

  /** Native pi compaction (backs /compact). The SDK call aborts any running
   * prompt first and emits compaction_start/end on the session stream. The
   * SDK's own summary of the evicted history rides back on CompactResult so
   * the daemon persists it (durable compaction — a later session loss reloads
   * [summary + tail] instead of raw history). */
  async compact(roomId: string): Promise<CompactResult> {
    const session = this.sessions.get(roomId)?.session;
    if (!session?.compact) return NO_SESSION_TO_COMPACT;
    const result = await session.compact();
    const after = result.estimatedTokensAfter !== undefined ? ` → ~${result.estimatedTokensAfter}` : "";
    return {
      compacted: true,
      message: `session compacted (${result.tokensBefore} tokens before${after}).`,
      ...(result.summary ? { summary: result.summary } : {}),
    };
  }

  private async ensureSession(input: AgentInput): Promise<PiSessionMeta> {
    const roleKey = input.activeRole?.name ?? "";
    const systemPrompt = await this.sessions.systemPrompt(input.roomId, roleKey, () =>
      buildBaseSystemPrompt({
        agent: this.agent,
        role: input.activeRole,
        workspaceRoot: this.workspace.rootDir,
      }),
    );
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
      availableAgents: agentRoster(this.workspace),
      summonCreate: this.summonCreate,
      recallSearch: this.recallSearch,
    });
    const systemPromptRef = { current: systemPrompt };

    const loader = new DefaultResourceLoader({
      cwd: this.workDir,
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
          sessionManager: SessionManager.continueRecent(this.workDir, sessionDir),
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

// ---------------------------------------------------------------------------
// Account usage probes — Pi's AuthStorage can hold OAuth logins for the same
// subscription accounts the CLIs use ("anthropic" = Claude, "openai-codex" =
// ChatGPT), so Pi declares BOTH as usage candidates: when another harness's
// credential store is unreadable (a locked keychain, say), Pi's copy keeps the
// meter alive. The provider-id branch below is PI-INTERNAL knowledge of Pi's
// own provider vocabulary — not a harness-id branch (RULE #0 intact); the
// provider clients themselves are shared (harness/usage.ts).

async function probePiUsage(provider: "anthropic" | "openai-codex"): Promise<UsageProbeResult> {
  let cred: { type?: string; accountId?: unknown } | undefined;
  let token: string | undefined;
  try {
    const storage = AuthStorage.create();
    cred = storage.get(provider) as typeof cred;
    if (!cred || cred.type !== "oauth") return { status: "none" }; // API-key or no login — no subscription meter.
    // getApiKey auto-refreshes an expired OAuth token (with file locking).
    token = await storage.getApiKey(provider);
  } catch {
    return { status: "error" }; // store unreadable / refresh raced — transient, keep last-known.
  }
  if (!token) return { status: "error" }; // an oauth login exists but no token could be minted — transient.
  return provider === "anthropic"
    ? fetchAnthropicUsage(token)
    : fetchChatGptUsage(token, typeof cred.accountId === "string" ? cred.accountId : undefined);
}

async function probePiAccountUsage(credentials: Record<string, string>): Promise<UsageProbeResult> {
  const token = credentials.accessToken;
  return token ? fetchChatGptUsage(token, credentials.accountId) : { status: "none" };
}

// Named pi accounts: an isolated PI_CODING_AGENT_DIR materialized from the
// stored credential bag — the exact twin of codex's materializeCodexHome.
// Pi's AuthStorage reads auth.json from that dir, refreshes tokens when the
// stored expiry passes, and writes rotated tokens back into the file. The
// materialized entry carries the access token's REAL expiry (a hardcoded 0
// meant "already expired" — a forced refresh on every run, whose rotated
// refresh token the next materialization then stomped with the store's
// stale one, server-invalidating the whole credential chain). The file is
// only rewritten when the store's credential is FRESHER than what is
// already on disk, so pi's own rotation stays authoritative.
// models.json is copied in from the real agent dir
// (when present) so custom model definitions still resolve. v1 scope: the
// openai-codex (ChatGPT OAuth) provider — pi's own provider vocabulary,
// declared as data on this spec (RULE #0 intact).
function materializePiAgentDir(credentials: Record<string, string>): string {
  const key = credentials.accountId?.trim() || createHash("sha256").update(credentials.refreshToken ?? "").digest("hex").slice(0, 16);
  const dir = join(gaiaHome(), "pi-accounts", key);
  mkdirSync(dir, { recursive: true });
  const modelsSrc = join(homedir(), ".pi", "agent", "models.json");
  const modelsDst = join(dir, "models.json");
  if (existsSync(modelsSrc) && !existsSync(modelsDst)) copyFileSync(modelsSrc, modelsDst);
  const authPath = join(dir, "auth.json");
  const entry = {
    type: "oauth",
    refresh: credentials.refreshToken ?? "",
    access: credentials.accessToken ?? "",
    expires: expiryMsFromJwt(credentials.accessToken),
    ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
  };
  let existing: { ["openai-codex"]?: { refresh?: string; access?: string } } | undefined;
  try {
    existing = JSON.parse(readFileSync(authPath, "utf8")) as typeof existing;
  } catch {
    // missing or torn — rewrite below
  }
  const materialized = existing?.["openai-codex"];
  if (!materialized?.refresh || entry.expires > expiryMsFromJwt(materialized.access)) {
    writeFileSync(authPath, JSON.stringify({ "openai-codex": entry }, null, 2) + "\n", { mode: 0o600 });
  }
  return dir;
}

registerHarness({
  id: "pi",
  capabilities: PI_CAPABILITIES,
  transientAuthPatterns: [/not logged in/i, /token .*expired/i, /re-?authenticat/i, /\bunauthorized\b/i],
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
  // Named accounts (ChatGPT OAuth): same field vocabulary as codex accounts,
  // so credentials from a codex login can be reused for a pi binding. Applied
  // by RunnerHost BEFORE the credential-proxy block — a proxied (sandboxed)
  // turn strips it with every other provider key.
  accounts: {
    label: "Pi account (ChatGPT OAuth)",
    fields: [
      { key: "accessToken", label: "Access token", secret: true, hint: "~/.pi/agent/auth.json → openai-codex.access (or a codex account's tokens.access_token)" },
      { key: "refreshToken", label: "Refresh token", secret: true, hint: "~/.pi/agent/auth.json → openai-codex.refresh (codex: tokens.refresh_token)" },
      { key: "accountId", label: "Account ID", hint: "~/.pi/agent/auth.json → openai-codex.accountId (codex: tokens.account_id)" },
    ],
    env: (credentials) => ({ PI_CODING_AGENT_DIR: materializePiAgentDir(credentials) }),
    email: (credentials) => emailFromJwt(credentials.accessToken),
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
  // Pi keeps session + model state under ~/.pi (a sandboxed turn deadlocks if
  // denied writes there); its credential store inside that tree is carved back
  // to read-only so a confined turn can't tamper with the key it can read.
  sandboxPaths: { writable: ["~/.pi", join(gaiaHome(), "pi-accounts")], readonly: ["~/.pi/agent/auth.json"] },
  usageAccounts: (accounts) => [
    { account: "ambient:pi:anthropic", probe: () => probePiUsage("anthropic") },
    { account: "ambient:pi", probe: () => probePiUsage("openai-codex") },
    ...accounts.map((account) => ({ account: account.id, probe: () => probePiAccountUsage(account.credentials) })),
  ],
  ambientUsageAccount: (agent) => (agent.model?.provider === "anthropic" ? "ambient:pi:anthropic" : "ambient:pi"),
});
