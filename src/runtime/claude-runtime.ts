import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentDefinition } from "../agents/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { SummonCreate } from "../tools/summon-tool.js";
import type { Workspace } from "../workspace/types.js";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt-assembly.js";
import type { AgentEvent, AgentInput, AgentRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Process abstraction (injectable for tests)
// ---------------------------------------------------------------------------

export interface ClaudeProcessCallbacks {
  /** A parsed NDJSON object from the CLI's stream-json stdout. */
  onMessage(message: unknown): void;
  /** Process exited (cleanly or not). */
  onExit(info: { code: number | null; signal: string | null; stderr: string }): void;
  /** Spawn failure (e.g. ENOENT) before/without an exit. */
  onError(error: Error): void;
}

export interface ClaudeProcessHandle {
  /** Best-effort terminate (used by abort()). */
  kill(): void;
}

export interface ClaudeProcessOptions extends ClaudeProcessCallbacks {
  args: string[];
  /** Turn prompt, delivered on stdin (avoids arg-length limits on big transcripts). */
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type ClaudeProcessFactory = (options: ClaudeProcessOptions) => ClaudeProcessHandle;

// ---------------------------------------------------------------------------
// Default factory – spawns `claude -p`
// ---------------------------------------------------------------------------

function spawnClaudeProcess(options: ClaudeProcessOptions): ClaudeProcessHandle {
  const proc: ChildProcess = spawn("claude", options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  let settled = false;

  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON noise
    }
    options.onMessage(parsed);
  });

  proc.on("error", (err) => {
    if (settled) return;
    settled = true;
    rl.close();
    options.onError(err);
  });

  proc.on("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    rl.close();
    options.onExit({ code, signal, stderr });
  });

  // Deliver the prompt on stdin, then close it so the CLI starts the turn.
  proc.stdin?.write(options.prompt);
  proc.stdin?.end();

  return {
    kill() {
      proc.kill("SIGTERM");
    },
  };
}

