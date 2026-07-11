// The Codex harness: one `codex app-server` JSON-RPC subprocess per runtime
// (each runtime lives in a per-(room, agent) runner subprocess — see host.ts),
// one persistent thread per room, item/* notifications mapped onto
// AgentEvents. All codex-specific knowledge (RPC methods, wire shapes, sandbox
// levels, cred env) lives HERE; shared code sees only the HarnessSpec.
//
// Gaia tools (memory/recall/summon) are wired as app-server dynamicTools: the
// SAME tool factories the Pi harness uses (typebox schemas are JSON Schema),
// declared on thread/start and executed here when the server calls back with
// item/tool/call. Threads persist across restarts via the uniform SessionMap
// store + thread/resume; a failed resume falls back to a fresh thread.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NO_SESSION_TO_COMPACT, type AgentDef, type AgentEvent, type CompactProgressUpdate, type CompactResult, type MessageAttachment, type McpServerConfig, type UsageProbeResult, type Workspace } from "../core/types.js";
import { nativeImageAttachments } from "../core/attachments.js";
import { resolveMcpServers } from "../core/config.js";
import { gaiaHome, workspacePaths } from "../core/paths.js";
import type { MemoryStore } from "../domain/memory.js";
import type { ResolvedRole } from "../domain/roles.js";
import {
  type AgentInput,
  type AgentRuntime,
  type HarnessCapabilities,
  type RecallSearch,
  registerHarness,
  type RuntimeCreateContext,
  type SummonCreate,
} from "./spec.js";
import { createEventChannel } from "./events.js";
import { fileSessionStore, SessionMap } from "./sessions.js";
import { missingBinaryError, spawnLineReader } from "./proc.js";
import { configuredModelLabel, ModelLabel } from "./model-label.js";
import { buildInlineSystemPrompt, buildTurnPromptFor } from "./prompt.js";
import { buildPiTools } from "./tools.js";
import { fetchChatGptUsage, OPENAI_USAGE_ACCOUNT } from "./usage.js";

// ---------------------------------------------------------------------------
// Internal JSON-RPC client abstraction (injectable for tests)
// ---------------------------------------------------------------------------

interface JsonRpcNotification {
  method: string;
  params: unknown;
}

export interface CodexClient {
  /** Send a JSON-RPC request (includes an `id`), returns the `result`. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Send a fire-and-forget notification (no `id`). */
  notify(method: string, params: unknown): void;
  /** Register a handler for server-pushed notifications. */
  setNotificationHandler(handler: ((msg: JsonRpcNotification) => void) | null): void;
  /** Register a handler for server-initiated REQUESTS (item/tool/call). The
   * handler's resolution is sent back as the JSON-RPC result; a rejection
   * becomes a JSON-RPC error. Unhandled methods are answered -32601. */
  setRequestHandler(handler: ((method: string, params: unknown) => Promise<unknown>) | null): void;
  /** Gracefully shut down the transport. */
  close(): Promise<void>;
  /** Accumulated stderr from the child process (for diagnostics). */
  readonly stderr: string;
}

export type CodexClientFactory = (cwd: string, env: typeof process.env) => Promise<CodexClient>;

// ---------------------------------------------------------------------------
// Default factory – spawns `codex app-server`
// ---------------------------------------------------------------------------

const DEFAULT_CLIENT_INFO = {
  name: "gaia-daemon",
  title: "GAIA Daemon",
  version: "0.0.0",
};

// experimentalApi opts into the dynamicTools field on thread/start (verified
// against codex-cli 0.142.2: the field is accepted only on that surface).
const DEFAULT_CAPABILITIES = {
  experimentalApi: true,
};

/** Convert an app-server tool diagnostic into displayable stream content. */
function toolErrorText(error: { message?: unknown } | string | null | undefined): string | undefined {
  if (typeof error === "string") return error || undefined;
  if (!error || typeof error.message !== "string" || !error.message) return undefined;
  return error.message;
}

/** Keep command output and its failure diagnostic together in the tool result. */
function toolResult(output: string | null | undefined, error: string | undefined, exitCode: number | null | undefined): string | undefined {
  const outputPart = output?.trim() ? output : undefined;
  const parts = [outputPart, error, exitCode !== undefined && exitCode !== null && exitCode !== 0 ? `Command exited with status ${exitCode}.` : undefined]
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("\n") : undefined;
}

