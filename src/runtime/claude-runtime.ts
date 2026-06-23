import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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
  // `detached: true` puts the child in its own process group so abort() can
  // signal the WHOLE tree (claude + any bash/tool grandchildren) via the
  // negative-pid group kill below. Without this, SIGTERM hits only the `claude`
  // parent and leaves its children running — which made agents unstoppable.
  const proc: ChildProcess = spawn("claude", options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: true,
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
      const pid = proc.pid;
      if (pid === undefined) return;
      // Kill the whole process group (negative pid). Escalate to SIGKILL after a
      // grace period in case claude or a child ignores SIGTERM, so abort is
      // guaranteed to stop the agent.
      const signalGroup = (signal: NodeJS.Signals) => {
        try {
          process.kill(-pid, signal);
        } catch {
          try {
            proc.kill(signal);
          } catch {
            // Already gone.
          }
        }
      };
      signalGroup("SIGTERM");
      const grace = setTimeout(() => signalGroup("SIGKILL"), 2000);
      grace.unref?.();
      proc.once("exit", () => clearTimeout(grace));
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
// session while leaving subscription auth, the model, built-in tools, and
// permissions intact (confirmed in `claude --help`).
const SAFE_MODE = "--safe-mode";

// ---------------------------------------------------------------------------
// Config-driven tool translation
// ---------------------------------------------------------------------------
//
// The agent's `tools` array is the single source of truth. A harness is a
// faithful translator of that config, not a place that bakes in "modes". This
// maps each logical GAIA tool onto Claude's two control surfaces:
//   --tools         which built-in tools exist in the session
//   --allowedTools  which calls auto-approve in -p mode (no interactive prompt,
//                   so anything not pre-approved is denied)
//
// memory/recall/summon are granted as a NARROW, locked `gaia` CLI permission
// (Bash with a fixed command prefix), DECOUPLED from the general `bash` toggle —
// gaia/sidia have memory/recall but no shell. A no-shell agent thus gets
// memory/recall and still cannot run arbitrary commands. We rely on Claude's
// permission matcher to block command chaining/injection past the prefix.

export interface ClaudeToolGrant {
  /** Built-in Claude tools to expose (--tools). Empty means "no tools". */
  tools: string[];
  /** Permission patterns to auto-approve (--allowedTools). */
  allowedTools: string[];
}

// Narrow gaia-CLI grants. The colon-prefix form matches commands beginning
// with the given words; Claude denies anything chained past them in -p mode.
const GAIA_GRANTS: Record<string, string> = {
  memory: "Bash(gaia mem:*)",
  recall: "Bash(gaia recall:*)",
  summon: "Bash(gaia summon:*)",
};

export function buildClaudeToolGrant(tools: string[]): ClaudeToolGrant {
  const has = (name: string): boolean => tools.includes(name);
  const builtin = new Set<string>();
  const allowed = new Set<string>();

  // Read-only tools are auto-approved by Claude even in default mode, so they
  // need no allow rule — only exposure.
  if (has("read")) for (const t of ["Read", "Grep", "Glob"]) builtin.add(t);
  if (has("write")) {
    builtin.add("Write");
    allowed.add("Write");
  }
  if (has("edit")) {
    builtin.add("Edit");
    allowed.add("Edit");
  }

  // memory/recall/summon need the Bash tool present (to invoke `gaia`) but only
  // the narrow command, independent of the general `bash` shell.
  const gaiaTools = Object.keys(GAIA_GRANTS).filter(has);
  if (has("bash") || gaiaTools.length > 0) builtin.add("Bash");
  if (has("bash")) allowed.add("Bash");
  for (const tool of gaiaTools) allowed.add(GAIA_GRANTS[tool]);

  return { tools: [...builtin], allowedTools: [...allowed] };
}

// Note shown in the thinking disclosure when the CLI redacted the reasoning text.
function thinkingNote(tokens: number): string {
  const spend = tokens > 0 ? `~${tokens} tokens` : "a moment";
  return `Reasoned for ${spend} before answering. (Claude hides reasoning text in -p mode.)`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Write a `gaia` shim that execs THIS install's cli.js and return its directory,
// to be PREPENDED to the subprocess PATH. That way a plain `gaia <cmd>` resolves
// to this exact daemon's CLI (shadowing any unrelated global `gaia`) AND still
// matches the narrow `Bash(gaia …:*)` permission grants. Best-effort: on failure
// we fall back to whatever `gaia` is already on PATH.
//
// Resolved lazily on first spawn (memoized), not at import: a Pi/Codex-only
// daemon — or the test suite — never spawns `claude` and shouldn't pay the fs
// writes. The shim is rewritten only when missing or stale (deterministic path).
let gaiaShimDir: string | undefined;
let gaiaShimResolved = false;
function ensureGaiaShimDir(): string | undefined {
  if (gaiaShimResolved) return gaiaShimDir;
  gaiaShimResolved = true;
  try {
    const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
    const dir = join(dirname(cliPath), ".bin");
    const shimPath = join(dir, "gaia");
    const contents = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} "$@"\n`;
    if (!existsSync(shimPath) || readFileSync(shimPath, "utf8") !== contents) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(shimPath, contents, { mode: 0o755 });
    }
    gaiaShimDir = dir;
  } catch {
    gaiaShimDir = undefined;
  }
  return gaiaShimDir;
}

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
  readonly capabilities = HARNESS_CAPABILITIES.claude;
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
    // memory/recall/summon reach the daemon via the `gaia` CLI (see
    // buildClaudeToolGrant), not an in-process handle; kept for factory parity.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly summonCreate?: SummonCreate,
    // Injectable process factory for testing.
    processFactory?: ClaudeProcessFactory,
    // Daemon bridge for memory writes / summon (undefined in tests + when the
    // agent has none of memory/recall/summon enabled).
    private readonly harnessHost?: HarnessHost,
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

    const channel = createEventChannel();

    // Per-turn parse state.
    const blockTypes = new Map<number, string>(); // content-block index -> type
    let thinkingActive = false;
    let thinkingTokens = 0; // best estimate of reasoning tokens spent this turn
    let thinkingTextSeen = false; // did any *real* reasoning text stream?
    const toolNames = new Map<string, string>(); // tool_use id -> name
    const endedTools = new Set<string>();

    const startThinking = (): void => {
      if (thinkingActive) return;
      thinkingActive = true;
      channel.push({ type: "thinking-start" });
    };
    const endThinking = (): void => {
      if (!thinkingActive) return;
      thinkingActive = false;
      // When no real reasoning text streamed (the usual -p case), hand the UI a
      // short note + token estimate so the thinking disclosure isn't empty.
      const note = thinkingTextSeen ? undefined : thinkingNote(thinkingTokens);
      channel.push(note ? { type: "thinking-end", content: note } : { type: "thinking-end" });
    };

    const onMessage = (raw: unknown): void => {
      const msg = raw as { type?: string };
      switch (msg.type) {
        case "system": {
          const sys = raw as { subtype?: string; model?: string; apiKeySource?: string; estimated_tokens?: number };
          if (sys.subtype === "init" && sys.model) {
            const subscription = sys.apiKeySource === "none";
            this.liveModelLabel = `anthropic/${sys.model}`;
            channel.push({ type: "model-info", provider: "anthropic", modelId: sys.model, subscription });
          } else if (sys.subtype === "thinking_tokens") {
            // The CLI redacts reasoning *text* in -p mode (it streams encrypted
            // thinking blocks), but reports a live token estimate. Surface that
            // as a "thinking" indicator so the pre-answer pause isn't silent.
            if (typeof sys.estimated_tokens === "number") thinkingTokens = Math.max(thinkingTokens, sys.estimated_tokens);
            startThinking();
          }
          break;
        }

        case "stream_event": {
          this.handleStreamEvent(
            (raw as { event?: unknown }).event,
            { blockTypes, startThinking, endThinking, markTextSeen: () => (thinkingTextSeen = true) },
            channel.push,
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
              channel.push({ type: "tool-start", toolName: block.name ?? "tool", toolCallId: block.id, args: block.input });
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
              channel.push({
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
            channel.fail(new Error(res.result || `Claude turn failed (${res.subtype ?? "error"}).`));
          }
          // Close any thinking indicator that never saw a content_block_stop.
          endThinking();
          channel.close();
          break;
        }
      }
    };

    const handle = this.processFactory({
      args,
      prompt,
      cwd: this.cwd,
      env: this.buildEnv(input.roomId),
      onMessage,
      onExit: ({ code, signal, stderr }) => {
        if (!channel.closed && code !== 0 && !channel.hasError) {
          channel.fail(
            claudeStartupError(
              new Error(`claude exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`),
              stderr,
            ),
          );
        }
        channel.close();
      },
      onError: (err) => {
        channel.fail(claudeStartupError(err));
        channel.close();
      },
    });
    this.active = handle;

    try {
      for await (const event of channel.stream()) yield event;
    } catch (err) {
      // A failed first turn may never have created a resumable session; drop
      // the room so the next turn starts fresh instead of --resume'ing nothing.
      if (firstTurn) this.rooms.delete(input.roomId);
      throw err;
    } finally {
      this.active = null;
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

  // Drop this room's session id so the next turn is a fresh --session-id (no
  // --resume), i.e. Claude forgets the prior conversation for /clear.
  resetRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private handleStreamEvent(
    event: unknown,
    state: { blockTypes: Map<number, string>; startThinking: () => void; endThinking: () => void; markTextSeen: () => void },
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
          // The reasoning block opens here even when its text is redacted, so
          // light up the thinking indicator as soon as it appears.
          if (e.content_block.type === "thinking") state.startThinking();
        }
        break;
      case "content_block_delta": {
        if (e.delta?.type === "text_delta" && e.delta.text) {
          push({ type: "text-delta", delta: e.delta.text });
        } else if (e.delta?.type === "thinking_delta") {
          state.startThinking();
          // Real reasoning text is usually empty in -p mode; stream it when present.
          if (e.delta.thinking) {
            state.markTextSeen();
            push({ type: "thinking-delta", delta: e.delta.thinking });
          }
        }
        break;
      }
      case "content_block_stop": {
        const type = typeof e.index === "number" ? state.blockTypes.get(e.index) : undefined;
        if (type === "thinking") state.endThinking();
        break;
      }
    }
  }

  private buildArgs(sessionId: string, firstTurn: boolean, systemPrompt: string, thinkingOverride: string | undefined): string[] {
    const grant = buildClaudeToolGrant(this.agent.tools);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      SAFE_MODE,
      "--system-prompt",
      systemPrompt,
      // Single comma-joined token: --tools/--allowedTools are variadic, so a
      // joined value keeps them from swallowing later flags. Tool/pattern names
      // contain no commas. "" disables all tools when the agent has none.
      "--tools",
      grant.tools.join(","),
    ];
    if (grant.allowedTools.length > 0) {
      args.push("--allowedTools", grant.allowedTools.join(","));
    }
    // Posture knob as data: plan/acceptEdits/etc. live in the agent config, not
    // a hardcoded branch. Default (unset) leaves Claude's default behavior.
    if (this.agent.permissionMode) {
      args.push("--permission-mode", this.agent.permissionMode);
    }
    args.push(firstTurn ? "--session-id" : "--resume", sessionId);
    const model = this.agent.model?.name;
    if (model) args.push("--model", model);
    const effort = effortFor(thinkingOverride ?? this.agent.thinking);
    if (effort) args.push("--effort", effort);
    return args;
  }

  private buildSystemPrompt(input: AgentInput): Promise<string> {
    // Claude Code never sees Pi-style skill files, so the active role's skill
    // text is inlined into the system prompt (handled by buildInlineSystemPrompt).
    return buildInlineSystemPrompt({
      workspace: this.workspace,
      agent: this.agent,
      role: input.activeRole,
      toolPointer: gaiaCliPointer(this.agent.tools, this.capabilities.gaiaTools),
    });
  }

  // Per-turn env for the subprocess: reads work straight off disk (memory dir,
  // room dir); writes/summon go to the daemon with a token scoped to this
  // (agent, room). Only added when a daemon bridge is present.
  private buildEnv(roomId: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GAIA_MEMORY_DIR: this.agent.memoryDir,
      GAIA_ROOM_DIR: join(this.workspace.roomsDir, roomId),
      GAIA_ROOM_ID: roomId,
      GAIA_AGENT_ID: this.agent.id,
    };
    // Prepend our `gaia` shim so plain `gaia <cmd>` runs THIS daemon's CLI.
    const shimDir = ensureGaiaShimDir();
    if (shimDir) env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
    if (this.harnessHost) {
      env.GAIA_DAEMON_URL = this.harnessHost.baseUrl;
      env.GAIA_DAEMON_TOKEN = this.harnessHost.mintToken({ agentId: this.agent.id, roomId });
    }
    return env;
  }

  private resolveModelLabel(): string {
    const name = this.agent.model?.name;
    return name ? `anthropic/${name}` : "Claude default";
  }
}
