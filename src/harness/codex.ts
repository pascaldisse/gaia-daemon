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

import type { AgentDef, AgentEvent, McpServerConfig, Workspace } from "../core/types.js";
import { nativeImageAttachments } from "../core/attachments.js";
import { resolveMcpServers } from "../core/config.js";
import { workspacePaths } from "../core/paths.js";
import type { MemoryStore } from "../domain/memory.js";
import {
  type AgentInput,
  type AgentRuntime,
  type HarnessCapabilities,
  type HarnessHost,
  type RecallSearch,
  registerHarness,
  type RuntimeCreateContext,
  type SummonCreate,
} from "./spec.js";
import { createEventChannel } from "./events.js";
import { fileSessionStore, SessionMap } from "./sessions.js";
import { missingBinaryError, spawnLineReader } from "./proc.js";
import { configuredModelLabel } from "./model-label.js";
import { buildInlineSystemPrompt, buildTurnPrompt } from "./prompt.js";
import { buildPiTools } from "./tools.js";

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
// Config-driven sandbox translation
// ---------------------------------------------------------------------------
//
// Codex is a COARSE translator of the per-agent `tools` array: unlike Claude
// (per-tool grants) it only has a workspace sandbox level. An agent that can
// modify files (write/edit) or run commands (bash) needs "workspace-write";
// a read-only agent gets "read-only". This honors the config at the granularity
// Codex actually supports (capabilities.granularTools = false surfaces the gap
// in the UI instead of pretending the toggles map).

export type CodexSandbox = "read-only" | "workspace-write";

export function codexSandboxFor(tools: string[]): CodexSandbox {
  return tools.includes("write") || tools.includes("edit") || tools.includes("bash") ? "workspace-write" : "read-only";
}

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
// in-process tools under Codex, exactly like Pi. Codex still runs a coarse
// sandbox rather than honoring a granular per-tool array.
const CODEX_CAPABILITIES: HarnessCapabilities = {
  gaiaTools: ["memory", "recall", "summon"],
  nativeTools: ["web"],
  granularTools: false,
  supportsPermissionMode: false,
  supportsMcp: true,
  supportsSteer: true,
  supportsCompact: true,
};

export class CodexRuntime implements AgentRuntime {
  readonly capabilities = CODEX_CAPABILITIES;
  readonly agent: AgentDef;
  private readonly workspace: Workspace;
  private readonly memoryStore: MemoryStore;
  private readonly harnessHost?: HarnessHost;
  private readonly summonCreate?: SummonCreate;
  private readonly recallSearch?: RecallSearch;
  private client: CodexClient | null = null;
  private initPromise: Promise<CodexClient> | null = null;
  private readonly cwd: string;
  private readonly threads: SessionMap<ThreadState>;
  /** In-process dynamic tools per room (rebuilt per process — not persisted). */
  private readonly roomTools = new Map<string, Map<string, PiToolLike>>();
  /** Thread ids live on the CURRENT app-server process; a persisted thread not
   * in here must go through thread/resume before its next turn. */
  private readonly attachedThreads = new Set<string>();
  private activeTurn: { threadId: string; turnId: string } | null = null;
  private readonly clientFactory: CodexClientFactory;
  private readonly configuredModelLabel: string;
  private liveModelLabel: string | undefined;

  constructor(options: CodexRuntimeOptions) {
    this.workspace = options.workspace;
    this.agent = options.agent;
    this.memoryStore = options.memoryStore;
    this.harnessHost = options.harnessHost;
    this.summonCreate = options.summonCreate;
    this.recallSearch = options.recallSearch;
    this.cwd = options.workspace.rootDir;
    this.threads = new SessionMap<ThreadState>(undefined, fileSessionStore(this.cwd, "codex", this.agent.id));
    this.clientFactory = options.clientFactory ?? defaultFactory;
    this.configuredModelLabel = this.resolveModelLabel();
  }

  get modelLabel(): string {
    return this.liveModelLabel ?? this.configuredModelLabel;
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
      thread = await this.resumeThread(client, thread, input);
      announce = Boolean(thread);
    }
    if (!thread) {
      thread = await this.startThread(client, input);
      this.threads.set(input.roomId, thread);
      announce = true;
    }
    if (announce) {
      const { modelProvider, model } = thread;
      this.liveModelLabel = `${modelProvider}/${model}`;
      yield { type: "model-info", provider: modelProvider, modelId: model, subscription: true };
    }

    // Build the turn prompt (reuse prompt-assembly exactly like PiRuntime).
    // Memory travels only when it changed (SessionMap's uniform diff) — the
    // persistent thread already saw the previous block.
    const memory = await this.memoryStore.promptBlock(this.agent.memoryDir);
    const memoryChanged = this.threads.memoryChanged(input.roomId, memory);
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

