// The Claude Code harness: one `claude -p` CLI invocation per turn, resumed
// across turns via --session-id/--resume, NDJSON stream-json parsing. All
// claude-specific knowledge (flags, grants, wire shapes, cred env) lives HERE;
// shared code sees only the HarnessSpec registered at the bottom.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { loadNativeImages } from "../core/attachments.js";
import { NO_SESSION_TO_COMPACT, type AgentDef, type AgentEvent, type CompactProgressUpdate, type CompactResult, type MessageAttachment, type UsageProbeResult, type Workspace } from "../core/types.js";
import type { MemoryStore } from "../domain/memory.js";
import { scanSkillRoot } from "../domain/skills.js";
import { GAIA_TOOLS } from "./tools.js";
import {
  type AgentInput,
  type AgentRuntime,
  type HarnessCapabilities,
  type NativeCommandDef,
  registerHarness,
  type RuntimeCreateContext,
} from "./spec.js";
import { createEventChannel } from "./events.js";
import { resolveMcpServers } from "../core/config.js";
import { fileSessionStore, SessionMap } from "./sessions.js";
import { ModelLabel } from "./model-label.js";
import { killProcessTree, missingBinaryError, resolveCliEntry, selfRelaunchArgv, spawnLineReader } from "./proc.js";
import { buildInlineSystemPrompt, buildTurnPromptFor, gaiaCliPointer } from "./prompt.js";
import { startThinkingProxy, type ThinkingProxyHandle } from "./claude-thinking-proxy.js";
import { ANTHROPIC_USAGE_ACCOUNT, fetchAnthropicUsage, USAGE_TIMEOUT_MS } from "./usage.js";

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

/** stream-json user-message content: a bare prompt string, or the text-block +
 * base64-image-block array the Agent SDK wire uses when a turn carries native
 * images. Shared by the first turn (send) and mid-turn steer. */
export type ClaudeUserContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;

export interface ClaudeProcessHandle {
  /** Best-effort terminate (used by abort()). */
  kill(): void;
  /** Inject an extra user message into the RUNNING turn via the open stdin
   * (backs steering). The CLI applies it at the next tool boundary — same as
   * typing while Claude Code works interactively. Returns false when stdin is
   * no longer writable (turn already finished). Present only on stream-json
   * turns spawned with keepStdinOpen. `content` is a bare string, or the same
   * text+image block array a first turn uses when the steer carries images. */
  steer?(content: ClaudeUserContent): boolean;
  /** Signal end-of-input (stdin EOF) so a keepStdinOpen turn's CLI finishes and
   * exits. Called once the turn's `result` has streamed. */
  endInput?(): void;
}

export interface ClaudeProcessOptions extends ClaudeProcessCallbacks {
  args: string[];
  /** Turn prompt, delivered on stdin (avoids arg-length limits on big transcripts). */
  prompt: string;
  /** Keep stdin OPEN after writing the prompt so the turn can be steered
   * (stream-json input). When false the prompt is a one-shot and stdin is
   * closed immediately (native slash commands, compaction). */
  keepStdinOpen?: boolean;
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

  // Deliver the prompt on stdin. A one-shot turn closes stdin now (EOF starts
  // the CLI and lets it exit when done). A steerable turn keeps stdin open so
  // steer() can inject more user messages mid-turn; endInput() closes it once
  // the turn's result has streamed. The CLI begins the turn on the first
  // message either way — it does not wait for EOF.
  proc.stdin?.write(options.prompt);
  if (!options.keepStdinOpen) proc.stdin?.end();

  return {
    kill() {
      killProcessTree(proc);
    },
    steer(content: ClaudeUserContent): boolean {
      const stdin = proc.stdin;
      if (!stdin || !stdin.writable || stdin.writableEnded) return false;
      stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
      return true;
    },
    endInput(): void {
      const stdin = proc.stdin;
      if (stdin && !stdin.writableEnded) stdin.end();
    },
  };
}

function claudeStartupError(error: unknown, stderr?: string): Error {
  return missingBinaryError("claude", "Claude Code", error, stderr);
}

/** Build stream-json user content for a turn or steer: the bare text when there
 * are no native images, else a text block followed by base64 image blocks (the
 * same wire the Agent SDK uses). Shared by send() and steer() so the mid-turn
 * image path is identical to the first-turn one. */
function claudeUserContent(text: string, images: { attachment: MessageAttachment; base64: string }[]): ClaudeUserContent {
  if (images.length === 0) return text;
  return [
    { type: "text", text },
    ...images.map(({ attachment, base64 }) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: attachment.mime, data: base64 },
    })),
  ];
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

