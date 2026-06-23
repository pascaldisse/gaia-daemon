import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HarnessHost } from "../app/harness-bridge.js";
import type { AgentDefinition } from "../agents/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { SummonCreate } from "../tools/summon-tool.js";
import type { Workspace } from "../workspace/types.js";
import { HARNESS_CAPABILITIES } from "./capabilities.js";
import { createEventChannel } from "./event-stream.js";
import { buildInlineSystemPrompt, buildTurnPrompt, gaiaCliPointer } from "./prompt-assembly.js";
import type { AgentEvent, AgentInput, AgentRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Internal JSON‑RPC client abstraction (injectable for tests)
// ---------------------------------------------------------------------------

interface JsonRpcNotification {
  method: string;
  params: unknown;
}

export interface CodexClient {
  /** Send a JSON‑RPC request (includes an `id`), returns the `result`. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Send a fire‑and‑forget notification (no `id`). */
  notify(method: string, params: unknown): void;
  /** Register a handler for server‑pushed notifications. */
  setNotificationHandler(handler: ((msg: JsonRpcNotification) => void) | null): void;
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

const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
};

function spawnCodexClient(cwd: string, env: typeof process.env): CodexClient {
  const proc: ChildProcess = spawn("codex", ["app-server"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let notifHandler: ((msg: JsonRpcNotification) => void) | null = null;
  let stderrAccum = "";
  let closed = false;
  let exitError: Error | null = null;

  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    stderrAccum += chunk;
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

  function rejectAll(err: Error): void {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function sendRaw(msg: { id?: number; method?: string; params?: unknown; error?: { code: number; message: string } }): void {
    if (closed) return;
    proc.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Server-initiated request -> send error back
    if (msg.id !== undefined && msg.method) {
      sendRaw({ id: msg.id, error: { code: -32601, message: `Unsupported server request: ${msg.method}` } });
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
    async close() {
      if (closed) return;
      closed = true;
      rl.close();
      proc.stdin?.end();
    },
    get stderr() {
      return stderrAccum;
    },
  };
}

const defaultFactory: CodexClientFactory = async (cwd, env) => {
  return spawnCodexClient(cwd, env);
};

function isMissingCodexBinary(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function codexStartupError(error: unknown, stderr?: string): Error {
  if (isMissingCodexBinary(error)) {
    return new Error("Codex app-server is unavailable: the `codex` CLI was not found in PATH.");
  }

  const message = error instanceof Error ? error.message : String(error);
  const details = stderr?.trim();
  return new Error(
    `Codex app-server is unavailable: ${message}${details ? `\n\ncodex stderr:\n${details}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Config-driven sandbox translation
// ---------------------------------------------------------------------------
//
// Codex is a COARSE translator of the per-agent `tools` array: unlike Claude
// (per-tool grants) it only has a workspace sandbox level. An agent that can
// modify files (write/edit) or run commands (bash) needs "workspace-write";
// a read-only agent gets "read-only". This honors the config at the granularity
// Codex actually supports — see HANDOFF-CLAUDE-HARNESS.md §2 (don't pretend a
// toggle maps when it can't; surface the gap).

export type CodexSandbox = "read-only" | "workspace-write";

export function codexSandboxFor(tools: string[]): CodexSandbox {
  return tools.includes("write") || tools.includes("edit") || tools.includes("bash") ? "workspace-write" : "read-only";
}

// ---------------------------------------------------------------------------
// Persistent thread state
// ---------------------------------------------------------------------------

interface ThreadState {
  threadId: string;
  model: string;
  modelProvider: string;
}

// ---------------------------------------------------------------------------
// CodexRuntime
// ---------------------------------------------------------------------------

export class CodexRuntime implements AgentRuntime {
  readonly capabilities = HARNESS_CAPABILITIES.codex;
  private client: CodexClient | null = null;
  private initPromise: Promise<CodexClient> | null = null;
  private readonly cwd: string;
  private readonly threads = new Map<string, ThreadState>();
  private activeTurn: { threadId: string; turnId: string } | null = null;
  private readonly clientFactory: CodexClientFactory;
  private readonly configuredModelLabel: string;
  private liveModelLabel: string | undefined;

  constructor(
    private readonly workspace: Workspace,
    readonly agent: AgentDefinition,
    private readonly memoryStore: MemoryStore,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _unused?: unknown,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly summonCreate?: SummonCreate,
    // Injectable client factory for testing
    clientFactory?: CodexClientFactory,
    // Daemon bridge for the `gaia mem` CLI. The app-server is persistent and
    // shared across rooms, so only room-independent memory is wired here; recall
    // and summon are room-specific and stay unavailable under Codex.
    private readonly harnessHost?: HarnessHost,
  ) {
    this.cwd = workspace.rootDir;
    this.clientFactory = clientFactory ?? defaultFactory;
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

    // Ensure a persistent thread exists for this room (lazy-start on first send).
    let thread = this.threads.get(input.roomId);
    if (!thread) {
      thread = await this.startThread(client, input);
      this.threads.set(input.roomId, thread);
      const { modelProvider, model } = thread;
      this.liveModelLabel = `${modelProvider}/${model}`;
      yield { type: "model-info", provider: modelProvider, modelId: model, subscription: true };
    }

    // Build the turn prompt (reuse prompt-assembly exactly like PiRuntime)
    const memory = await this.memoryStore.promptBlock(this.agent.memoryDir);
    const prompt = buildTurnPrompt({
      roomId: input.roomId,
      agentId: this.agent.id,
      message: input.message,
      events: input.transcript,
      memory,
      channel: input.channel,
    });

    // Start the turn
    const turnResponse = (await client.request("turn/start", {
      threadId: thread.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
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
          const p = params as { toModel: string; threadId: string; turnId: string };
          const currentThread = this.threads.get(input.roomId);
          if (p.toModel && currentThread) {
            currentThread.model = p.toModel;
            this.liveModelLabel = `${currentThread.modelProvider}/${p.toModel}`;
            channel.push({ type: "model-info", provider: currentThread.modelProvider, modelId: p.toModel, subscription: true });
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
          const item = (params as { item: { id: string; type: string; command?: string; tool?: string; server?: string; arguments?: unknown; aggregatedOutput?: string | null; exitCode?: number | null; summary?: string[]; content?: string[]; result?: unknown; error?: unknown; success?: boolean | null } }).item;

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
          const item = (params as { item: { id: string; type: string; command?: string; tool?: string; server?: string; arguments?: unknown } }).item;

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

  // -----------------------------------------------------------------------
  // dispose
  // -----------------------------------------------------------------------

  dispose(): void {
    this.client?.close().catch(() => {});
    this.client = null;
    this.threads.clear();
    this.activeTurn = null;
    this.initPromise = null;
  }

  // Forget this room's Codex thread so the next turn opens a fresh one (/clear).
  resetRoom(roomId: string): void {
    this.threads.delete(roomId);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  // Env for the persistent app-server: room-independent memory only. The token
  // carries no room (roomId ""), so the daemon's memory endpoint — which is
  // per-agent, not per-room — accepts it while room-scoped recall/summon do not.
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
      this.initPromise = this.clientFactory(this.cwd, this.buildEnv())
        .then(async (client) => {
          try {
            await client.request("initialize", {
              clientInfo: DEFAULT_CLIENT_INFO,
              capabilities: DEFAULT_CAPABILITIES,
            });
            client.notify("initialized", {});
            return client;
          } catch (error) {
            await client.close().catch(() => {});
            throw codexStartupError(error, client.stderr);
          }
        })
        .catch((error) => {
          this.initPromise = null;
          throw error instanceof Error && error.message.startsWith("Codex app-server is unavailable:")
            ? error
            : codexStartupError(error);
        });
    }
    this.client = await this.initPromise;
    return this.client;
  }

  private async startThread(client: CodexClient, input: AgentInput): Promise<ThreadState> {
    // The persistent app-server is shared across rooms, so only room-independent
    // memory is wired under Codex; recall/summon stay unavailable (see buildEnv).
    const baseInstructions = await buildInlineSystemPrompt({
      workspace: this.workspace,
      agent: this.agent,
      role: input.activeRole,
      toolPointer: gaiaCliPointer(this.agent.tools, this.capabilities.gaiaTools),
    });

    const response = (await client.request("thread/start", {
      cwd: this.cwd,
      model: this.agent.model?.name ?? null,
      modelProvider: this.agent.model?.provider ?? null,
      baseInstructions,
      ephemeral: false,
      // Derived from agent.tools instead of a fixed read-only stance, so an
      // agent with write/edit/bash can actually modify the workspace.
      sandbox: codexSandboxFor(this.agent.tools),
    })) as { thread: { id: string }; model: string; modelProvider: string };

    return {
      threadId: response.thread.id,
      model: response.model,
      modelProvider: response.modelProvider,
    };
  }

  private resolveModelLabel(): string {
    const provider = this.agent.model?.provider;
    const name = this.agent.model?.name;
    if (!provider || !name) return "Codex default";
    return `${provider}/${name}`;
  }
}
