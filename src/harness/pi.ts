// The Pi harness: one persistent Pi SDK session per room, in-process gaia
// tools (memory/recall/summon), hot-applied system prompt + thinking level.
// Everything harness-specific lives HERE; shared code sees only the
// HarnessSpec registered at the bottom (AGENTS.md §RULE #0).

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  parseSkillBlock,
  readStoredCredential,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadNativeImages } from "../core/attachments.js";
import { NO_SESSION_TO_COMPACT, type AgentDef, type AgentEvent, type CompactResult, type MessageAttachment, type ThinkingLevel, type UsageProbeResult, type Workspace } from "../core/types.js";
import { gaiaHome, workspacePaths } from "../core/paths.js";
import type { MemoryStore } from "../domain/memory.js";
import type { ResolvedRole } from "../domain/roles.js";
import { agentSkillNames, resolveSkillRefs } from "../domain/skills.js";
import { agentRoster, buildPiTools } from "./tools.js";
import {
  type AgentInput,
  type AgentRuntime,
  type HarnessCapabilities,
  registerHarness,
  type RuntimeCreateContext,
  type RecallSearch,
  type ResumeCreate,
  type SummonCreate,
} from "./spec.js";
import { createEventChannel } from "./events.js";
import { SessionMap } from "./sessions.js";
import { RUNNER_ENV } from "./protocol.js";
import { ModelLabel } from "./model-label.js";

// pi-ai 0.82 lazy-loads OAuth flow modules through a bundler-opaque dynamic
// import; inside the `bun build --compile` binary that import cannot resolve
// ("Cannot find module './anthropic.js'") and every stored-OAuth toAuth dies
// with "OAuth auth derivation failed". Register the statically bundled flows
// up front, same as pi's own compiled CLI entry (dist/bun/cli.js).
registerBunOAuthFlows();
import { findModelWithAlias } from "./model-aliases.js";
import { buildBaseSystemPrompt, buildTurnPromptFor, promptCacheKey } from "./prompt.js";
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
  /** Every user-message entry in this session, IN ORDER (id + text) — pi's own
   * addressing for forking (dist/core/agent-session.js). forkAtMessage maps
   * gaia's origin to pi's entry purely by POSITION: the Kth of these is the
   * Kth thing the human said (see there — text is never matched). Already
   * present at runtime on the real AgentSession; declared here so the typed
   * cast can call it. */
  getUserMessagesForForking?(): Array<{ entryId: string; text: string }>;
  /** Pi's native in-session fork: rewind the tree to `targetEntryId` — the new
   * leaf becomes that entry's parent, so the target user message and everything
   * after it leave the LIVE model context (agent.state.messages is resynced
   * immediately). A new tree branch in the SAME file; the abandoned branch is
   * preserved on disk. The follow-up re-send (edit/retry always re-prompts)
   * appends under the new leaf and persists it, so the fork survives a restart
   * (continueRecent seeds the leaf from the file's last entry = the new tip).
   * Already present at runtime on the real AgentSession. */
  navigateTree?(targetEntryId: string): Promise<{ cancelled: boolean; editorText?: string }>;
  /** The session's own SessionManager — a public field on the real
   * AgentSession (dist/core/agent-session.js). This is the minimal slice
   * forkAtMessage needs to branch the persisted session using the SAME
   * primitives pi's own `AgentSessionRuntime.fork()` composes them from
   * (dist/core/agent-session-runtime.js) — gaia holds a bare AgentSession,
   * never that wrapper, so it re-composes the primitives itself rather than
   * calling a single pre-built fork() method. Already present at runtime;
   * declared here so the typed cast can reach it. */
  readonly sessionManager?: {
    getEntry(id: string): { parentId: string | null | undefined } | undefined;
    getSessionFile(): string | undefined;
    /** Rewrite THIS manager's own on-disk file to hold only root→targetLeafId
     * (drops targetLeafId's siblings/descendants), returning the new file
     * path — or undefined when the session isn't persisted. Mutates the
     * manager in place (dist/core/session-manager.js). */
    createBranchedSession(targetLeafId: string): string | undefined;
    /** Start a brand-new empty session, recording `parentSession` as its
     * lineage — pi's own fallback when forking "before" the very first
     * message (no parent entry to branch to). Mutates the manager in place. */
    newSession(options?: { parentSession?: string }): string | undefined;
  };
  /** The session's own read-only SettingsManager (the instance gaia passes to
   * createAgentSession). compact() reaches it to force a smaller recent-keep
   * window when an explicit /compact would otherwise no-op as "session too
   * small". applyOverrides only mutates the in-memory merged settings — it never
   * writes to disk — so it is safe on the read-only manager. Already present at
   * runtime; declared here so the typed cast can reach it. */
  readonly settingsManager?: {
    getCompactionKeepRecentTokens(): number;
    applyOverrides(overrides: { compaction?: { keepRecentTokens?: number } }): void;
  };
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