// A steer (an extra user message injected on the open stdin) that lands after
// the turn's LAST tool boundary doesn't fold into the turn — the CLI finishes,
// emits `result`, then runs the injected message as its OWN continuation turn
// (a fresh `system init` + its own `result`, observed ~10-30 ms after the first
// result). If we closed the channel on that first `result` we'd drop the
// continuation and the steer would be silently lost. So when a steer is pending
// we DON'T close on the first `result`; we wait this grace for the continuation
// to begin (any further message cancels the wait and we stream it through to its
// own `result`). If nothing comes, the steer folded into the result we already
// have and we close. The delay only affects a steered turn's final commit.
const STEER_CONTINUATION_GRACE_MS = 1500;

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
  // `web` maps to Claude's own built-in web tools (codex uses its native
  // web_search; pi uses the brave-search skill — each harness enables web its
  // own native way). Read-only, but allow-list them so non-bypass agents can call.
  if (has("web"))
    for (const t of ["WebSearch", "WebFetch"]) {
      builtin.add(t);
      allowed.add(t);
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

// Note shown in the thinking disclosure when no reasoning TEXT streamed even
// though the reveal shim is on (it always is, now): the turn simply produced no
// reasoning text — a no-thinking model/turn, or the model returned none.
function thinkingNote(tokens: number): string {
  const spend = tokens > 0 ? `~${tokens} tokens` : "a moment";
  return `Reasoned for ${spend} before answering (no reasoning text returned for this turn).`;
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

// Claude Code auto-selects the 1M-token window for Opus/Sonnet/Fable when it
// talks to Anthropic DIRECTLY, but not when ANTHROPIC_BASE_URL is re-pointed:
// our reveal-thinking and credential proxies do exactly that, so the CLI can't
// confirm the endpoint supports 1M and silently falls back to the 200k default
// (verified: plain `opus` direct → contextWindow 1000000; the same turn behind
// our proxy → 200000). The documented override is the `[1m]` model-id suffix,
// which forces the 1M window behind a gateway AND is a harmless no-op talking to
// Anthropic direct (that model is already 1M). Applied to every model that HAS a
// 1M window. Two opt-outs, both data: an explicit `[...]` suffix in the config is
// passed through as-is (e.g. a pinned 200k variant), and haiku — the one tier
// with no 1M window — errors on `[1m]`, so it's left bare. A capability hint, not
// a security gate.
export function claudeModelArg(name: string): string {
  if (name.includes("[")) return name; // caller pinned an explicit context window
  if (/haiku/i.test(name)) return name; // 200k-only tier — errors on [1m]
  return `${name}[1m]`;
}

/** A-priori context window for a claude model — the pre-flight figure the
 * context gate shows before a turn runs. Mirrors claudeModelArg: haiku is the
 * one 200k-only tier; a `[200k]`-style pin is honored; everything else runs the
 * 1M window (opus/sonnet/fable/mythos). */
export function claudeContextWindow(name: string | undefined): number {
  if (!name) return 1_000_000;
  const pin = /\[(\d+)(k|m)\]/i.exec(name);
  if (pin) return Number(pin[1]) * (pin[2].toLowerCase() === "m" ? 1_000_000 : 1_000);
  if (/haiku/i.test(name)) return 200_000;
  return 1_000_000;
}

// ---------------------------------------------------------------------------
// ClaudeRuntime
// ---------------------------------------------------------------------------

// memory/recall/summon reach the daemon via the `gaia` CLI (see
// buildClaudeToolGrant), not an in-process handle — so summonCreate and
// harnessHost are accepted from the uniform context and ignored (the CLI's
// bridge env is composed once by RunnerHost and inherited via process.env).
export interface ClaudeRuntimeOptions extends RuntimeCreateContext {
  /** Injectable process factory for testing. */
  processFactory?: ClaudeProcessFactory;
}

/** The API usage block on assistant messages (snake_case wire). Context
 * footprint = input + both cache fields; output_tokens is excluded. */
interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  gaiaTools: ["memory", "recall", "summon"],
  nativeTools: ["web"],
  granularTools: true,
  supportsPermissionMode: true,
  supportsMcp: true,
  // claude -p CAN be steered: driven with --input-format stream-json and stdin
  // kept open, an extra user message written mid-turn is applied at the next
  // tool boundary (same as typing while the interactive TUI works). See
  // ClaudeRuntime.steer + the keepStdinOpen path in send().
  supportsSteer: true,
  // /compact is supportsNonInteractive in the CLI: a headless resumed turn
  // with the prompt "/compact" compacts the session file durably.
  supportsCompact: true,
  // Claude Code resolves skills/slash commands (/deep-research, /code-review, …)
  // from a raw `-p` stdin when its command surface is enabled — so gaia can pass
  // an unrecognized slash command straight through (see the native branch in
  // send() + buildArgs). Off under --safe-mode, so a native turn swaps the
  // isolation flags for --setting-sources ""/--strict-mcp-config.
  supportsNativeCommands: true,
  // Claude Code's own subagent surfaces: the Task/Agent tool and the Workflow
  // orchestrator (what /deep-research fans out through). All suppressed via
  // --disallowedTools on EVERY turn (see buildArgs) so fan-out routes through
  // `gaia summon` instead: visible sub-rooms, durable turns, sandbox + trust,
  // result callback — instead of opaque in-CLI workers that block the room
  // thread for hours and die silently with the process.
  fanOutTools: ["Task", "Agent", "Workflow"],
};

export class ClaudeRuntime implements AgentRuntime {
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly agent: AgentDef;
  private readonly workspace: Workspace;
  private readonly memoryStore: MemoryStore;
  private readonly cwd: string;
  /** Where the agent child RUNS: this runner process's own cwd — RunnerHost
   * set it to the room's git worktree (RoomState.workDir) or the workspace
   * root. Distinct from this.cwd (workspace root), which anchors daemon
   * state paths (session stores, room dirs) that must never move with the
   * checkout. */
  private readonly workDir: string;
  /** Persisted per room: --resume continues the same CLI session across
   * daemon/runner restarts (the CLI keeps the conversation on disk). */
  private readonly sessions: SessionMap<ClaudeRoomMeta>;
  private active: ClaudeProcessHandle | null = null;
  /** Room whose turn `active` is streaming — steer() only injects into it. */
  private activeRoomId: string | undefined;
  /** Set by the streaming send() so a successful steer can keep the turn's
   * channel open for the injected message's continuation (see
   * STEER_CONTINUATION_GRACE_MS). Cleared when the turn ends. */
  private onActiveSteer: (() => void) | undefined;
  private readonly processFactory: ClaudeProcessFactory;
  private readonly label: ModelLabel;
  /** Loopback egress shim that un-redacts thinking text — always on, every
   * claude agent. Started once, lazily; memoized so a start failure fails open
   * (turns proceed without thinking text rather than breaking). */
  private thinkingProxy: ThinkingProxyHandle | undefined;
  private thinkingProxyPromise: Promise<ThinkingProxyHandle | undefined> | undefined;

  constructor(options: ClaudeRuntimeOptions) {
    this.workspace = options.workspace;
    this.agent = options.agent;
    this.memoryStore = options.memoryStore;
    this.cwd = options.workspace.rootDir;
    this.workDir = process.cwd();
    this.sessions = new SessionMap<ClaudeRoomMeta>(undefined, fileSessionStore(this.cwd, "claude", this.agent.id));
    this.processFactory = options.processFactory ?? spawnClaudeProcess;
    this.label = new ModelLabel(this.resolveModelLabel());
  }

  get modelLabel(): string {
    return this.label.current;
  }

  // -----------------------------------------------------------------------
  // send – one `claude -p` invocation per turn, resumed across turns
  // -----------------------------------------------------------------------

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const room = this.sessions.ensure(input.roomId, () => ({ sessionId: randomUUID(), started: false }));
    const firstTurn = !room.started;

    // A native command (/deep-research …) is handed to the CLI VERBATIM: the
    // slash command only resolves when it is the whole stdin, so we skip the
    // usual room/memory/transcript wrapping (memory stays "unseen" for the next
    // real turn) and run the skills-enabled flag profile (see buildArgs). The
    // resumed session still carries prior context.
    const native = input.nativeCommand === true;
    const systemPrompt = await this.buildSystemPrompt(input);
    const prompt = native ? input.message.trim() : await buildTurnPromptFor(this.agent, input, this.memoryStore, this.sessions);
    const args = this.buildArgs(room.sessionId, firstTurn, systemPrompt, input.thinking, native);

    // Every non-native turn is delivered via stream-json INPUT with stdin kept
    // OPEN: that's the channel steering writes into (an extra user message the
    // CLI applies at the next tool boundary). One user message carries the turn
    // prompt; pasted images add base64 blocks to its content (the same wire the
    // Agent SDK uses). A native command is pure command text that only resolves
    // as the WHOLE plain stdin, so it stays a one-shot (no wrap, stdin closed,
    // not steerable).
    const images = native ? [] : await loadNativeImages(input.attachments);
    const keepStdinOpen = !native;
    if (keepStdinOpen) args.push("--input-format", "stream-json");
    const content = claudeUserContent(prompt, images);
    const stdinPayload = native ? prompt : `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;

    const channel = createEventChannel();

    // Steer-continuation bookkeeping: a steer injected this turn defers the
    // close on the next `result` so the injected message's continuation turn is
    // streamed & folded into this reply instead of being dropped.
    let steerPending = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const clearGrace = (): void => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
    };
    // A fresh steer (while a prior one is awaiting its continuation) means more
    // is still coming — keep waiting.
    this.onActiveSteer = () => {
      steerPending = true;
      clearGrace();
    };

    // Per-turn parse state.
    const blockTypes = new Map<number, string>(); // content-block index -> type
    let subscription = false; // from init's apiKeySource; reused on fallback
    // Context accounting: the LAST assistant usage is the session's context
    // footprint (input + both cache fields; output excluded — the CLI's own
    // statusline formula). The window size arrives on result.modelUsage.
    let lastUsage: ClaudeUsage | undefined;
    let thinkingActive = false;
    let thinkingTokens = 0; // best estimate of reasoning tokens spent this turn
    let thinkingTextSeen = false; // did any *real* reasoning text stream?
    const toolNames = new Map<string, string>(); // tool_use id -> name
    const endedTools = new Set<string>();
    let sessionEstablished = false; // did Claude create the resumable session this turn?

    // Persist the session as "started" the moment Claude creates it (the init
    // event), NOT only after a clean finish. A user stop aborts by killing the
    // subprocess mid-turn (cancelActiveTask → abort() → kill), so the
    // post-stream commit never runs; on a first turn the catch below would then
    // also drop the session — together wiping the whole conversation even though
    // the resumable session already exists on disk. Marking here fixes both: the
    // next turn --resumes, and the catch keeps a session that got established.
    const markStarted = (): void => {
      sessionEstablished = true;
      if (room.started) return;
      room.started = true;
      this.sessions.set(input.roomId, room); // set() (not a bare mutation) → store persists started=true
    };

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

    // Context footprint = input + both cache fields (output excluded — the CLI's
    // own statusline formula). Emitted per assistant round-trip so the ctx chip
    // grows DURING the turn, not only at result. The window size (maxTokens) only
    // arrives on result.modelUsage; the shared layer keeps the last-known window
    // so the % stays live on the mid-turn events that can't carry it.
    const pushContextUsage = (usage: ClaudeUsage, maxTokens?: number): void => {
      const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      channel.push({ type: "context-usage", usedTokens: used, ...(maxTokens ? { maxTokens } : {}) });
    };

    const onMessage = (raw: unknown): void => {
      const msg = raw as { type?: string };
      // Any non-`result` message arriving while we're in the grace window means
      // the steer's continuation turn has begun (its `system init` etc.) — stop
      // the grace-close and let it stream through to its own `result`.
      if (graceTimer && msg.type !== "result") clearGrace();
      switch (msg.type) {
        case "system": {
          const sys = raw as {
            subtype?: string;
            model?: string;
            apiKeySource?: string;
            estimated_tokens?: number;
            trigger?: string;
            content?: string;
            original_model?: string;
            fallback_model?: string;
            originalModel?: string;
            fallbackModel?: string;
          };
          if (sys.subtype === "init") {
            // The resumable session now exists — persist "started" so a
            // mid-turn stop/kill can't lose it (see markStarted).
            markStarted();
            if (sys.model) {
              subscription = sys.apiKeySource === "none";
              const info = { type: "model-info", provider: "anthropic", modelId: sys.model, subscription } as const;
              this.label.observe(info);
              channel.push(info);
            }
          } else if (sys.subtype === "model_fallback" || sys.subtype === "model_refusal_fallback") {
            // The CLI switched models server-side mid-turn: a capacity/availability
            // fallback (`model_fallback`, trigger e.g. "overloaded") or a safety-
            // classifier reroute (`model_refusal_fallback`, e.g. fable → opus).
            // Field names are snake_case on the stream-json wire; accept the
            // camelCase spelling too (session-file replays use it).
            const from = sys.original_model ?? sys.originalModel ?? this.agent.model?.name ?? "configured model";
            const to = sys.fallback_model ?? sys.fallbackModel;
            if (to) {
              const info = { type: "model-info", provider: "anthropic", modelId: to, subscription } as const;
              this.label.observe(info);
              channel.push(info);
              channel.push({
                type: "model-fallback",
                fromModel: from,
                toModel: to,
                reason: sys.content?.trim() || `switched to ${to}${sys.trigger ? ` (${sys.trigger})` : ""}`,
              });
            }
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
          const usage = (raw as { message?: { usage?: ClaudeUsage } }).message?.usage;
          if (usage) {
            lastUsage = usage;
            pushContextUsage(usage); // live ctx as each round-trip lands
          }
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
          const res = raw as {
            subtype?: string;
            is_error?: boolean;
            result?: string;
            modelUsage?: Record<string, { contextWindow?: number }>;
          };
          if (lastUsage) {
            const windows = Object.values(res.modelUsage ?? {})
              .map((m) => m.contextWindow)
              .filter((n): n is number => typeof n === "number");
            pushContextUsage(lastUsage, windows.length ? Math.max(...windows) : undefined);
          }
          // Close any thinking indicator that never saw a content_block_stop.
          endThinking();
          clearGrace();
          if (res.is_error === true || (res.subtype && res.subtype !== "success")) {
            channel.fail(new Error(res.result || `Claude turn failed (${res.subtype ?? "error"}).`));
            channel.close();
          } else if (steerPending) {
            // A steer was injected during this turn. Don't end here: the CLI runs
            // the injected message as a continuation turn whose events fold into
            // this same reply. Wait briefly for it to begin; if nothing comes,
            // the steer folded into the result we already streamed — close.
            steerPending = false;
            graceTimer = setTimeout(() => {
              graceTimer = undefined;
              channel.close();
            }, STEER_CONTINUATION_GRACE_MS);
          } else {
            channel.close();
          }
          break;
        }
      }
    };

    // Bring up the thinking shim (no-op unless the agent opted in) before we
    // snapshot env — buildEnv reads its resolved URL.
    await this.ensureThinkingProxy();

    const handle = this.processFactory({
      args,
      prompt: stdinPayload,
      keepStdinOpen,
      cwd: this.workDir,
      env: this.buildEnv(),
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
    this.activeRoomId = input.roomId;

    try {
      for await (const event of channel.stream()) yield event;
    } catch (err) {
      // Drop the session ONLY when it was never established this turn: a first
      // turn whose Claude process died before init (nothing resumable was
      // created), or a resume against a session the CLI no longer knows (pruned
      // — "no conversation found", unrecoverable by retry). A stop/kill AFTER
      // init established the session must KEEP it, so the next turn --resumes
      // the conversation instead of starting blank. (reset also drops the
      // memory diff, so memory is re-sent on the fresh session.)
      const message = err instanceof Error ? err.message : String(err);
      if (!sessionEstablished && (firstTurn || /no conversation found/i.test(message))) this.sessions.reset(input.roomId);
      throw err;
    } finally {
      clearGrace();
      this.onActiveSteer = undefined;
      // A keepStdinOpen turn's CLI sits idle waiting for more stdin after it
      // streams `result`; close stdin so it reaches EOF and exits. (No-op when
      // the turn was aborted — the process is already being killed.)
      handle.endInput?.();
      this.active = null;
      this.activeRoomId = undefined;
    }

    // Clean finish also marks started — idempotent with the init-time persist,
    // and a safety net if an init without a model field ever slips through.
    markStarted();
  }

  // -----------------------------------------------------------------------
  // compact — a headless "/compact" turn against the resumed session
  // -----------------------------------------------------------------------

  /** Native Claude Code compaction (backs /compact): the CLI's own /compact
   * slash command is supportsNonInteractive, so one `-p --resume` invocation
   * with the prompt "/compact" summarizes and persists the compacted session.
   * Completion is the compact_boundary system message. */
  async compact(roomId: string, onProgress?: (update: CompactProgressUpdate) => void): Promise<CompactResult> {
    const room = this.sessions.get(roomId);
    if (!room?.started) return NO_SESSION_TO_COMPACT;
    // --include-partial-messages so the summary streams as it's written: the
    // partial usage blocks below are the only mid-pass progress the CLI exposes.
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", SAFE_MODE, "--resume", room.sessionId];
    const model = this.agent.model?.name;
    if (model) args.push("--model", claudeModelArg(model));
    await this.ensureThinkingProxy();
    return new Promise<CompactResult>((resolve, reject) => {
      let preTokens: number | undefined;
      let compacted = false;
      let failed: string | undefined;
      // Coalesce progress: only surface a frame when a count actually advances,
      // so thousands of stream deltas don't each round-trip to the daemon.
      let sentContext: number | undefined;
      let sentOutput: number | undefined;
      const reportUsage = (usage: ClaudeUsage | undefined) => {
        if (!usage || !onProgress) return;
        const context = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        const output = usage.output_tokens;
        const update: CompactProgressUpdate = {};
        if (context > 0 && context !== sentContext) update.contextTokens = sentContext = context;
        if (typeof output === "number" && output !== sentOutput) update.outputTokens = sentOutput = output;
        if (update.contextTokens !== undefined || update.outputTokens !== undefined) onProgress(update);
      };
      const handle = this.processFactory({
        args,
        prompt: "/compact",
        cwd: this.workDir,
        env: this.buildEnv(),
        onMessage: (raw) => {
          const msg = raw as {
            type?: string;
            subtype?: string;
            compact_metadata?: { pre_tokens?: number };
            compact_result?: string;
            compact_error?: string;
            is_error?: boolean;
            result?: string;
            message?: { usage?: ClaudeUsage };
            event?: { type?: string; message?: { usage?: ClaudeUsage }; usage?: ClaudeUsage };
          };
          if (msg.type === "system" && msg.subtype === "compact_boundary") {
            compacted = true;
            preTokens = msg.compact_metadata?.pre_tokens;
          } else if (msg.type === "system" && msg.subtype === "status" && msg.compact_result === "failed") {
            failed = msg.compact_error || "compaction failed";
          } else if (msg.type === "result" && msg.is_error === true) {
            failed ??= msg.result || "compaction failed";
          } else if (msg.type === "assistant") {
            reportUsage(msg.message?.usage);
          } else if (msg.type === "stream_event") {
            // message_start carries the input (context) usage; message_delta the
            // running output count as the summary is written.
            reportUsage(msg.event?.message?.usage ?? msg.event?.usage);
          }
        },
        onExit: ({ code, signal, stderr }) => {
          if (this.active === handle) this.active = null;
          if (failed) reject(new Error(failed));
          else if (compacted || code === 0) {
            // Surface Claude's own summary of the evicted history so the daemon
            // can persist it (durable compaction). Best-effort — no summary just
            // means a later reload falls back to raw context.
            const summary = this.readLatestCompactSummary(room.sessionId);
            resolve({
              compacted: true,
              message: compacted ? `session compacted${typeof preTokens === "number" ? ` (${preTokens} tokens before)` : ""}.` : "session compacted.",
              ...(summary ? { summary } : {}),
            });
          } else
            reject(
              claudeStartupError(
                new Error(`claude exited (${signal ? `signal ${signal}` : `exit ${code}`}) before compacting.`),
                stderr,
              ),
            );
        },
        onError: (err) => {
          if (this.active === handle) this.active = null;
          reject(claudeStartupError(err));
        },
      });
      // Track the pass like a turn so abort()/dispose() can actually KILL it —
      // untracked, a cancel or timeout "failed" while the CLI kept compacting
      // and rewrote the session behind the user's back.
      this.active = handle;
    });
  }

  /** After a native /compact, Claude appends an `isCompactSummary` row to the
   * session file — its own summary of the evicted history. Return the latest
   * one so gaia can persist it (durable compaction: a later session loss reloads
   * [summary + tail] rather than raw-from-0 or a thin tail). The session id is a
   * UUID, so the file is found under any project dir regardless of cwd munging;
   * every failure degrades to no summary (never throws into the compact result). */
  private readLatestCompactSummary(sessionId: string): string | undefined {
    try {
      const base = join(homedir(), ".claude", "projects");
      if (!existsSync(base)) return undefined;
      for (const dir of readdirSync(base)) {
        const file = join(base, dir, `${sessionId}.jsonl`);
        if (!existsSync(file)) continue;
        let summary: string | undefined;
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (!line.trim()) continue;
          let row: { isCompactSummary?: boolean; message?: { content?: unknown } };
          try {
            row = JSON.parse(line);
          } catch {
            continue;
          }
          if (row.isCompactSummary !== true) continue;
          const content = row.message?.content;
          if (typeof content === "string") summary = content;
          else if (Array.isArray(content))
            summary = content
              .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
              .map((b) => b.text)
              .join("");
        }
        return summary;
      }
    } catch {
      /* best-effort: no summary if the session file can't be read */
    }
    return undefined;
  }

  // -----------------------------------------------------------------------
  // abort / dispose
  // -----------------------------------------------------------------------

  async abort(): Promise<void> {
    this.active?.kill();
  }

  /** Inject guidance into the room's RUNNING turn (backs /steer and steer-by-
   * default). Writes an extra user message to the live turn's open stdin; the
   * CLI applies it at the next tool boundary. Resolves false when nothing is
   * streaming for this room or stdin already closed (turn just finished). */
  async steer(roomId: string, message: string, attachments?: MessageAttachment[]): Promise<boolean> {
    if (roomId !== this.activeRoomId) return false;
    const ok = this.active?.steer?.(claudeUserContent(message, await loadNativeImages(attachments))) ?? false;
    // Tell the streaming turn a steer landed so it keeps its channel open for
    // the injected message's continuation instead of ending on the next result.
    if (ok) this.onActiveSteer?.();
    return ok;
  }

  dispose(): void {
    this.active?.kill();
    this.active = null;
    this.thinkingProxy?.close();
    this.thinkingProxy = undefined;
    this.thinkingProxyPromise = undefined;
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
          // light up the thinking indicator as soon as it appears. A
          // "redacted_thinking" block (the model's own safety-triggered
          // redaction, distinct from -p mode's blanket text suppression)
          // arrives as an already-opaque blob with no deltas at all — it
          // still deserves the same start/end indicator so the user sees
          // Claude reasoned, not that it silently skipped ahead.
          if (e.content_block.type === "thinking" || e.content_block.type === "redacted_thinking") state.startThinking();
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
        // "signature_delta" (the thinking block's trailing cryptographic
        // signature, needed only to replay the block back verbatim on a
        // later turn) carries nothing user-facing — intentionally a no-op.
        break;
      }
      case "content_block_stop": {
        const type = typeof e.index === "number" ? state.blockTypes.get(e.index) : undefined;
        if (type === "thinking" || type === "redacted_thinking") state.endThinking();
        break;
      }
    }
  }

  private buildArgs(
    sessionId: string,
    firstTurn: boolean,
    systemPrompt: string,
    thinkingOverride: string | undefined,
    native = false,
  ): string[] {
    const grant = buildClaudeToolGrant(this.agent.tools);
    // Configured MCP servers ride in as an inline --mcp-config JSON (safe-mode
    // already keeps the user's own MCP config out); `mcp__<name>` approves the
    // server's tools in -p mode, where unapproved calls are silently denied.
    const mcpServers = resolveMcpServers(this.workspace.config, this.agent);
    const mcpAllowed = Object.keys(mcpServers).map((name) => `mcp__${name}`);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      // Isolation: normal turns use --safe-mode (no user CLAUDE.md/skills/hooks/
      // commands). A native command NEEDS the skill/slash-command surface that
      // --safe-mode kills, so it isolates a different way — no user setting
      // sources + only gaia's --mcp-config — which keeps built-in skills
      // (/deep-research …) resolving while still dropping the user's own config.
      ...(native ? ["--setting-sources", "", "--strict-mcp-config"] : [SAFE_MODE]),
      "--system-prompt",
      systemPrompt,
      // Single comma-joined token: --tools/--allowedTools are variadic, so a
      // joined value keeps them from swallowing later flags. Tool/pattern names
      // contain no commas. "" disables all tools when the agent has none.
      // A skill fans out across the built-in toolset (ToolSearch, Task, …), so a
      // native turn exposes them all ("default") and still gates EXECUTION on the
      // agent's own allow grant below — exposed-but-unapproved calls are denied.
      "--tools",
      native ? "default" : grant.tools.join(","),
      // The harness's own fan-out tools are suppressed on EVERY turn (normal
      // turns never expose them via --tools, but a native turn's "default"
      // toolset would): all fan-out goes through `gaia summon`. Declared as
      // capability data (fanOutTools), applied by this harness's own runtime.
      ...(this.capabilities.fanOutTools.length > 0 ? ["--disallowedTools", this.capabilities.fanOutTools.join(",")] : []),
    ];
    if (mcpAllowed.length > 0) {
      args.push("--mcp-config", JSON.stringify({ mcpServers }));
    }
    // ToolSearch (the read-only "load more tool schemas" step every skill relies
    // on) is auto-approved for native turns so a skill can reach its toolset; all
    // other tools stay gated by the agent's configured grant (grant web/read/…
    // to let a skill actually search/read).
    const allowed = native ? [...grant.allowedTools, "ToolSearch"] : grant.allowedTools;
    if (allowed.length > 0 || mcpAllowed.length > 0) {
      args.push("--allowedTools", [...allowed, ...mcpAllowed].join(","));
    }
    // Posture knob as data: plan/acceptEdits/etc. live in the agent config, not
    // a hardcoded branch. Default (unset) leaves Claude's default behavior.
    if (this.agent.permissionMode) {
      args.push("--permission-mode", this.agent.permissionMode);
    }
    args.push(firstTurn ? "--session-id" : "--resume", sessionId);
    const model = this.agent.model?.name;
    if (model) args.push("--model", claudeModelArg(model));
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

  // Start (once) the loopback shim that un-redacts extended-thinking text. Newer
  // Claude models redact reasoning text by default (thinking.display:"omitted"),
  // so this is ALWAYS on — reasoning is visible for every agent, no opt-in (the
  // pi/codex harnesses already stream reasoning natively; this is Claude pulling
  // even). Fails open: on any start error we return undefined and the turn runs
  // straight to Anthropic (no thinking text, but unbroken). The upstream is
  // whatever ANTHROPIC_BASE_URL would otherwise be — the credential proxy when
  // it's on, else Anthropic direct — so this composes with that path.
  private async ensureThinkingProxy(): Promise<ThinkingProxyHandle | undefined> {
    if (this.thinkingProxy) return this.thinkingProxy;
    if (!this.thinkingProxyPromise) {
      const upstream = process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
      this.thinkingProxyPromise = startThinkingProxy(upstream).catch(() => undefined);
    }
    this.thinkingProxy = await this.thinkingProxyPromise;
    return this.thinkingProxy;
  }

  // Per-turn env for the subprocess. The uniform gaia-CLI bridge env
  // (GAIA_MEMORY_DIR/GAIA_ROOM_*/GAIA_AGENT_ID/GAIA_DAEMON_*) is composed ONCE
  // by RunnerHost.buildEnv and inherited here via process.env — this runtime
  // lives in the per-(room, agent) runner it spawned. Only genuinely
  // claude-local wiring is added on top.
  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Prepend our `gaia` shim so plain `gaia <cmd>` runs THIS daemon's CLI.
    const shimDir = ensureGaiaShimDir();
    if (shimDir) env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
    // Route Claude Code's Anthropic egress through the thinking shim when up (it
    // forwarded the prior ANTHROPIC_BASE_URL as its own upstream at start time).
    if (this.thinkingProxy) env.ANTHROPIC_BASE_URL = this.thinkingProxy.url;
    // Per-agent env from agent.json (cost knobs like CLAUDE_CODE_MAX_CONTEXT_TOKENS).
    if (this.agent.env) Object.assign(env, this.agent.env);
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

// ---------------------------------------------------------------------------
// Native command discovery (the enable-able passthrough set)
// ---------------------------------------------------------------------------
//
// This list is both the composer's `/`-autocomplete AND the set a command can
// be CHECKED into skills[] from: a fileless entry here (no on-disk SKILL.md) is
// what routes as native passthrough. A command absent here can't be enabled, so
// keep the seed current. DISCOVERED, not fixed: on-disk skills/commands are
// enumerated, and a small seed names the useful skills that ship INSIDE the
// claude binary. Memoized — claude-local knowledge the shared layer only reads
// as NativeCommandDef data.

// Skills shipped in the claude binary (not discoverable on disk). Keep current:
// a builtin missing here can't be enabled as a native command.
const CLAUDE_BUILTIN_COMMANDS: NativeCommandDef[] = [
  { name: "deep-research", description: "fan-out web research → a cited, fact-checked report" },
  { name: "code-review", description: "review the current diff for bugs and cleanups" },
  { name: "security-review", description: "security review of the pending changes" },
  { name: "review", description: "review a GitHub pull request" },
  { name: "run", description: "launch and drive this project's app to see a change working" },
  { name: "verify", description: "exercise a change end-to-end and observe behavior" },
  { name: "init", description: "initialize a CLAUDE.md with codebase documentation" },
];

/** SKILL.md descriptions can run long; trim to one short autocomplete line. */
function commandDescription(raw: string | undefined): string {
  const text = raw?.trim() ?? "";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

let claudeCommandsCache: NativeCommandDef[] | undefined;
function discoverClaudeCommands(): NativeCommandDef[] {
  if (claudeCommandsCache) return claudeCommandsCache;
  const byName = new Map<string, NativeCommandDef>();
  // Built-in seed first; discovered on-disk skills override with real
  // descriptions. Discovery + frontmatter parsing is the domain scanner
  // (skills.ts scanSkillRoot) — the same parser the settings skill picker
  // uses, so quote-stripping and `name:` handling can never drift; only the
  // root path is claude-local knowledge.
  const discovered = scanSkillRoot(join(homedir(), ".claude", "skills"), "claude").map((skill) => ({
    name: skill.name,
    description: commandDescription(skill.description) || "harness skill",
  }));
  for (const cmd of [...CLAUDE_BUILTIN_COMMANDS, ...discovered]) {
    byName.set(cmd.name, cmd);
  }
  claudeCommandsCache = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return claudeCommandsCache;
}

// ---------------------------------------------------------------------------
// Account usage probe — the same session/weekly caps Claude Code's `/usage`
// renders. The subscription figures are NOT in the -p stream (that carries only
// per-turn tokens), so we read the OAuth token Claude Code stored (macOS
// keychain, else ~/.claude/.credentials.json) and hand it to the shared
// Anthropic usage client. Only the CREDENTIAL READING is claude-specific and
// lives here; provider knowledge is harness/usage.ts, and the daemon only sees
// a normalized UsageProbeResult (RULE #0). Credential-read outcomes are
// tri-state on purpose: `missing` (signed out / API-key auth — authoritatively
// nothing to show) vs `transient` (a LOCKED keychain, an exec timeout, a torn
// file — the login almost certainly still exists, so the meter must NOT be
// cleared; report `error` and let the UsageService keep the last-known value
// or fall through to another harness's copy of the same Anthropic account).

const execFileAsync = promisify(execFile);

interface ClaudeOauth {
  accessToken?: string;
  subscriptionType?: string;
}

type OauthRead = { status: "ok"; oauth: ClaudeOauth } | { status: "missing" } | { status: "transient" };

/** Read the Claude Code OAuth blob from wherever the CLI persisted it: the macOS
 * login keychain first (its default on darwin), then the plaintext credentials
 * file (Linux / older installs). `missing` ONLY when every store authoritatively
 * has no entry — any read that failed for an ambient reason makes the combined
 * answer `transient`, because "I couldn't look" must never render as "signed out". */
async function readClaudeOauth(): Promise<OauthRead> {
  const parse = (raw: string): ClaudeOauth | undefined => {
    try {
      const outer = JSON.parse(raw) as { claudeAiOauth?: ClaudeOauth } & ClaudeOauth;
      const oauth = outer.claudeAiOauth ?? outer;
      return typeof oauth?.accessToken === "string" ? oauth : undefined;
    } catch {
      return undefined;
    }
  };
  let sawTransient = false;
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        timeout: USAGE_TIMEOUT_MS,
      });
      const oauth = parse(stdout.trim());
      if (oauth) return { status: "ok", oauth };
      sawTransient = true; // entry exists but didn't parse — torn write, not signed-out.
    } catch (err) {
      // `security` exits 44 ("could not be found") when the item is absent —
      // that alone is authoritative. Anything else (LOCKED keychain, denied
      // access, timeout) is ambient: note it and still try the file.
      const absent = (err as { code?: number | string }).code === 44 || /could not be found/i.test(String((err as Error).message ?? ""));
      if (!absent) sawTransient = true;
    }
  }
  try {
    const oauth = parse(readFileSync(realClaudeCredentials(), "utf8"));
    if (oauth) return { status: "ok", oauth };
    sawTransient = true; // file exists but didn't parse — torn write, not signed-out.
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") sawTransient = true;
  }
  return sawTransient ? { status: "transient" } : { status: "missing" };
}

async function probeClaudeUsage(): Promise<UsageProbeResult> {
  const read = await readClaudeOauth();
  if (read.status === "transient") return { status: "error" }; // couldn't look ≠ signed out — keep the last-known meter.
  if (read.status === "missing" || !read.oauth.accessToken) return { status: "none" }; // API-key auth or signed out — no caps to show.
  return fetchAnthropicUsage(read.oauth.accessToken, read.oauth.subscriptionType);
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
    modelNameOptions: ["fable", "opus", "sonnet", "haiku"],
    // Claude Code's own --permission-mode vocabulary, passed verbatim.
    permissionModes: ["default", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"],
  },
  create: (ctx) => new ClaudeRuntime(ctx),
  contextWindow: (model) => claudeContextWindow(model),
  nativeCommands: () => discoverClaudeCommands(),
  // A deep transcript cursor is only honest while this handle survives: the
  // session must have been ESTABLISHED (started) — a generated-but-never-run
  // id resumes nothing. load() also honors the legacy bare-harness key.
  hasDurableSession: (rootDir, roomId, agentId) =>
    fileSessionStore<ClaudeRoomMeta>(rootDir, "claude", agentId).load(roomId)?.started === true,
  // Claude Code routes its API calls through ANTHROPIC_BASE_URL bearing
  // ANTHROPIC_AUTH_TOKEN. Point both at the loopback proxy + per-turn token; the
  // daemon swaps in the real anthropic key. Subscription/OAuth logins have no key
  // to hide, so the proxy resolver fail-closes for them (correct, not special-cased).
  credentialProxy: ({ proxyUrl, token }) => ({
    env: { ANTHROPIC_BASE_URL: proxyUrl, ANTHROPIC_AUTH_TOKEN: token },
    denyRead: [realClaudeCredentials()],
  }),
  // Claude Code persists its sessions + state under ~/.claude (a sandboxed
  // turn must write there to stay resumable); its stored credential file is
  // carved back to read-only inside that tree.
  sandboxPaths: { writable: ["~/.claude"], readonly: ["~/.claude/.credentials.json"] },
  usageAccounts: () => [{ account: ANTHROPIC_USAGE_ACCOUNT, probe: probeClaudeUsage }],
});