function spawnCodexClient(cwd: string, env: typeof process.env): CodexClient {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let notifHandler: ((msg: JsonRpcNotification) => void) | null = null;
  let requestHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  let closed = false;
  let exitError: Error | null = null;

  function rejectAll(err: Error): void {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function sendRaw(msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }): void {
    if (closed) return;
    proc.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  // Shared spawn + stderr-accumulating line reader; the JSON-RPC framing on top
  // (the onLine router below + sendRaw) is the only codex-specific part.
  const { proc, rl, stderr } = spawnLineReader({
    command: "codex",
    args: ["app-server"],
    cwd,
    env,
    onLine: (line) => {
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      // Server-initiated request -> dispatch to the handler (dynamic tool
      // calls) or answer method-not-found.
      if (msg.id !== undefined && msg.method) {
        const id = msg.id;
        if (requestHandler) {
          requestHandler(msg.method, msg.params).then(
            (result) => sendRaw({ id, result }),
            (error: unknown) => sendRaw({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }),
          );
        } else {
          sendRaw({ id, error: { code: -32601, message: `Unsupported server request: ${msg.method}` } });
        }
        return;
      }

      // Response to one of our requests
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message ?? `codex app-server method failed.`));
        } else {
          p.resolve(msg.result ?? {});
        }
        return;
      }

      // Notification (no id)
      if (msg.method && notifHandler) {
        notifHandler(msg as JsonRpcNotification);
      }
    },
  });

  proc.on("error", (err) => {
    exitError = err;
    rejectAll(err);
  });

  proc.on("exit", (code, signal) => {
    if (code !== 0 && !exitError) {
      exitError = new Error(
        `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`,
      );
    }
    rejectAll(exitError ?? new Error("codex app-server connection closed."));
  });

  return {
    async request(method, params) {
      if (closed || exitError) throw exitError ?? new Error("codex app-server client is closed.");
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        sendRaw({ id, method, params });
      });
    },
    notify(method, params) {
      if (closed || exitError) return;
      sendRaw({ method, params });
    },
    setNotificationHandler(handler) {
      notifHandler = handler;
    },
    setRequestHandler(handler) {
      requestHandler = handler;
    },
    async close() {
      if (closed) return;
      closed = true;
      rl.close();
      proc.stdin?.end();
    },
    get stderr() {
      return stderr();
    },
  };
}

const defaultFactory: CodexClientFactory = async (cwd, env) => {
  return spawnCodexClient(cwd, env);
};

// ---------------------------------------------------------------------------
// Sandbox: DEFER to the uniform host sandbox (RULE #0)
// ---------------------------------------------------------------------------
//
// Confinement is decided ONCE, above the harness: resolveSandboxPolicy (trust
// tier + per-agent sandbox config) picks whether the gaia seatbelt wraps the
// whole runner process (sandbox/spec.ts + host.ts). Codex therefore does NOT
// run a second, internal sandbox of its own — exactly like claude, which has no
// internal sandbox at all. Its thread always runs `danger-full-access` and
// relies on that single host boundary.
//
// Why this is the only correct value:
//  • Codex's own "read-only"/"workspace-write" apply codex's OWN macOS seatbelt
//    to every shell command. When the host sandbox is ALSO on (an untrusted or
//    summon-default turn) that nests two seatbelts and `sandbox_apply` fails
//    with "Operation not permitted" — the agent can then run nothing at all.
//  • They can never express "unrestricted", so a trusted agent (claude and
//    codex are unrestricted by default; only pi runs confined) could never get
//    a working shell. Deferring to the one host boundary removes both problems.
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

/** Codex runs its thread unconfined internally and defers confinement to the
 *  uniform host sandbox (the gaia seatbelt RunnerHost wraps the runner in). */
export const CODEX_SANDBOX_MODE: CodexSandbox = "danger-full-access";

// ---------------------------------------------------------------------------
// Persistent thread state (tracked by the uniform SessionMap; serializable —
// the file store carries it across restarts for thread/resume)
// ---------------------------------------------------------------------------

interface ThreadState {
  threadId: string;
  model: string;
  modelProvider: string;
}

/** thread/tokenUsage/updated payload (app-server protocol v2). */
interface CodexTokenUsage {
  total?: { totalTokens?: number };
  last?: { totalTokens?: number };
  modelContextWindow?: number | null;
}

// The shape a pi tool factory returns (defineTool), as far as codex needs it:
// typebox `parameters` doubles as the dynamic tool's JSON Schema, and execute
// runs in THIS process — same code path as the pi harness's in-process tools.
interface PiToolLike {
  name: string;
  description: string;
  parameters?: unknown;
  execute(toolCallId: string, params: unknown): Promise<{ content?: Array<{ type: string; text?: string }>; details?: unknown }>;
}

interface DynamicToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments?: unknown;
}

function dynamicToolSpec(tool: PiToolLike): { type: "function"; name: string; description: string; inputSchema: unknown } {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters ?? { type: "object", properties: {} },
  };
}

// GAIA thinking levels -> Codex `turn/start.effort` (ReasoningEffort). Codex's
// reasoning models have no "off"; floor at "low" — same shape as claude.ts's
// effortFor (Claude and Codex share the low/medium/high/xhigh vocabulary).
function effortFor(level: string | undefined): string | undefined {
  switch (level) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return undefined;
  }
}

/** GAIA's harness-neutral MCP shape → codex `mcp_servers` config overrides
 * (the config.toml table, passed per thread). Exported for tests. */