// Any file under the room/agent's session dir means SessionManager.continueRecent
// has something to resume; an empty or missing dir means there is genuinely no
// session (fresh room or a room that never sent this agent a turn). Shared by
// the harness spec's hasDurableSession (host.ts's pre-spawn gate) and compact()'s
// own lazy-restore decision below — one on-disk truth, read twice.
/** Forced recent-keep window (tokens) for an EXPLICIT /compact that would
 * otherwise no-op because the whole session sits under pi's default 20000
 * keepRecentTokens floor (findCutPoint then finds nothing outside the kept
 * window). A user who runs /compact wants the session shrunk NOW, so the retry
 * keeps only a small live tail and summarizes the rest. Restored immediately. */
const FORCE_COMPACT_KEEP_RECENT_TOKENS = 2000;

function hasPersistedPiSession(rootDir: string, roomId: string, agentId: string): boolean {
  try {
    return readdirSync(piRoomSessionDir({ rootDir }, roomId, agentId)).length > 0;
  } catch {
    return false; // no dir ⇒ nothing to resume
  }
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

/** Text payload from Pi's SDK user-message event. Skill expansion always emits
 * one text content part; malformed/foreign messages stay invisible here. */
function piUserMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find((part): part is { type: "text"; text: string } =>
    Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"),
  );
  return text?.text;
}

// GAIA's ThinkingLevel adds "max" on top of pi's own ceiling (pi-agent-core's
// ThinkingLevel tops at "xhigh" — Claude CLI is the only harness that has a
// literal "max" effort). Clamp at the pi SDK boundary so a session never gets
// handed a level pi doesn't know: an unmapped string falls back to pi-ai's
// internal default ("high") inside mapThinkingLevelToEffort, which is WORSE
// than xhigh, not a safe no-op. Used both for session creation (thinkingLevel)
// and the hot per-turn override (setThinkingLevel) so pi always receives the
// same clamped vocabulary either way.
function toPiThinking(level: ThinkingLevel | string | undefined): any {
  return level === "max" ? "xhigh" : level;
}

