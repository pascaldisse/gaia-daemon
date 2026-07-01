// The Claude Code harness: one `claude -p` CLI invocation per turn, resumed
// across turns via --session-id/--resume, NDJSON stream-json parsing. All
// claude-specific knowledge (flags, grants, wire shapes, cred env) lives HERE;
// shared code sees only the HarnessSpec registered at the bottom.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { AgentDef, AgentEvent, Workspace } from "../core/types.js";
import { workspacePaths } from "../core/paths.js";
import type { MemoryStore } from "../domain/memory.js";
import { GAIA_TOOLS } from "../services/tools.js";
import {
  type AgentInput,
  type AgentRuntime,
  type HarnessCapabilities,
  type HarnessHost,
  registerHarness,
  type RuntimeCreateContext,
} from "./spec.js";
import { createEventChannel } from "./events.js";
import { SessionMap } from "./sessions.js";
import { killProcessTree, missingBinaryError, resolveCliEntry, selfRelaunchArgv, spawnLineReader } from "./proc.js";
import { buildInlineSystemPrompt, buildTurnPrompt, gaiaCliPointer } from "./prompt.js";

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
  let settled = false;
  // `detached: true` puts the child in its own process group so abort() can
  // signal the WHOLE tree (claude + any bash/tool grandchildren) via the
  // group kill in killProcessTree. Without this, SIGTERM hits only the `claude`
  // parent and leaves its children running — which made agents unstoppable.
  const { proc, rl, stderr } = spawnLineReader({
    command: "claude",
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    detached: true,
    onLine: (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.trim());
      } catch {
        return; // ignore non-JSON noise
      }
      options.onMessage(parsed);
    },
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
    options.onExit({ code, signal, stderr: stderr() });
  });

  // Deliver the prompt on stdin, then close it so the CLI starts the turn.
  proc.stdin?.write(options.prompt);
  proc.stdin?.end();

  return {
    kill() {
      killProcessTree(proc);
    },
  };
}

function claudeStartupError(error: unknown, stderr?: string): Error {
  return missingBinaryError("claude", "Claude Code", error, stderr);
}

// ---------------------------------------------------------------------------
// Per-room session state (tracked by the uniform SessionMap)
// ---------------------------------------------------------------------------

interface ClaudeRoomMeta {
  /** Session id we generated and pass as --session-id, then --resume on later turns. */
  sessionId: string;
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
  // the narrow, locked command prefix (the registry's grant), independent of the
  // general `bash` shell. The colon-prefix form matches commands beginning with
  // the grant words; Claude denies anything chained past them in -p mode.
  const gaiaTools = GAIA_TOOLS.filter((tool) => has(tool.id));
  if (has("bash") || gaiaTools.length > 0) builtin.add("Bash");
  if (has("bash")) allowed.add("Bash");
  for (const tool of gaiaTools) allowed.add(tool.grant);

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
    const cliPath = resolveCliEntry();
    const dir = join(dirname(cliPath), ".bin");
    const shimPath = join(dir, "gaia");
    // Re-launch the CLI exactly how THIS daemon was launched (execPath + the
    // node flags in execArgv + the resolved entry — see selfRelaunchArgv), so a
    // plain `gaia <cmd>` works in both built mode (`node cli.js`) and dev/tsx
    // mode (`node --import tsx … cli.ts`).
    const runner = selfRelaunchArgv().map(shellQuote).join(" ");
    const contents = `#!/bin/sh\nexec ${runner} "$@"\n`;
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

// memory/recall/summon reach the daemon via the `gaia` CLI (see
// buildClaudeToolGrant), not an in-process handle — so summonCreate is
// accepted from the uniform context and ignored.
export interface ClaudeRuntimeOptions extends RuntimeCreateContext {
  /** Injectable process factory for testing. */
  processFactory?: ClaudeProcessFactory;
}

const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  gaiaTools: ["memory", "recall", "summon"],
  granularTools: true,
  supportsPermissionMode: true,
};

export class ClaudeRuntime implements AgentRuntime {
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly agent: AgentDef;
  private readonly workspace: Workspace;
  private readonly memoryStore: MemoryStore;
  private readonly harnessHost?: HarnessHost;
  private readonly cwd: string;
  private readonly sessions = new SessionMap<ClaudeRoomMeta>();
  private active: ClaudeProcessHandle | null = null;
  private readonly processFactory: ClaudeProcessFactory;
  private readonly configuredModelLabel: string;
  private liveModelLabel: string | undefined;

  constructor(options: ClaudeRuntimeOptions) {
    this.workspace = options.workspace;
    this.agent = options.agent;
    this.memoryStore = options.memoryStore;
    this.harnessHost = options.harnessHost;
    this.cwd = options.workspace.rootDir;
    this.processFactory = options.processFactory ?? spawnClaudeProcess;
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
    const room = this.sessions.ensure(input.roomId, () => ({ sessionId: randomUUID(), started: false }));
    const firstTurn = !room.started;
    const memoryChanged = this.sessions.memoryChanged(input.roomId, memory);

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
      // (reset also drops the memory diff, so memory is re-sent then.)
      if (firstTurn) this.sessions.reset(input.roomId);
      throw err;
    } finally {
      this.active = null;
    }

    room.started = true;
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
    this.sessions.disposeAll();
  }

  // Drop this room's session id so the next turn is a fresh --session-id (no
  // --resume), i.e. Claude forgets the prior conversation for /clear.
  resetRoom(roomId: string): void {
    this.sessions.reset(roomId);
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
      GAIA_ROOM_DIR: workspacePaths.roomDir(this.workspace.rootDir, roomId),
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

// The real Claude Code credential store (API-key logins). Subscription/OAuth
// creds live in the OS keychain, but a stored key file must be deny-read when
// the proxy hides credentials from a sandboxed turn.
function realClaudeCredentials(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

registerHarness({
  id: "claude",
  capabilities: CLAUDE_CAPABILITIES,
  ui: {
    // Claude Code picks the model itself; `--model` takes its own aliases, not
    // Pi catalog ids. Offer those aliases ("opus" = latest Opus) and hide the
    // provider. Empty = whatever the Claude Code CLI defaults to.
    label: "claude",
    description: "Claude Code CLI (claude -p, subscription auth)",
    lockedProvider: "anthropic",
    modelNameOptions: ["opus", "sonnet", "haiku"],
  },
  create: (ctx) => new ClaudeRuntime(ctx),
  // Claude Code routes its API calls through ANTHROPIC_BASE_URL bearing
  // ANTHROPIC_AUTH_TOKEN. Point both at the loopback proxy + per-turn token; the
  // daemon swaps in the real anthropic key. Subscription/OAuth logins have no key
  // to hide, so the proxy resolver fail-closes for them (correct, not special-cased).
  credentialProxy: ({ proxyUrl, token }) => ({
    env: { ANTHROPIC_BASE_URL: proxyUrl, ANTHROPIC_AUTH_TOKEN: token },
    denyRead: [realClaudeCredentials()],
  }),
});