export function codexMcpServersConfig(servers: Record<string, McpServerConfig>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(servers)) {
    out[name] = {
      ...(server.command ? { command: server.command } : {}),
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
      ...(server.url ? { url: server.url } : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// CodexRuntime
// ---------------------------------------------------------------------------

export interface CodexRuntimeOptions extends RuntimeCreateContext {
  /** Injectable client factory for testing. */
  clientFactory?: CodexClientFactory;
}

// Dynamic tools close the old asymmetry: memory/recall/summon are real
// in-process tools under Codex, exactly like Pi. The per-agent tools array IS
// honored (memory/recall/summon/web are toggled from it); codex's own
// file+shell tools are always available under the single host-sandbox boundary
// (see CODEX_SANDBOX_MODE), so the tools field is a real control surface and
// stays visible in settings (granularTools: true).
const CODEX_CAPABILITIES: HarnessCapabilities = {
  gaiaTools: ["memory", "recall", "summon"],
  nativeTools: ["web"],
  granularTools: true,
  supportsPermissionMode: false,
  supportsMcp: true,
  supportsSteer: true,
  supportsCompact: true,
  // Codex has no skill/slash-command passthrough surface.
  supportsNativeCommands: false,
  // Codex has no native subagent tool — its only fan-out is the gaia summon tool.
  fanOutTools: [],
};

export class CodexRuntime implements AgentRuntime {
  readonly capabilities = CODEX_CAPABILITIES;
  readonly agent: AgentDef;
  private readonly workspace: Workspace;
  private readonly memoryStore: MemoryStore;
  private readonly summonCreate?: SummonCreate;
  private readonly recallSearch?: RecallSearch;
  private client: CodexClient | null = null;
  private initPromise: Promise<CodexClient> | null = null;
  private readonly cwd: string;
  /** Where the agent child RUNS: this runner process's own cwd — RunnerHost
   * set it to the room's git worktree (RoomState.workDir) or the workspace
   * root. Distinct from this.cwd (workspace root), which anchors daemon
   * state paths (session stores, room dirs) that must never move with the
   * checkout. */
  private readonly workDir: string;
  private readonly threads: SessionMap<ThreadState>;
  /** In-process dynamic tools per room (rebuilt per process — not persisted). */
  private readonly roomTools = new Map<string, Map<string, PiToolLike>>();
  /** Thread ids live on the CURRENT app-server process; a persisted thread not
   * in here must go through thread/resume before its next turn. */
  private readonly attachedThreads = new Set<string>();
  private activeTurn: { threadId: string; turnId: string } | null = null;
  private readonly clientFactory: CodexClientFactory;
  private readonly label: ModelLabel;

  constructor(options: CodexRuntimeOptions) {
    this.workspace = options.workspace;
    this.agent = options.agent;
    this.memoryStore = options.memoryStore;
    this.summonCreate = options.summonCreate;
    this.recallSearch = options.recallSearch;
    this.cwd = options.workspace.rootDir;
    this.workDir = process.cwd();
    this.threads = new SessionMap<ThreadState>(undefined, fileSessionStore(this.cwd, "codex", this.agent.id));
    this.clientFactory = options.clientFactory ?? defaultFactory;
    this.label = new ModelLabel(this.resolveModelLabel());
  }

  get modelLabel(): string {
    return this.label.current;
  }

  // -----------------------------------------------------------------------
  // send – streaming turn
  // -----------------------------------------------------------------------

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const client = await this.ensureClient();

    // Ensure a persistent thread exists for this room. A thread hydrated from
    // the session store (prior process) is resumed on this app-server first;
    // a failed resume (rollout pruned) falls back to a fresh thread.
    let thread = this.threads.get(input.roomId);
    let announce = false;
    if (thread && !this.attachedThreads.has(thread.threadId)) {
      thread = await this.resumeThread(client, thread, input.roomId, input.activeRole);
      announce = Boolean(thread);
    }
    if (!thread) {
      thread = await this.startThread(client, input);
      this.threads.set(input.roomId, thread);
      announce = true;
    }
    if (announce) {
      const info = { type: "model-info", provider: thread.modelProvider, modelId: thread.model, subscription: true } as const;
      this.label.observe(info);
      yield info;
    }

    // The uniform turn-prompt composition (memory travels only when it changed
    // — the persistent thread already saw the previous block), shared with
    // every runtime via buildTurnPromptFor.
    const prompt = await buildTurnPromptFor(this.agent, input, this.memoryStore, this.threads, { workDir: this.workDir, rootDir: this.cwd });

    // Start the turn. Pasted images ride as localImage input items (the same
    // shape `codex -i <file>` produces); the app-server reads the paths itself.
    // Reasoning summary is ALWAYS "detailed" — configOverride() also sets it
    // thread-wide at thread/start/resume, but that alone doesn't stick: a live
    // rollout (gpt-5.6-terra, thread/start config.model_reasoning_summary=
    // "detailed") recorded turn_context.summary as "auto" regardless, while
    // turn_context.effort correctly reflected the per-turn `effort` sent
    // below. TurnStartParams has its own `summary` override field ("Override
    // the reasoning summary for this turn and subsequent turns") — same shape
    // as `effort` — so it has to travel per turn/start too, not just once at
    // thread creation. Effort DOES need to travel per turn/start: it's the
    // one knob a per-turn override (e.g. voice forcing thinking off) can
    // change mid-thread, mirroring claude.ts's effortFor(thinkingOverride ??
    // this.agent.thinking).
    const effort = effortFor(input.thinking ?? this.agent.thinking);
    const turnResponse = (await client.request("turn/start", {
      threadId: thread.threadId,
      input: [
        { type: "text", text: prompt, text_elements: [] },
        ...nativeImageAttachments(input.attachments).map((file) => ({ type: "localImage", path: file.path })),
      ],
      model: this.agent.model?.name ?? null,
      summary: "detailed",
      ...(effort ? { effort } : {}),
    })) as { turn: { id: string; status: string } };

    this.activeTurn = { threadId: thread.threadId, turnId: turnResponse.turn.id };

    const channel = createEventChannel();

    // Per-turn tracking
    const toolNames = new Map<string, string>();
    const reasoningStarted = new Set<string>();

    client.setNotificationHandler((msg) => {
      const { method, params } = msg;
      switch (method) {
        case "model/rerouted": {
          const p = params as { fromModel?: string; toModel: string; reason?: string; threadId: string; turnId: string };
          const currentThread = this.threads.get(input.roomId);
          if (p.toModel && currentThread) {
            const from = p.fromModel ?? currentThread.model;
            currentThread.model = p.toModel;
            const info = { type: "model-info", provider: currentThread.modelProvider, modelId: p.toModel, subscription: true } as const;
            this.label.observe(info);
            channel.push(info);
            if (from && from !== p.toModel) {
              channel.push({
                type: "model-fallback",
                fromModel: from,
                toModel: p.toModel,
                reason: p.reason?.trim() || `rerouted to ${p.toModel} by the provider`,
              });
            }
          }
          break;
        }

        case "thread/tokenUsage/updated": {
          // Context occupancy is the LAST turn's total, not the thread total:
          // usage.total is CUMULATIVE across every turn, so it climbs past the
          // window and the ctx chip reads >100% (a live 414% is what surfaced
          // this). usage.last is the most recent turn — its input already
          // contains the whole prior context, so its total tracks how full the
          // window actually is, and drops after a /compact or /clear. Fall back
          // to total only if last is missing. modelContextWindow is the window
          // size. Shape confirmed against the codex 0.142.2 binary schema
          // (ThreadTokenUsage = { total, last, modelContextWindow }, wrapper
          // field `tokenUsage`) and a live probe: first turn last==total, then
          // total climbs unboundedly while last tracks real occupancy. `usage`
          // is a defensive alias; the real wrapper is `tokenUsage`.
          const p = params as { usage?: CodexTokenUsage; tokenUsage?: CodexTokenUsage };
          const usage = p.usage ?? p.tokenUsage;
          const used = usage?.last?.totalTokens ?? usage?.total?.totalTokens;
          if (typeof used === "number") {
            channel.push({
              type: "context-usage",
              usedTokens: used,
              ...(typeof usage?.modelContextWindow === "number" ? { maxTokens: usage.modelContextWindow } : {}),
            });
          }
          break;
        }

        case "item/agentMessage/delta": {
          const p = params as { delta: string };
          channel.push({ type: "text-delta", delta: p.delta });
          break;
        }

        case "item/reasoning/textDelta": {
          const p = params as { itemId: string; delta: string };
          if (!reasoningStarted.has(p.itemId)) {
            reasoningStarted.add(p.itemId);
            channel.push({ type: "thinking-start" });
          }
          channel.push({ type: "thinking-delta", delta: p.delta });
          break;
        }

        case "item/completed": {
          const item = (
            params as {
              item: {
                id: string;
                type: string;
                command?: string;
                tool?: string;
                server?: string;
                arguments?: unknown;
                aggregatedOutput?: string | null;
                exitCode?: number | null;
                summary?: string[];
                content?: string[];
                result?: unknown;
                error?: { message?: unknown } | string | null;
                success?: boolean | null;
              };
            }
          ).item;

          // reasoning completed
          if (item.type === "reasoning") {
            const c = item.summary ?? item.content;
            channel.push({ type: "thinking-end", content: Array.isArray(c) ? c.join("\n") : undefined });
            return;
          }

          // Only tool-type items produce tool-end. Non-tool items also arrive as
          // item/completed (userMessage echo, the final agentMessage, plan, etc.);
          // ignore them so they don't surface as spurious tool calls.
          if (
            item.type !== "commandExecution" &&
            item.type !== "mcpToolCall" &&
            item.type !== "dynamicToolCall"
          ) {
            break;
          }

          // tool completed
          const tn = toolNames.get(item.id) ?? item.tool ?? item.type;
          const isErr =
            item.type === "commandExecution"
              ? (item.exitCode ?? 1) !== 0
              : item.type === "dynamicToolCall"
                ? item.success === false
                : !!item.error;

          // The app-server leaves `aggregatedOutput` empty for some failed
          // commands and puts the useful diagnostic on `error` instead.  Do
          // not turn that into an empty tool row: every failure needs a result
          // the uniform stream/UI can persist and render.
          const error = toolErrorText(item.error);
          const res =
            item.type === "commandExecution"
              ? toolResult(item.aggregatedOutput, error, item.exitCode)
              : item.type === "dynamicToolCall"
                ? item.result ?? error ?? item.arguments
                : item.result ?? error;

          channel.push({ type: "tool-end", toolName: tn, toolCallId: item.id, result: res, isError: isErr });
          break;
        }

        case "item/started": {
          const item = (params as { item: { id: string; type: string; command?: string; tool?: string; server?: string; arguments?: unknown } })
            .item;

          if (
            item.type === "commandExecution" ||
            item.type === "mcpToolCall" ||
            item.type === "dynamicToolCall"
          ) {
            const tn = item.type === "commandExecution"
              ? item.command ?? "command"
              : item.tool ?? item.type;
            toolNames.set(item.id, tn);

            channel.push({
              type: "tool-start",
              toolName: tn,
              toolCallId: item.id,
              args: item.type === "commandExecution" ? { command: item.command } : item.arguments,
            });
          }
          break;
        }

        case "command/exec/outputDelta":
        case "item/commandExecution/outputDelta": {
          const p = params as { itemId: string; delta: string };
          const tn = toolNames.get(p.itemId) ?? "command";
          channel.push({ type: "tool-update", toolName: tn, toolCallId: p.itemId, partialResult: p.delta });
          break;
        }

        case "item/mcpToolCall/progress": {
          const p = params as { itemId: string; message: string };
          const tn = toolNames.get(p.itemId) ?? "mcp";
          channel.push({ type: "tool-update", toolName: tn, toolCallId: p.itemId, partialResult: p.message });
          break;
        }

        case "turn/completed": {
          const t = (params as { turn: { status: string; error?: { message?: string } } }).turn;
          if (t.status === "failed") {
            channel.fail(new Error(t.error?.message ?? "Turn failed."));
          }
          channel.close();
          break;
        }

        case "error": {
          const e = (params as { error: { message: string } }).error;
          channel.fail(new Error(e.message));
          channel.close();
          break;
        }
      }
    });

    try {
      for await (const event of channel.stream()) yield event;
    } finally {
      this.activeTurn = null;
    }
  }

  // -----------------------------------------------------------------------
  // abort
  // -----------------------------------------------------------------------

  async abort(): Promise<void> {
    if (!this.client || !this.activeTurn) return;
    try {
      await this.client.request("turn/interrupt", {
        threadId: this.activeTurn.threadId,
        turnId: this.activeTurn.turnId,
      });
    } catch {
      // Best-effort
    }
  }

  /** Inject guidance into the room's running turn via turn/steer. Pasted images
   * ride as localImage input items — the same shape turn/start uses (the
   * app-server reads the paths itself); non-image files stay path breadcrumbs
   * in the message text. */
  async steer(roomId: string, message: string, attachments?: MessageAttachment[]): Promise<boolean> {
    const thread = this.threads.get(roomId);
    if (!this.client || !this.activeTurn || !thread || this.activeTurn.threadId !== thread.threadId) return false;
    try {
      await this.client.request("turn/steer", {
        threadId: this.activeTurn.threadId,
        expectedTurnId: this.activeTurn.turnId,
        input: [
          { type: "text", text: message, text_elements: [] },
          ...nativeImageAttachments(attachments).map((file) => ({ type: "localImage", path: file.path })),
        ],
      });
      return true;
    } catch {
      return false; // turn just settled — the precondition failed
    }
  }

  /** Native codex compaction (backs /compact): thread/compact/start returns
   * `{}` immediately; completion is the compact turn settling. Codex 0.142.x
   * emits this as an `item/completed` for `contextCompaction` followed by
   * `turn/completed` (older builds may still emit `thread/compacted`). Runs only
   * between turns (room-service gates on an idle room), so temporarily owning
   * the notification handler is safe — the next send() replaces it.
   *
   * CompactResult.summary is legitimately ABSENT here: the app-server's compact
   * notifications do not expose the summary text on the wire, and the shared
   * layer degrades gracefully by storing none (see CompactResult in
   * core/types.ts). This is the documented can't-expose case, not a
   * wire-it-later gap. */
  async compact(roomId: string, onProgress?: (update: CompactProgressUpdate) => void): Promise<CompactResult> {
    // The persisted thread lives on disk (SessionMap hydrates from the store), so
    // a cold app-server — daemon restart, idle-disposed or freshly-spawned runner
    // — has NOT attached it yet. thread/compact/start requires an attached thread,
    // so resume it first exactly as the turn path does; only genuinely-absent
    // history returns the no-op. (This is the claude parity gap: claude's /compact
    // resumes its session file directly; codex must re-attach the thread. Without
    // this, /compact right after any restart reported "nothing to compact" while
    // the session was at 89% — the thread simply wasn't live in this process.)
    if (!this.threads.get(roomId)) return NO_SESSION_TO_COMPACT;
    const client = await this.ensureClient();
    let thread = this.threads.get(roomId);
    if (thread && !this.attachedThreads.has(thread.threadId)) {
      thread = await this.resumeThread(client, thread, roomId);
    }
    if (!thread || !this.attachedThreads.has(thread.threadId)) {
      return NO_SESSION_TO_COMPACT;
    }
    const attached = thread;
    let sawContextCompaction = false;
    const done = new Promise<void>((resolve, reject) => {
      client.setNotificationHandler((msg) => {
        const params = msg.params as
          | {
              threadId?: string;
              item?: { type?: string };
              turn?: { id?: string; status?: string; error?: { message?: string } };
              usage?: CodexTokenUsage;
              tokenUsage?: CodexTokenUsage;
              error?: { message?: string };
            }
          | undefined;
        if (params?.threadId !== attached.threadId) return;

        // Legacy app-server builds used a single compacted notification. Keep
        // accepting it, but current Codex reports compaction as an ordinary
        // compact turn: contextCompaction item -> turn/completed.
        if (msg.method === "thread/compacted") {
          resolve();
          return;
        }

        if (msg.method === "turn/started") {
          if (typeof params.turn?.id === "string") this.activeTurn = { threadId: attached.threadId, turnId: params.turn.id };
          return;
        }

        if (msg.method === "thread/tokenUsage/updated") {
          const usage = params.usage ?? params.tokenUsage;
          const used = usage?.last?.totalTokens ?? usage?.total?.totalTokens;
          if (typeof used === "number") onProgress?.({ outputTokens: used });
          return;
        }

        if (msg.method === "item/completed" && params.item?.type === "contextCompaction") {
          sawContextCompaction = true;
          return;
        }

        if (msg.method === "turn/completed") {
          if (params.turn?.status === "failed") {
            reject(new Error(params.turn.error?.message ?? "codex compaction failed."));
            return;
          }
          // For the current protocol wait until the contextCompaction item has
          // completed, then let the turn/completed notification be the durable
          // boundary. If a future app-server suppresses item notifications for
          // compact turns, the first matching completed turn after our compact
          // request is still the right boundary: compact() is only invoked while
          // no normal turn is active.
          if (sawContextCompaction || params.turn?.status === "completed") resolve();
          return;
        }

        if (msg.method === "error") {
          reject(new Error(params.error?.message ?? "codex compaction failed."));
        }
      });
    });
    try {
      await client.request("thread/compact/start", { threadId: attached.threadId });
      await done; // the RunnerHost round-trip timeout bounds this wait
    } finally {
      if (this.activeTurn?.threadId === attached.threadId) this.activeTurn = null;
    }
    return { compacted: true, message: "thread compacted by codex." };
  }

  // -----------------------------------------------------------------------
  // dispose
  // -----------------------------------------------------------------------

  dispose(): void {
    this.client?.close().catch(() => {});
    this.client = null;
    // disposeAll keeps the persisted thread handles: the next process resumes.
    this.threads.disposeAll();
    this.roomTools.clear();
    this.attachedThreads.clear();
    this.activeTurn = null;
    this.initPromise = null;
  }

  // Forget this room's Codex thread — everywhere, including the session store —
  // so the next turn opens a fresh one (/clear).
  resetRoom(roomId: string): void {
    const thread = this.threads.get(roomId);
    if (thread) this.attachedThreads.delete(thread.threadId);
    this.threads.reset(roomId);
    this.roomTools.delete(roomId);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async ensureClient(): Promise<CodexClient> {
    if (this.client) return this.client;
    if (!this.initPromise) {
      // A fresh app-server process knows none of our persisted threads.
      this.attachedThreads.clear();
      // The app-server child inherits this runner process's env untouched: the
      // uniform gaia bridge env (GAIA_MEMORY_DIR/GAIA_ROOM_*/GAIA_AGENT_ID/
      // GAIA_DAEMON_*) was composed ONCE by RunnerHost.buildEnv, and gaia tools
      // run in THIS process via dynamicTools — nothing codex-local to add.
      this.initPromise = this.clientFactory(this.workDir, process.env)
        .then(async (client) => {
          try {
            await client.request("initialize", {
              clientInfo: DEFAULT_CLIENT_INFO,
              capabilities: DEFAULT_CAPABILITIES,
            });
            client.notify("initialized", {});
            client.setRequestHandler((method, params) => this.handleServerRequest(method, params));
            return client;
          } catch (error) {
            await client.close().catch(() => {});
            throw missingBinaryError("codex", "Codex app-server", error, client.stderr);
          }
        })
        .catch((error) => {
          this.initPromise = null;
          throw error instanceof Error && error.message.startsWith("Codex app-server is unavailable:")
            ? error
            : missingBinaryError("codex", "Codex app-server", error);
        });
    }
    this.client = await this.initPromise;
    return this.client;
  }

  private async startThread(client: CodexClient, input: AgentInput): Promise<ThreadState> {
    // Gaia tools are native dynamic tools here (self-describing, like Pi's
    // in-process tools), so the system prompt carries no CLI pointer.
    const baseInstructions = await buildInlineSystemPrompt({
      workspace: this.workspace,
      agent: this.agent,
      role: input.activeRole,
      toolPointer: "",
    });
    const tools = await this.buildRoomTools(input.roomId);

    const response = (await client.request("thread/start", {
      cwd: this.workDir,
      model: this.agent.model?.name ?? null,
      modelProvider: this.agent.model?.provider ?? null,
      baseInstructions,
      ephemeral: false,
      // Codex defers confinement to the uniform host sandbox (see
      // CODEX_SANDBOX_MODE) — never a second, nested seatbelt of its own.
      sandbox: CODEX_SANDBOX_MODE,
      ...(tools.size > 0 ? { dynamicTools: [...tools.values()].map(dynamicToolSpec) } : {}),
      ...this.configOverride(),
    })) as { thread: { id: string }; model: string; modelProvider: string };

    this.attachedThreads.add(response.thread.id);
    return {
      threadId: response.thread.id,
      model: response.model,
      modelProvider: response.modelProvider,
    };
  }

  /** Re-attach a persisted thread to this app-server process. Returns the
   * refreshed state, or undefined (store cleared) when the rollout is gone —
   * the caller then starts a fresh thread. thread/resume cannot re-declare
   * dynamicTools (0.142.2), but the thread keeps the specs it started with;
   * the executor map is rebuilt here so item/tool/call still lands. */
  private async resumeThread(
    client: CodexClient,
    state: ThreadState,
    roomId: string,
    activeRole?: ResolvedRole,
  ): Promise<ThreadState | undefined> {
    try {
      const baseInstructions = await buildInlineSystemPrompt({
        workspace: this.workspace,
        agent: this.agent,
        role: activeRole,
        toolPointer: "",
      });
      await this.buildRoomTools(roomId);
      const response = (await client.request("thread/resume", {
        threadId: state.threadId,
        cwd: this.workDir,
        model: this.agent.model?.name ?? null,
        modelProvider: this.agent.model?.provider ?? null,
        baseInstructions,
        sandbox: CODEX_SANDBOX_MODE,
        ...this.configOverride(),
      })) as { thread: { id: string }; model: string; modelProvider: string };
      const next: ThreadState = {
        threadId: response.thread.id,
        model: response.model,
        modelProvider: response.modelProvider,
      };
      this.attachedThreads.add(next.threadId);
      this.threads.set(roomId, next);
      return next;
    } catch {
      this.threads.reset(roomId);
      return undefined;
    }
  }

  /** Build (and cache) this room's gaia tools — the same factories the Pi
   * harness wires in-process, keyed by tool name for item/tool/call dispatch. */
  private async buildRoomTools(roomId: string): Promise<Map<string, PiToolLike>> {
    const existing = this.roomTools.get(roomId);
    if (existing) return existing;
    const built = (await buildPiTools(this.agent.tools, {
      memoryStore: this.memoryStore,
      agent: this.agent,
      roomId,
      roomDir: workspacePaths.roomDir(this.cwd, roomId),
      summonCreate: this.summonCreate,
      recallSearch: this.recallSearch,
    })) as PiToolLike[];
    const tools = new Map(built.map((tool) => [tool.name, tool]));
    this.roomTools.set(roomId, tools);
    return tools;
  }

  /** item/tool/call → execute the named gaia tool for the thread's room and
   * hand the text result back as the JSON-RPC response. */
  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "item/tool/call") throw new Error(`Unsupported server request: ${method}`);
    const call = params as DynamicToolCall;
    const roomId = this.roomForThread(call.threadId);
    const tool = roomId !== undefined ? this.roomTools.get(roomId)?.get(call.tool) : undefined;
    if (!tool) {
      return { success: false, contentItems: [{ type: "inputText", text: `Unknown tool: ${call.tool}` }] };
    }
    try {
      const result = await tool.execute(call.callId, call.arguments ?? {});
      const text = (result.content ?? [])
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
      const details = result.details as { ok?: unknown } | undefined;
      const failed = details?.ok === false || text.startsWith("ERROR");
      return { success: !failed, contentItems: [{ type: "inputText", text: text || "(no output)" }] };
    } catch (error) {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }

  /** Per-thread codex config override — the config.toml sections gaia drives as
   * data: `mcp_servers` (configured MCP), `tools.web_search` (the `web` tool →
   * codex's native Responses web_search), and `model_reasoning_summary`.
   *
   * model_reasoning_summary is ALWAYS "detailed" — never a per-agent/UI
   * option. Without it the Responses API returns reasoning items with an
   * EMPTY summary (verified against a live rollout: 28/28 reasoning items had
   * `summary: []`), so the room saw nothing but tool-call rows with zero
   * commentary between them — indistinguishable from a broken harness. This
   * mirrors claude.ts's ensureThinkingProxy: "reveal thinking" is always on
   * for every agent, across every harness, unconditionally (see MEMORY: reveal
   * thinking is always true for all agents across all harnesses) — codex was
   * simply never wired to request it. Returns {} only when nothing else
   * applies; this field itself is never conditional.
   *
   * This thread-level value alone is NOT sufficient, though (see send()):
   * a live rollout showed turn_context.summary resolving to "auto" despite
   * this override, so `turn/start` also sends `summary: "detailed"` per turn
   * — that's the copy that's actually verified to stick. Kept here too as the
   * thread's own baseline (covers thread/resume and any turn/start call site
   * that might omit it). */
  private configOverride(): { config?: Record<string, unknown> } {
    const config: Record<string, unknown> = { model_reasoning_summary: "detailed" };
    const servers = resolveMcpServers(this.workspace.config, this.agent);
    if (Object.keys(servers).length > 0) config.mcp_servers = codexMcpServersConfig(servers);
    if (this.agent.tools.includes("web")) config.tools = { web_search: true };
    return { config };
  }

  private roomForThread(threadId: string): string | undefined {
    for (const roomId of this.threads.rooms()) {
      if (this.threads.get(roomId)?.threadId === threadId) return roomId;
    }
    return undefined;
  }

  private resolveModelLabel(): string {
    return configuredModelLabel(this.agent.model, "Codex default");
  }
}

// ---------------------------------------------------------------------------
// Account usage probe — the ChatGPT-subscription rate-limit meter (5h primary
// window + weekly secondary) the codex CLI itself renders. Only the CREDENTIAL
// READING (~/.codex/auth.json's shape) is codex-specific and lives here; the
// provider client is harness/usage.ts (RULE #0: shared code sees only the
// declared usageAccounts data).

async function probeCodexUsage(): Promise<UsageProbeResult> {
  let raw: string;
  try {
    raw = readFileSync(join(homedir(), ".codex", "auth.json"), "utf8");
  } catch (err) {
    // No auth file = never signed in — authoritatively nothing to show. Any
    // other read failure is ambient (permissions, transient FS) — keep the
    // last-known meter rather than blanking it.
    return (err as { code?: string }).code === "ENOENT" ? { status: "none" } : { status: "error" };
  }
  let parsed: { tokens?: { access_token?: string; account_id?: string } };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { status: "error" }; // torn mid-write by a concurrent codex refresh — transient.
  }
  const tokens = parsed?.tokens;
  if (typeof tokens?.access_token !== "string" || !tokens.access_token) {
    return { status: "none" }; // API-key mode — no subscription meter to show.
  }
  return fetchChatGptUsage(tokens.access_token, typeof tokens.account_id === "string" ? tokens.account_id : undefined);
}

// ---------------------------------------------------------------------------
// Named accounts — codex has no CLAUDE_CODE_OAUTH_TOKEN-style env var the CLI
// reads fresh on every invocation, so a bound account instead gets its OWN
// durable $CODEX_HOME (mirrors ~/.codex's own auth.json shape) and the agent's
// subprocess is pointed at it. codex itself refreshes access_token in place
// there via refresh_token across a session — materializeCodexHome only WRITES
// when the stored refresh_token actually changed (fresh login / replaced
// account), so it never stomps a live-refreshed file on a later spawn.

interface CodexAuthTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

function codexAccountDir(credentials: Record<string, string>): string {
  // OpenAI's own account_id is the natural stable key; hash the access token
  // as a fallback for a hand-pasted bag that omitted it.
  const key = credentials.accountId || createHash("sha1").update(credentials.accessToken ?? credentials.refreshToken ?? "").digest("hex").slice(0, 16);
  return join(gaiaHome(), "codex-accounts", key);
}

function materializeCodexHome(credentials: Record<string, string>): string {
  const dir = codexAccountDir(credentials);
  const authPath = join(dir, "auth.json");
  const bag = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: credentials.idToken ?? "",
      access_token: credentials.accessToken ?? "",
      refresh_token: credentials.refreshToken ?? "",
      account_id: credentials.accountId ?? "",
    } satisfies CodexAuthTokens,
    last_refresh: new Date().toISOString(),
  };
  let stale = true;
  try {
    const existing = JSON.parse(readFileSync(authPath, "utf8")) as { tokens?: CodexAuthTokens };
    stale = existing?.tokens?.refresh_token !== bag.tokens.refresh_token;
  } catch {
    stale = true; // never materialized yet, or a torn/missing file
  }
  if (stale) {
    mkdirSync(dir, { recursive: true });
    // Same secrets as ~/.codex/auth.json (codex itself writes that 0600) — match it.
    writeFileSync(authPath, JSON.stringify(bag, null, 2), { mode: 0o600 });
  }
  return dir;
}