function isMissingClaudeBinary(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function claudeStartupError(error: unknown, stderr?: string): Error {
  if (isMissingClaudeBinary(error)) {
    return new Error("Claude Code is unavailable: the `claude` CLI was not found in PATH.");
  }
  const message = error instanceof Error ? error.message : String(error);
  const details = stderr?.trim();
  return new Error(`Claude Code is unavailable: ${message}${details ? `\n\nclaude stderr:\n${details}` : ""}`);
}

// ---------------------------------------------------------------------------
// Per-room session state
// ---------------------------------------------------------------------------

interface RoomState {
  /** Session id we generated and pass as --session-id, then --resume on later turns. */
  sessionId: string;
  /** Memory last delivered in a turn prompt; only re-sent when it changes. */
  lastMemoryContent?: string;
  /** True until the first turn for this room has successfully created the session. */
  started: boolean;
}

// GAIA owns the persona system prompt, project context, and memory; --safe-mode
// keeps the user's own CLAUDE.md, skills, hooks, and MCP servers out of the
// session while leaving subscription auth, the model, and built-in tools intact.
// Phase 1 grants a read-only tool set (no memory/recall/summon yet).
const READ_ONLY_TOOLS = "Read,Grep,Glob";

// GAIA thinking levels -> Claude --effort. Claude has no "off"; floor at "low".
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

// ---------------------------------------------------------------------------
// ClaudeRuntime
// ---------------------------------------------------------------------------

export class ClaudeRuntime implements AgentRuntime {
  private readonly cwd: string;
  private readonly rooms = new Map<string, RoomState>();
  private active: ClaudeProcessHandle | null = null;
  private readonly processFactory: ClaudeProcessFactory;
  private readonly configuredModelLabel: string;
  private liveModelLabel: string | undefined;

  constructor(
    private readonly workspace: Workspace,
    readonly agent: AgentDefinition,
    private readonly memoryStore: MemoryStore,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _unused?: unknown,
    // Phase 2 will expose memory/recall/summon via an in-process MCP bridge.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly summonCreate?: SummonCreate,
    // Injectable process factory for testing.
    processFactory?: ClaudeProcessFactory,
  ) {
    this.cwd = workspace.rootDir;
    this.processFactory = processFactory ?? spawnClaudeProcess;
    this.configuredModelLabel = this.resolveModelLabel();
  }

  get modelLabel(): string {
    return this.liveModelLabel ?? this.configuredModelLabel;
  }

  // -----------------------------------------------------------------------
  // send – one `claude -p` invocation per turn, resumed across turns
  // -----------------------------------------------------------------------

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const memory = await this.memoryStore.promptBlock(this.agent.memoryDir);
    let room = this.rooms.get(input.roomId);
    const firstTurn = !room?.started;
    if (!room) {
      room = { sessionId: randomUUID(), started: false };
      this.rooms.set(input.roomId, room);
    }
    const memoryChanged = room.lastMemoryContent !== memory;

    const systemPrompt = await this.buildSystemPrompt(input);
    const prompt = buildTurnPrompt({
      roomId: input.roomId,
      agentId: this.agent.id,
      message: input.message,
      events: input.transcript,
      memory: memoryChanged ? memory : undefined,
      channel: input.channel,
    });
    const args = this.buildArgs(room.sessionId, firstTurn, systemPrompt, input.thinking);

    // Push-based async iteration, mirroring PiRuntime/CodexRuntime.
    const queue: AgentEvent[] = [];
    let done = false;
    let error: unknown = null;
    let notify: (() => void) | undefined;

    const push = (event: AgentEvent): void => {
      queue.push(event);
      notify?.();
      notify = undefined;
    };
    const finish = (): void => {
      done = true;
      notify?.();
      notify = undefined;
    };

    // Per-turn parse state.
    const blockTypes = new Map<number, string>(); // content-block index -> type
    let thinkingActive = false;
    const toolNames = new Map<string, string>(); // tool_use id -> name
    const endedTools = new Set<string>();

    const onMessage = (raw: unknown): void => {
      const msg = raw as { type?: string };
      switch (msg.type) {
        case "system": {
          const sys = raw as { subtype?: string; model?: string; apiKeySource?: string };
          if (sys.subtype === "init" && sys.model) {
            const subscription = sys.apiKeySource === "none";
            this.liveModelLabel = `anthropic/${sys.model}`;
            push({ type: "model-info", provider: "anthropic", modelId: sys.model, subscription });
          }
          break;
        }

        case "stream_event": {
          this.handleStreamEvent(
            (raw as { event?: unknown }).event,
            { blockTypes, getThinking: () => thinkingActive, setThinking: (v) => (thinkingActive = v) },
            push,
          );
          break;
        }

        case "assistant": {
          // Tool calls: emit tool-start from completed tool_use blocks (full
          // input). Text/thinking already streamed via stream_event, so skip.
          const content = (raw as { message?: { content?: unknown } }).message?.content;
          if (!Array.isArray(content)) break;
          for (const block of content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>) {
            if (block.type === "tool_use" && block.id && !toolNames.has(block.id)) {
              toolNames.set(block.id, block.name ?? "tool");
              push({ type: "tool-start", toolName: block.name ?? "tool", toolCallId: block.id, args: block.input });
            }
          }
          break;
        }

        case "user": {
          // Tool results come back as user messages with tool_result blocks.
          const content = (raw as { message?: { content?: unknown } }).message?.content;
          if (!Array.isArray(content)) break;
          for (const block of content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
            if (block.type === "tool_result" && block.tool_use_id && !endedTools.has(block.tool_use_id)) {
              endedTools.add(block.tool_use_id);
              push({
                type: "tool-end",
                toolName: toolNames.get(block.tool_use_id) ?? "tool",
                toolCallId: block.tool_use_id,
                result: block.content,
                isError: block.is_error === true,
              });
            }
          }
          break;
        }

        case "result": {
          const res = raw as { subtype?: string; is_error?: boolean; result?: string };
          if (res.is_error === true || (res.subtype && res.subtype !== "success")) {
            error = new Error(res.result || `Claude turn failed (${res.subtype ?? "error"}).`);
          }
          finish();
          break;
        }
      }
    };

    const handle = this.processFactory({
      args,
      prompt,
      cwd: this.cwd,
      env: process.env,
      onMessage,
      onExit: ({ code, signal, stderr }) => {
        if (!done && code !== 0 && !error) {
          error = claudeStartupError(
            new Error(`claude exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`),
            stderr,
          );
        }
        finish();
      },
      onError: (err) => {
        error = claudeStartupError(err);
        finish();
      },
    });
    this.active = handle;

    try {
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
    } finally {
      this.active = null;
    }

    if (error) {
      // A failed first turn may never have created a resumable session; drop
      // the room so the next turn starts fresh instead of --resume'ing nothing.
      if (firstTurn) this.rooms.delete(input.roomId);
      throw error instanceof Error ? error : new Error(String(error));
    }

    room.started = true;
    room.lastMemoryContent = memory;
  }

  // -----------------------------------------------------------------------
  // abort / dispose
  // -----------------------------------------------------------------------

  async abort(): Promise<void> {
    this.active?.kill();
  }

  dispose(): void {
    this.active?.kill();
    this.active = null;
    this.rooms.clear();
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private handleStreamEvent(
    event: unknown,
    state: { blockTypes: Map<number, string>; getThinking: () => boolean; setThinking: (v: boolean) => void },
    push: (event: AgentEvent) => void,
  ): void {
    const e = event as {
      type?: string;
      index?: number;
      content_block?: { type?: string };
      delta?: { type?: string; text?: string; thinking?: string };
    };
    switch (e.type) {
      case "message_start":
        state.blockTypes.clear();
        break;
      case "content_block_start":
        if (typeof e.index === "number" && e.content_block?.type) {
          state.blockTypes.set(e.index, e.content_block.type);
        }
        break;
      case "content_block_delta": {
        if (e.delta?.type === "text_delta" && e.delta.text) {
          push({ type: "text-delta", delta: e.delta.text });
        } else if (e.delta?.type === "thinking_delta" && e.delta.thinking) {
          if (!state.getThinking()) {
            state.setThinking(true);
            push({ type: "thinking-start" });
          }
          push({ type: "thinking-delta", delta: e.delta.thinking });
        }
        break;
      }
      case "content_block_stop": {
        const type = typeof e.index === "number" ? state.blockTypes.get(e.index) : undefined;
        if (type === "thinking" && state.getThinking()) {
          state.setThinking(false);
          push({ type: "thinking-end" });
        }
        break;
      }
    }
  }

  private buildArgs(sessionId: string, firstTurn: boolean, systemPrompt: string, thinkingOverride: string | undefined): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--safe-mode",
      "--system-prompt",
      systemPrompt,
      "--tools",
      READ_ONLY_TOOLS,
      firstTurn ? "--session-id" : "--resume",
      sessionId,
    ];
    const model = this.agent.model?.name;
    if (model) args.push("--model", model);
    const effort = effortFor(thinkingOverride ?? this.agent.thinking);
    if (effort) args.push("--effort", effort);
    return args;
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

  private resolveModelLabel(): string {
    const name = this.agent.model?.name;
    return name ? `anthropic/${name}` : "Claude default";
  }
}