const PI_CAPABILITIES: HarnessCapabilities = {
  gaiaTools: ["memory", "recall", "artifact", "summon", "resume", "gaia"],
  nativeTools: ["web"],
  granularTools: true,
  supportsPermissionMode: false,
  // Pi core has no MCP client (an adapter package exists but is not wired).
  supportsMcp: false,
  supportsSteer: true,
  supportsCompact: true,
  // Pi's own session.sessionManager.createBranchedSession/newSession branch
  // the persisted session to a NEW file at a prior user entry (see
  // PiRuntime.forkAtMessage) — unlike claude/codex, dropping the in-memory
  // session cache alone is a no-op here because SessionManager.continueRecent
  // would just resume the untouched file; the native fork is what makes
  // edit/retry actually change the model's context, and it's durable (a new
  // file, unlike an in-place rewind) so it survives a runner respawn.
  supportsForkAtMessage: true,
  // AgentSession.prompt() natively expands loaded `/skill:name` commands and
  // prompt templates. RoomService passes unclaimed slash tokens through; this
  // runtime dynamically aliases `/name` to its loaded `/skill:name` command.
  supportsNativeCommands: true,
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
  private readonly resumeCreate?: ResumeCreate;
  private readonly recallSearch?: RecallSearch;
  // ModelRuntime.create() is async (it can touch the network for catalog
  // refresh), but HarnessSpec.create() must return synchronously — so
  // construction kicks it off here and every path that touches the registry
  // awaits `modelRuntimeReady` first. `ensureSession` is the ONE choke point
  // every public entry (send/compact/forkAtMessage) already funnels through,
  // so gating there covers all of them without repeating the await.
  private modelRuntime!: ModelRuntime;
  private modelRegistry!: ModelRegistry;
  private readonly modelRuntimeReady: Promise<void>;
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
    this.resumeCreate = options.resumeCreate;
    this.recallSearch = options.recallSearch;
    this.cwd = options.workspace.rootDir;
    this.workDir = process.cwd();
    this.modelRuntimeReady = ModelRuntime.create().then((runtime) => {
      this.modelRuntime = runtime;
      this.modelRegistry = new ModelRegistry(runtime);
      this.applyCredentialProxy();
    });
    // Registry-independent: a real resolution failure surfaces later, loudly,
    // from resolveModel() once the turn actually runs (see its comment below).
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
    const realBaseUrl = findModelWithAlias(this.modelRegistry, provider, name)?.baseUrl;
    if (realBaseUrl) redirectProviderFetch(realBaseUrl, proxyUrl);
  }

  // Reports the model the live session actually uses once a turn has run;
  // before that, the configured model or "Pi default".
  get modelLabel(): string {
    return this.label.current;
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const meta = await this.ensureSession(input.roomId, input.activeRole, input.protocolThinkingLevel);
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
      // Pi emits the expanded `/skill:name` as the turn's user message. Mirror
      // that SDK event, rather than inferring a skill from the slash text, so
      // the room renders precisely the invocation Pi accepted (including its
      // resolved SKILL.md path and body).
      if (event.type === "message_start" && event.message.role === "user") {
        const text = piUserMessageText(event.message);
        const skill = text && parseSkillBlock(text);
        if (skill) channel.push({ type: "skill-invocation", skill: { name: skill.name, location: skill.location, content: skill.content } });
      }
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
    const prompt = input.nativeCommand
      ? this.nativeCommandPrompt(meta, input.message)
      : await buildTurnPromptFor(this.agent, input, this.memoryStore, this.sessions, { workDir: this.workDir, rootDir: this.cwd });
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

  /**
   * Pi owns skill-command expansion in AgentSession.prompt(): its canonical
   * syntax is `/skill:name`. Gaia accepts the terse `/name` spelling only as a
   * dynamic convenience alias: resolve against THIS session's ResourceLoader,
   * which is the same loaded-skill list Pi will expand. Templates and unknown
   * commands remain untouched for Pi to handle as-is.
   */
  private nativeCommandPrompt(meta: PiSessionMeta, message: string): string {
    const trimmed = message.trim();
    const match = /^\/([^\s]+)([\s\S]*)$/.exec(trimmed);
    if (!match || match[1].startsWith("skill:")) return trimmed;
    const skill = meta.loader.getSkills().skills.find(({ name }) => name === match[1]);
    return skill ? `/skill:${skill.name}${match[2]}` : trimmed;
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
    session.setThinkingLevel(toPiThinking(target));
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
   * [summary + tail] instead of raw history).
   *
   * A cold daemon restart (or a fresh runner spawned solely to compact — see
   * host.ts's hasDurableSession pre-spawn gate) starts this process's
   * SessionMap empty even though a resumable session sits on disk: this
   * process never ran a turn for the room, so ensureSession was never called.
   * Lazily restore it here via the SAME session-creation core a turn uses,
   * just without a turn's activeRole (this command carries only roomId — no
   * room state crosses the runner boundary for /compact) — a role-less
   * system prompt is fine because compact never sends a prompt, and the next
   * real turn's own roleKey mismatch already forces the correct rebuild
   * (SessionMap.systemPrompt + skillPathsKey diff in ensureSession). Only when
   * there is truly nothing on disk do we return the clean no-op. */
  async compact(roomId: string): Promise<CompactResult> {
    let meta = this.sessions.get(roomId);
    if (!meta) {
      if (!hasPersistedPiSession(this.workspace.rootDir, roomId, this.agent.id)) return NO_SESSION_TO_COMPACT;
      meta = await this.ensureSession(roomId, undefined);
    }
    const session = meta.session;
    if (!session.compact) return NO_SESSION_TO_COMPACT;

    const toResult = (result: { summary: string; tokensBefore: number; estimatedTokensAfter?: number }): CompactResult => {
      const after = result.estimatedTokensAfter !== undefined ? ` → ~${result.estimatedTokensAfter}` : "";
      return {
        compacted: true,
        message: `session compacted (${result.tokensBefore} tokens before${after}).`,
        ...(result.summary ? { summary: result.summary } : {}),
      };
    };

    try {
      return toResult(await session.compact());
    } catch (error) {
      // pi-ai's own session.compact() throws (rather than returning a result)
      // when its cutPoint search finds nothing outside the always-kept "recent"
      // window (default keepRecentTokens: 20000 tokens — see
      // @earendil-works/pi-coding-agent dist/core/compaction/compaction.js
      // prepareCompaction/findCutPoint). "Already compacted" (last entry is a
      // compaction boundary) is a real no-op. But "too small" only means the
      // WHOLE session fits under that 20000-token floor — NOT that there's
      // nothing worth trimming: for an EXPLICIT /compact the user wants it
      // shrunk NOW (a poisoned/heavy tail the model keeps re-reading, a room
      // that won't reply). So retry ONCE with a small forced recent-keep window
      // (FORCE_COMPACT_KEEP_RECENT_TOKENS) so findCutPoint has something to cut,
      // then restore the real floor — the override is in-memory only
      // (applyOverrides never writes to disk, safe on the read-only manager).
      // This is not a session-loss/restore bug (that case is NO_SESSION_TO_COMPACT
      // above, fixed by 64cff59's lazy restore).
      const msg = error instanceof Error ? error.message : String(error);
      if (/already compacted/i.test(msg)) {
        return { compacted: false, message: `nothing to compact — ${msg.toLowerCase()}.` };
      }
      if (!/too small/i.test(msg)) throw error;

      // "too small" = the whole session fits under pi's 20000-token
      // keepRecentTokens floor. For an EXPLICIT /compact the user still wants it
      // shrunk, so retry once with a small forced recent-keep window so
      // findCutPoint has something to cut, then restore the real floor (the
      // override is in-memory only — applyOverrides never writes to disk). If we
      // can't reach the settings manager, or even the forced window finds
      // nothing (a genuinely tiny one-turn session), fall through to the same
      // clean no-op contract the other harnesses use.
      if (session.settingsManager) {
        const original = session.settingsManager.getCompactionKeepRecentTokens();
        session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: FORCE_COMPACT_KEEP_RECENT_TOKENS } });
        try {
          return toResult(await session.compact());
        } catch (retryError) {
          const rmsg = retryError instanceof Error ? retryError.message : String(retryError);
          if (!/too small/i.test(rmsg) && !/already compacted/i.test(rmsg)) throw retryError;
        } finally {
          session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: original } });
        }
      }
      return { compacted: false, message: `nothing to compact — ${msg.toLowerCase()}.` };
    }
  }

  /** Native pi fork (backs edit/retry — capabilities.supportsForkAtMessage).
   * Unlike claude/codex, dropping this room's session cache alone is a no-op
   * for pi: SessionManager.continueRecent would just resume the untouched
   * on-disk file on the next turn, so the model keeps seeing the "rewound"
   * turns and the edit/retry never actually changes its context (the bug
   * this whole feature fixes).
   *
   * Composed from the SAME primitives pi's own `AgentSessionRuntime.fork()`
   * uses (dist/core/agent-session-runtime.js) — gaia holds a bare
   * `AgentSession` from `createAgentSession()`, never that wrapper, so it
   * re-composes the primitives itself instead of calling one pre-built
   * method: `session.sessionManager.createBranchedSession(parentId)` (or
   * `.newSession()` when forking before the very first message — pi's own
   * fallback, no parent entry to branch to) rewrites the manager's on-disk
   * file to hold only root→parent(target), dropping target and everything
   * after — "position: before" in pi's own vocabulary, matching gaia's WAL
   * rewind (the origin is re-sent fresh right after this resolves). The
   * fork WRITES A NEW SESSION FILE (durable — survives a runner
   * respawn/restart, unlike an in-place rewind): this session's own
   * `PiSessionMeta` is then reset (disposed + dropped) and lazily rebuilt via
   * the SAME `ensureSession` a normal turn uses, so its
   * `SessionManager.continueRecent()` call resumes the just-written branch
   * (now the newest file in the room's session dir) — no different from a
   * cold-daemon restore. Assumes the session is IDLE (safe: room-service only
   * calls this between turns, never mid-turn).
   *
   * Mapping gaia's origin onto pi's own entry addressing is by POSITION, not
   * text. Text matching was tried first and is fundamentally unreliable: pi
   * records the buildTurnPrompt-WRAPPED prompt (room header, agent line,
   * worktree note, memory/recall blocks, transcript, "Newest user message:"
   * header, …) as the user-entry text — NOT gaia's raw event text — and
   * gaia's origin text additionally carries the "@agent " mention prefix, so
   * no substring relation holds (this is exactly the fallback-to-resetRoom
   * bug the live echo test caught). Instead `userOrdinal` is the origin's
   * 1-based index among the room's user messages, and pi's
   * getUserMessagesForForking() returns its user entries IN ORDER — so the
   * target is simply entries[userOrdinal - 1]. This assumes a 1:1
   * correspondence between gaia user turns and pi user entries (one gaia user
   * message = one prompt() = one pi user entry); a mid-turn steer that pi
   * recorded as an extra user entry would desync the ordinal — out of scope
   * for now (a rare edit-during-steer case), and a wrong ordinal only
   * mis-targets the branch, it can't corrupt anything.
   *
   * Branch BEFORE the target: getEntry(target).parentId is the fork point.
   * When parentId is null (userOrdinal === 1, the very first message)
   * there is no parent to branch to, so pi's own fallback applies — start a
   * fresh session via newSession({parentSession}), which records lineage and
   * returns a new file path. Otherwise createBranchedSession(parentId)
   * rewrites the manager's file to root→parent, dropping the target and
   * everything after — "position: before" in pi's own vocabulary, matching
   * gaia's WAL rewind (the origin is re-sent fresh right after this resolves).
   *
   * Returns {ok:false} on any of: no persisted session, the SDK session
   * lacking the fork methods (older pi build), the ordinal out of range, the
   * target entry missing, or the session not being persisted to disk (the
   * fork write returns no path) — callers fall back to the shared
   * WAL-reset-and-replay path in every one of these cases. */
  async forkAtMessage(roomId: string, originEventId: string, userOrdinal: number): Promise<{ ok: boolean; message: string }> {
    let meta = this.sessions.get(roomId);
    if (!meta) {
      if (!hasPersistedPiSession(this.workspace.rootDir, roomId, this.agent.id)) return { ok: false, message: "no active pi session for this room" };
      meta = await this.ensureSession(roomId, undefined);
    }
    const session = meta.session;
    if (!session.getUserMessagesForForking || !session.navigateTree) {
      return { ok: false, message: "this pi session build does not support native forking" };
    }
    const entries = session.getUserMessagesForForking();
    if (userOrdinal < 1 || userOrdinal > entries.length) {
      return { ok: false, message: `fork ordinal ${userOrdinal} out of range (session has ${entries.length} user entries; event ${originEventId})` };
    }
    const target = entries[userOrdinal - 1];
    // Pi's native fork: navigateTree drops this user message + everything after
    // from the LIVE context (new leaf = target's parent) and branches the tree.
    // Keep the session LIVE (do NOT dispose): the rewind lives in the running
    // session, and the follow-up re-send appends under the new leaf + persists
    // it, so it survives a restart.
    const result = await session.navigateTree(target.entryId);
    if (result?.cancelled) {
      return { ok: false, message: `pi navigateTree cancelled for entry ${target.entryId} (ordinal ${userOrdinal})` };
    }
    return { ok: true, message: `forked pi session at user message ${userOrdinal} (entry ${target.entryId})` };
  }

  private async ensureSession(roomId: string, activeRole: ResolvedRole | undefined, thinkingLevel?: number): Promise<PiSessionMeta> {
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
    // Pi's translation of the harness-agnostic `web` tool: claude/codex expose a
    // native web tool, pi shells out to the brave-search skill (its search.js —
    // so a `web` pi agent also needs `bash` + a BRAVE_API_KEY). Local mapping,
    // never a shared-code branch. Deduped against explicitly assigned skills.
    if (this.agent.tools.includes("web") && !skillNames.includes("brave-search")) skillNames.push("brave-search");
    const skillResolution = skillNames.length ? resolveSkillRefs(this.workspace, skillNames) : { paths: [], diagnostics: [] };
    for (const diagnostic of skillResolution.diagnostics) console.warn(diagnostic);

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
          const recreated = await this.createSessionMeta(roomId, systemPrompt, skillResolution.paths, key);
          this.sessions.set(roomId, recreated);
          return recreated;
        }
      }
      return existing;
    }

    // Skill paths changed (or no session yet): reset drops the old session AND
    // its memory diff, so the rebuilt session re-receives memory.
    if (existing) this.sessions.reset(roomId);
    const meta = await this.createSessionMeta(roomId, systemPrompt, skillResolution.paths, key);
    this.sessions.set(roomId, meta);
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
      workDir: this.workDir,
      availableAgents: agentRoster(this.workspace),
      summonCreate: this.summonCreate,
      resumeCreate: this.resumeCreate,
      recallSearch: this.recallSearch,
    });
    const systemPromptRef = { current: systemPrompt };

    const loader = new DefaultResourceLoader({
      cwd: this.workDir,
      agentDir: getAgentDir(),
      additionalSkillPaths: skillPaths,
      noExtensions: true,
      noSkills: true,
      // Keep Pi's template discovery enabled: AgentSession.prompt() expands
      // these itself when RoomService passes a native slash command through.
      noThemes: true,
      noContextFiles: true,
      // Two modes, keyed on agent.json `promptLaw`:
      // - promptLaw UNSET (default): pi's own base system prompt (tool usage,
      //   conventions, docs pointers) stays — gaia's assembled layer rides
      //   APPENDED via pi's append mechanism (customPrompt undefined ⇒ pi
      //   builds its default base, then appends this section + skills).
      // - promptLaw SET: the law must be the ABSOLUTE FIRST tokens, so the
      //   daemon-built prompt (promptLaw already at index 0) REPLACES pi's
      //   base entirely via systemPromptOverride (system-prompt.js customPrompt
      //   path: our prompt first, then skills/cwd suffix). Tool-use with the
      //   replaced base is UNVERIFIED live.
      // Replace mode also pins the append channel to [] — otherwise the
      // loader discovers ~/.pi/agent/APPEND_SYSTEM.md and injects arbitrary
      // user-dir content above/after the law.
      ...(this.agent.promptLaw
        ? { systemPromptOverride: () => systemPromptRef.current, appendSystemPromptOverride: () => [] }
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

  // No configured model ⇒ legitimately fall through to the pi CLI's own
  // default (untouched). A CONFIGURED model that fails to resolve (even
  // after alias resolution) is a misconfiguration, not a provider choice —
  // silently handing the turn to Pi's default model previously masked this
  // (an OpenAI agent quietly ran on a Claude subscription model and hit a
  // billing 400 with zero signal the real fault was model resolution).
  // Throwing here — inside createSessionMeta, itself inside send()'s async
  // generator — surfaces through runner.ts's per-turn try/catch as a loud
  // `turn-error` naming the agent + what didn't resolve, the uniform
  // failure-reporting path every harness already uses (RULE #0: no new
  // mechanism, no harness-id branch in shared code — this stays pi-internal).
  private resolveModel(): Model<any> | undefined {
    const provider = this.agent.model?.provider;
    const name = this.agent.model?.name;
    if (!provider || !name) return undefined;
    const resolved = findModelWithAlias(this.modelRegistry, provider, name);
    if (resolved) return resolved;
    const availableProviders = Array.from(new Set(this.modelRegistry.getAll().map((model) => model.provider))).sort();
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
    // readStoredCredential is a one-off raw read (no refresh) — enough to tell
    // api-key/no-login (skip) from oauth (probe further) before paying for a
    // full ModelRuntime spin-up.
    cred = readStoredCredential(provider);
    if (!cred || cred.type !== "oauth") return { status: "none" }; // API-key or no login — no subscription meter.
    // ModelRuntime.getAuth auto-refreshes an expired OAuth token (locked, like the old AuthStorage.getApiKey).
    const runtime = await ModelRuntime.create();
    token = (await runtime.getAuth(provider))?.auth.apiKey;
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
  hasDurableSession: (rootDir, roomId, agentId) => hasPersistedPiSession(rootDir, roomId, agentId),
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