/** Extract a finished device-auth credential bag from $configDir/auth.json —
 * the same shape codex itself writes there once the user approves the code
 * on openai's site (this process never receives anything on stdin). */
function readCodexLoginCredentials(configDir: string): Record<string, string> | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(configDir, "auth.json"), "utf8");
  } catch {
    return undefined; // not written yet — still polling
  }
  let parsed: { tokens?: CodexAuthTokens };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return undefined; // torn mid-write
  }
  const t = parsed?.tokens;
  if (!t?.access_token || !t?.refresh_token) return undefined;
  return { idToken: t.id_token ?? "", accessToken: t.access_token, refreshToken: t.refresh_token, accountId: t.account_id ?? "" };
}

registerHarness({
  id: "codex",
  capabilities: CODEX_CAPABILITIES,
  ui: {
    label: "codex",
    description: "OpenAI Codex app-server",
    lockedProvider: "openai-codex",
    modelProviderIds: ["openai-codex"],
  },
  create: (ctx) => new CodexRuntime(ctx),
  // Codex's GPT-5-class models run a ~272k window; the exact real figure is
  // reported per-turn (thread/tokenUsage) — this is only the pre-flight estimate.
  contextWindow: () => 272_000,
  // A persisted ThreadState means thread/resume can restore the conversation.
  // (A pruned rollout can still fail that resume mid-turn — undetectable here.)
  hasDurableSession: (rootDir, roomId, agentId) => fileSessionStore<ThreadState>(rootDir, "codex", agentId).load(roomId) !== undefined,
  // Codex reads OPENAI_BASE_URL + OPENAI_API_KEY. Point both at the loopback proxy
  // + per-turn token; the daemon swaps in the real key. OAuth/ChatGPT-subscription
  // logins have no key to hide, so the proxy resolver fail-closes for them.
  credentialProxy: ({ proxyUrl, token }) => ({
    env: { OPENAI_BASE_URL: proxyUrl, OPENAI_API_KEY: token },
  }),
  // Named accounts: each bound agent's codex subprocess gets CODEX_HOME pointed
  // at that account's own materialized auth.json (see materializeCodexHome),
  // so it runs on that ChatGPT subscription's own rate-limit bucket while
  // unbound agents keep the ambient ~/.codex login — true parallel multi-account,
  // same shape as claude's CLAUDE_CODE_OAUTH_TOKEN wiring above.
  accounts: {
    label: "Codex account",
    fields: [
      { key: "accessToken", label: "Access token", secret: true, hint: "From that account's ~/.codex/auth.json → tokens.access_token" },
      { key: "refreshToken", label: "Refresh token", secret: true, hint: "Same file → tokens.refresh_token" },
      { key: "idToken", label: "ID token", secret: true, hint: "Same file → tokens.id_token" },
      { key: "accountId", label: "Account ID", hint: "Same file → tokens.account_id" },
    ],
    env: (credentials) => ({ CODEX_HOME: materializeCodexHome(credentials) }),
    // In-app login: `codex login --device-auth` needs no local callback port
    // (works from any device, unlike the default browser-redirect flow) — it
    // prints a URL + one-time code and polls openai until the code is approved
    // ON THE SITE, so nothing is ever pasted back into this process. Once
    // approved it writes CODEX_HOME/auth.json itself and exits.
    login: {
      command: ({ configDir }) => ({ argv: ["codex", "login", "--device-auth"], env: { CODEX_HOME: configDir } }),
      signInUrl: (output) => /https:\/\/auth\.openai\.com\/codex\/device\S*/.exec(output)?.[0],
      code: (output) => /\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/.exec(output)?.[0],
      awaitingInput: () => false,
      credentials: ({ configDir }) => readCodexLoginCredentials(configDir),
    },
  },
  // Codex persists auth + session state under ~/.codex (a sandboxed turn must
  // write there); its credential store inside that tree is carved back to
  // read-only so a confined turn can't tamper with it. codex-accounts holds
  // the SAME shape per bound account (see materializeCodexHome) — writable,
  // never read-only, since a turn legitimately owns its own bound account's file.
  sandboxPaths: { writable: ["~/.codex", join(gaiaHome(), "codex-accounts")], readonly: ["~/.codex/auth.json"] },
  usageAccounts: () => [{ account: OPENAI_USAGE_ACCOUNT, probe: probeCodexUsage }],
});