    // Start the turn. Pasted images ride as localImage input items (the same
    // shape `codex -i <file>` produces); the app-server reads the paths itself.
    const turnResponse = (await client.request("turn/start", {
      threadId: thread.threadId,
      input: [
        { type: "text", text: prompt, text_elements: [] },
        ...nativeImageAttachments(input.attachments).map((file) => ({ type: "localImage", path: file.path })),
      ],
      model: this.agent.model?.name ?? null,
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
            this.liveModelLabel = `${currentThread.modelProvider}/${p.toModel}`;
            channel.push({ type: "model-info", provider: currentThread.modelProvider, modelId: p.toModel, subscription: true });
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
          // usage.total is cumulative for the thread; modelContextWindow the
          // window size. (Accept `tokenUsage` too — the wrapper field name is
          // the one part of the v2 shape not string-confirmed in the binary.)
          const p = params as { usage?: CodexTokenUsage; tokenUsage?: CodexTokenUsage };
          const usage = p.usage ?? p.tokenUsage;
          const used = usage?.total?.totalTokens;
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
                error?: unknown;
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

          const res =
            item.type === "commandExecution"
              ? item.aggregatedOutput
              : item.type === "dynamicToolCall"
                ? item.result ?? item.arguments
                : item.result;

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

  /** Inject guidance into the room's running turn via turn/steer. */
  async steer(roomId: string, message: string): Promise<boolean> {
    const thread = this.threads.get(roomId);
    if (!this.client || !this.activeTurn || !thread || this.activeTurn.threadId !== thread.threadId) return false;
    try {
      await this.client.request("turn/steer", {
        threadId: this.activeTurn.threadId,
        expectedTurnId: this.activeTurn.turnId,
        input: [{ type: "text", text: message, text_elements: [] }],
      });
      return true;
    } catch {
      return false; // turn just settled — the precondition failed
    }
  }

  /** Native codex compaction (backs /compact): thread/compact/start returns
   * `{}` immediately; completion is the thread/compacted notification. Runs
   * only between turns (room-service gates on an idle room), so temporarily
   * owning the notification handler is safe — the next send() replaces it. */
  async compact(roomId: string): Promise<string> {
    const thread = this.threads.get(roomId);
    const client = this.client;
    if (!thread || !client || !this.attachedThreads.has(thread.threadId)) {
      return "nothing to compact — no active session for this room.";
    }
    const done = new Promise<void>((resolve) => {
      client.setNotificationHandler((msg) => {
        if (msg.method === "thread/compacted" && (msg.params as { threadId?: string } | undefined)?.threadId === thread.threadId) {
          resolve();
        }
      });
    });
    await client.request("thread/compact/start", { threadId: thread.threadId });
    await done; // the RunnerHost round-trip timeout bounds this wait
    return "thread compacted by codex.";
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

  // Env for the app-server child. Inside the runner subprocess the harness
  // host is a fixed-token bridge (the daemon minted the room-scoped token at
  // spawn), so the claims passed here are advisory; gaia tools themselves run
  // in THIS process via dynamicTools, not through the child's env.
  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GAIA_MEMORY_DIR: this.agent.memoryDir,
      GAIA_AGENT_ID: this.agent.id,
    };
    if (this.harnessHost && this.agent.tools.includes("memory")) {
      env.GAIA_DAEMON_URL = this.harnessHost.baseUrl;
      env.GAIA_DAEMON_TOKEN = this.harnessHost.mintToken({ agentId: this.agent.id, roomId: "" });
    }
    return env;
  }

  private async ensureClient(): Promise<CodexClient> {
    if (this.client) return this.client;
    if (!this.initPromise) {
      // A fresh app-server process knows none of our persisted threads.
      this.attachedThreads.clear();
      this.initPromise = this.clientFactory(this.cwd, this.buildEnv())
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
      cwd: this.cwd,
      model: this.agent.model?.name ?? null,
      modelProvider: this.agent.model?.provider ?? null,
      baseInstructions,
      ephemeral: false,
      // Derived from agent.tools instead of a fixed read-only stance, so an
      // agent with write/edit/bash can actually modify the workspace.
      sandbox: codexSandboxFor(this.agent.tools),
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
  private async resumeThread(client: CodexClient, state: ThreadState, input: AgentInput): Promise<ThreadState | undefined> {
    try {
      const baseInstructions = await buildInlineSystemPrompt({
        workspace: this.workspace,
        agent: this.agent,
        role: input.activeRole,
        toolPointer: "",
      });
      await this.buildRoomTools(input.roomId);
      const response = (await client.request("thread/resume", {
        threadId: state.threadId,
        cwd: this.cwd,
        model: this.agent.model?.name ?? null,
        modelProvider: this.agent.model?.provider ?? null,
        baseInstructions,
        sandbox: codexSandboxFor(this.agent.tools),
        ...this.configOverride(),
      })) as { thread: { id: string }; model: string; modelProvider: string };
      const next: ThreadState = {
        threadId: response.thread.id,
        model: response.model,
        modelProvider: response.modelProvider,
      };
      this.attachedThreads.add(next.threadId);
      this.threads.set(input.roomId, next);
      return next;
    } catch {
      this.threads.reset(input.roomId);
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
   * data: `mcp_servers` (configured MCP) and `tools.web_search` (the `web`
   * tool → codex's native Responses web_search). Returns {} when nothing
   * applies so the spread adds nothing. */
  private configOverride(): { config?: Record<string, unknown> } {
    const config: Record<string, unknown> = {};
    const servers = resolveMcpServers(this.workspace.config, this.agent);
    if (Object.keys(servers).length > 0) config.mcp_servers = codexMcpServersConfig(servers);
    if (this.agent.tools.includes("web")) config.tools = { web_search: true };
    return Object.keys(config).length > 0 ? { config } : {};
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
});
