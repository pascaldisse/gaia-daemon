// Daemon-side AgentRuntime that runs a harness in a per-(room, agent) subprocess
// (the agent-runner, harness/runner.ts). The daemon launches this the SAME way
// for every harness — Pi included — so the execution model is uniform and the
// sandbox has exactly one process to wrap. It speaks the runner protocol over
// the child's stdio and re-exposes the stream as the normal AgentEvent iterable
// the turn engine consumes, so nothing upstream knows a turn ran in a
// subprocess. v1's runner-host.ts + runtime-factory.ts, folded into one module.

import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "../core/env.js";
import { workspacePaths } from "../core/paths.js";
import { NO_SESSION_TO_COMPACT, type AgentDef, type AgentEvent, type CompactProgressUpdate, type CompactResult, type MessageAttachment, type Workspace } from "../core/types.js";
import type { MemoryStore } from "../domain/memory.js";
import { CircuitBreaker, defaultBreaker } from "./breaker.js";
import { createEventChannel, type EventChannel } from "./events.js";
import { configuredModelLabel, liveModelLabel } from "./model-label.js";
import { selfRelaunchArgv, spawnLineReader } from "./proc.js";
import { encodeFrame, parseRunnerMessage, RUNNER_ENV, type RunnerCommand, type RunnerMessage } from "./protocol.js";
import { installMarkerArgs } from "./reaper.js";
// Side-effect imports: the backends resolveSandboxLaunch picks from.
import "./sandbox/none.js";
import "./sandbox/seatbelt.js";
import { resolveSandboxLaunch, type SandboxPolicy } from "./sandbox/spec.js";
import {
  type AgentInput,
  type AgentRuntime,
  type CredentialProxyWiring,
  type HarnessCapabilities,
  type HarnessHost,
  harnessIdFor,
  harnessSpecFor,
} from "./spec.js";

// --- provider key stripping (the credential proxy's other half) -------------------

// The env vars harnesses read as a provider API key. When the credential proxy
// is on, the daemon strips ALL of these from the sandboxed child's env:
// otherwise a harness can fall back to the real key in the env — bypassing the
// proxy AND leaving the raw key in the sandbox, the exact leak the proxy closes.
// Mirrors pi-ai's env-api-keys.ts provider→var map. Deliberately EXCLUDES the
// general-purpose git tokens GH_TOKEN / GITHUB_TOKEN (they also drive `git push`
// inside a turn; stripping them breaks legitimate git use for no proxy benefit).
export const PROVIDER_KEY_ENV_VARS: readonly string[] = [
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "CLOUDFLARE_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
];

/** Delete every known LLM provider key from an env object, in place. Returns it
 *  for chaining. The proxy supplies the one key the turn needs over the wire. */
export function stripProviderKeys(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of PROVIDER_KEY_ENV_VARS) delete environment[name];
  return environment;
}

/** Expand the `~` shorthand HarnessSpec.sandboxPaths declares in (a spec is
 *  static data — it can't know the home dir) to the real home dir. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

// --- the host ---------------------------------------------------------------------

/** IDLE backstop for a native compaction pass (see compact() — re-armed on each
 * progress frame). This is NOT a normal turn — the harness re-summarizes the
 * WHOLE session in one LLM call, so a large context (a long-lived or imported
 * room) legitimately runs for many minutes with no output until the summary
 * streams at the end. The old 180s absolute bound had almost no margin — a
 * measured 295k-token pass already took 161s — so the next larger/slower session
 * (a near-full 1M-context room extrapolates to ~9 min) tripped it while still
 * healthy. As an idle window this only fires when the runner goes fully silent
 * (wedged), and 15 min covers even a silent full-context prefill. */
const COMPACT_TIMEOUT_MS = 900_000;

/** How long abort() waits for the runner to confirm the turn ended before
 * escalating to SIGKILL. A cooperative abort (harness kills its child, stream
 * errors, runner reports turn-error) lands well under a second; a runner that
 * stays silent past this window is wedged — its turnActive flag would bounce
 * every future message with "runner busy" (the ghost turn-lock). */
const ABORT_GRACE_MS = 5_000;
/** After SIGKILL: how long to wait for the exit handler to settle the turn. */
const ABORT_KILL_WAIT_MS = 2_000;

export interface RunnerHostOptions {
  workspace: Workspace;
  agent: AgentDef;
  harness: string;
  /** This runner's room is incognito — the runner strips the memory/recall tools
   * from the agent it loads (see RUNNER_ENV.incognito). */
  incognito?: boolean;
  /** Bridge factory; the turn token is minted at spawn with the resolved allowSummon. */
  harnessHost?: (options: { allowSummon: boolean }) => HarnessHost;
  /** Resolved lazily at spawn: may this turn's token create summons? */
  allowSummon: () => boolean;
  /** Resolved lazily at spawn, so the caller can read room state (summon?) first. */
  sandbox: () => SandboxPolicy;
  /** Where the child RUNS (OS cwd + sandbox cwd): the room's isolated git
   * worktree when collab stamped one (RoomState.workDir), else the workspace
   * root. Lazy like sandbox — read from room state at spawn. This moves ONLY
   * the working directory: `.gaia/` stays addressed via RUNNER_ENV
   * workspacePath/roomDir (absolute, root-anchored), so state/transcript/
   * memory never follow the checkout. */
  workDir?: () => string | undefined;
  /** Test seam: override the argv launched (default is `gaia __run-agent`). */
  runnerArgv?: string[];
  /** Launch breaker keyed by target; defaults to the daemon-wide shared one. */
  breaker?: CircuitBreaker;
}

export class RunnerHost implements AgentRuntime {
  readonly agent: AgentDef;
  readonly capabilities: HarnessCapabilities;
  private readonly options: RunnerHostOptions;
  private child: ChildProcess | null = null;
  private spawnPromise: Promise<void> | null = null;
  /** Rooms whose harness session must be forgotten on the next turn. A reset
   * (edit/retry/rewind/clear) is meaningless to a down runner, but the session
   * is PERSISTED ON DISK — so a reset dropped while the runner idle-exited would
   * let the next turn --resume the ghost conversation (the edit/retry-doesn't-
   * -rewind bug). We queue every reset and re-deliver it right after the next
   * spawn, before the turn; reset is idempotent, so a redundant delivery no-ops. */
  private readonly pendingResets = new Set<string>();
  private activeChannel: EventChannel | null = null;
  private _modelLabel: string;
  private disposed = false;
  // Launch breaker, keyed by target so a down provider/harness fast-fails for
  // every room, not just the one that tripped it. Per-spawn handshake flags: a
  // launch counts as success once the child reports `ready`, failure if it dies
  // (or the sandbox fail-closes) before that — reported exactly once per attempt.
  private readonly breaker: CircuitBreaker;
  private readonly breakerKey: string;
  private childReady = false;
  private launchSettled = false;
  /** True from writing a `turn` frame until the runner confirms it ended
   * (turn-end / turn-error) or the child dies. This is the RUNNER's notion of
   * busy — the daemon-side channel can close earlier (consumer break), and that
   * disagreement is exactly what abort() must resolve. */
  private turnInFlight = false;
  /** Resolvers waiting for the runner to go idle (see abort()). */
  private turnIdleWaiters: Array<() => void> = [];
  /** Resolver for the single in-flight /steer round trip. */
  private steerWaiter: ((ok: boolean) => void) | undefined;
  /** Resolver for the single in-flight /compact round trip. */
  private compactWaiter: ((result: { ok: boolean; compacted: boolean; message: string; summary?: string }) => void) | undefined;
  /** Forwards the runner's compact-progress frames to the /compact caller (and
   * re-arms the idle backstop) while a pass runs. */
  private compactProgress: ((update: CompactProgressUpdate) => void) | undefined;

  constructor(options: RunnerHostOptions) {
    this.options = options;
    this.agent = options.agent;
    this.capabilities = harnessSpecFor(options.harness).capabilities;
    this._modelLabel = configuredModelLabel(options.agent.model, "default");
    this.breaker = options.breaker ?? defaultBreaker;
    this.breakerKey = `${options.harness}:${configuredModelLabel(options.agent.model, "default")}`;
  }

  get modelLabel(): string {
    return this._modelLabel;
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    await this.ensureChild(input.roomId);
    // Deliver any reset queued while the child was down (or racing a child death)
    // BEFORE the turn, so a fresh runtime forgets the persisted session and this
    // turn starts a genuinely new harness conversation instead of --resuming the
    // rewound-away ghost. Must precede the `turn` frame — order is honored by the
    // runner's line reader.
    if (this.pendingResets.delete(input.roomId)) this.write({ type: "reset", roomId: input.roomId });
    const channel = createEventChannel();
    this.activeChannel = channel;
    this.turnInFlight = true;
    this.write({ type: "turn", input });
    try {
      for await (const event of channel.stream()) yield event;
    } finally {
      this.activeChannel = null;
    }
  }

  /** The runner confirmed the turn is over (turn-end/turn-error/child death):
   * release everyone waiting in abort(). */
  private settleTurn(): void {
    this.turnInFlight = false;
    for (const waiter of this.turnIdleWaiters.splice(0)) waiter();
  }

  /** Resolves true when the runner goes idle within `ms`, false on timeout. */
  private waitTurnIdle(ms: number): Promise<boolean> {
    if (!this.turnInFlight) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.turnIdleWaiters = this.turnIdleWaiters.filter((candidate) => candidate !== waiter);
        resolve(false);
      }, ms);
      timer.unref?.();
      this.turnIdleWaiters.push(waiter);
    });
  }

  /** AUTHORITATIVE stop: when this resolves, the runner is idle or dead —
   * never "busy". Cooperative first (the abort frame lets the harness kill its
   * own child and keep its session record); a runner that stays silent past
   * the grace window is wedged, and a wedged runner is worse than a dead one —
   * its stuck turnActive flag bounces every future message with "runner busy".
   * Sessions are durable on disk, so kill + respawn loses nothing. */
  async abort(): Promise<void> {
    this.write({ type: "abort" });
    if (!this.turnInFlight) return;
    if (await this.waitTurnIdle(ABORT_GRACE_MS)) return;
    process.stderr.write(`[runner ${this.agent.id}] abort not confirmed after ${ABORT_GRACE_MS}ms — killing wedged runner\n`);
    this.child?.kill("SIGKILL");
    await this.waitTurnIdle(ABORT_KILL_WAIT_MS);
    // Even if the exit event is somehow delayed, the lock must not outlive an
    // authoritative abort — the child is gone (or unspawned) either way.
    this.settleTurn();
  }

  /** Forward /steer to the runner; resolves with the harness's answer (false
   * when no child, no support, or no reply within the timeout). */
  async steer(roomId: string, message: string, attachments?: MessageAttachment[]): Promise<boolean> {
    if (!this.child || !this.capabilities.supportsSteer) return false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.steerWaiter = undefined;
        resolve(false);
      }, 5_000);
      timer.unref?.();
      this.steerWaiter = (ok) => {
        clearTimeout(timer);
        this.steerWaiter = undefined;
        resolve(ok);
      };
      this.write({ type: "steer", roomId, message, ...(attachments?.length ? { attachments } : {}) });
    });
  }

  /** Push a daemon-synthesized event into the ACTIVE turn's stream at its
   * current position (see AgentRuntime.injectEvent). The channel is the same
   * queue runner events land in, so ordering against the live stream is exact
   * by construction. No-op (false) when no turn is streaming or it already
   * closed — the caller's marker is simply skipped. */
  injectEvent(event: AgentEvent): boolean {
    const channel = this.activeChannel;
    if (!channel || channel.closed) return false;
    channel.push(event);
    return true;
  }

  /** Forward /compact to the runner, relay the harness's own result line, and
   * stream its progress frames to `onProgress`. */
  async compact(roomId: string, onProgress?: (update: CompactProgressUpdate) => void): Promise<CompactResult> {
    if (!this.capabilities.supportsCompact) throw new Error("this harness has no native compaction");
    // A durable session on disk can be compacted even from a cold daemon (no
    // turn since restart): spawn the runner so its harness resumes the persisted
    // handle. Only when there's neither a live child NOR a durable session is
    // there genuinely nothing to compact. hasDurableSession reads the spec's
    // on-disk descriptor — uniform across harnesses, no id branch.
    if (!this.child && !this.hasDurableSession(roomId)) return NO_SESSION_TO_COMPACT;
    await this.ensureChild(roomId);
    return new Promise<CompactResult>((resolve, reject) => {
      // IDLE backstop, not absolute: every progress frame re-arms it, so a pass
      // actively streaming for many minutes never trips it, while a runner that
      // goes silent (wedged) still fails COMPACT_TIMEOUT_MS after its last sign
      // of life. Harnesses that report no progress fall back to a plain
      // from-start bound — same as before, just larger.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(timer);
        this.compactWaiter = undefined;
        this.compactProgress = undefined;
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish();
          // Abort the runner's pass before giving up — otherwise the harness
          // process keeps going and compacts the session AFTER we reported
          // failure (exactly the "compacted anyway" ghost the 180s era left).
          this.write({ type: "abort" });
          reject(new Error(`compaction stalled — no progress for ${Math.round(COMPACT_TIMEOUT_MS / 1000)}s`));
        }, COMPACT_TIMEOUT_MS);
        timer.unref?.();
      };
      arm();
      this.compactProgress = (update) => {
        arm();
        onProgress?.(update);
      };
      this.compactWaiter = (result) => {
        finish();
        // `ok` = ran without error → resolve (rejection is reserved for real
        // failures). `compacted` carries whether history was actually evicted —
        // the daemon draws the boundary from it, never from the message wording.
        if (result.ok) resolve({ compacted: result.compacted, message: result.message, ...(result.summary ? { summary: result.summary } : {}) });
        else reject(new Error(result.message || "compaction failed"));
      };
      this.write({ type: "compact", roomId });
    });
  }

  resetRoom(roomId: string): void {
    // Queue unconditionally so the reset survives a down runner (the disk-
    // persisted session would otherwise --resume the ghost). Also send now if the
    // child is up; the next turn's flush deletes the queue entry. A double
    // delivery is a harmless no-op (reset just clears an already-cleared session).
    this.pendingResets.add(roomId);
    if (this.child) this.write({ type: "reset", roomId });
  }

  /** Answered daemon-side from the spec's on-disk descriptor — the runner may
   * not even be spawned yet, and a fresh process is exactly the case that
   * matters (its cursor is only honest if the persisted handle survived). */
  hasDurableSession(roomId: string): boolean {
    const spec = harnessSpecFor(this.options.harness);
    return spec.hasDurableSession?.(this.options.workspace.rootDir, roomId, this.agent.id) ?? true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.child) {
      this.write({ type: "dispose" });
      this.child.kill();
      this.child = null;
    }
  }

  private write(command: RunnerCommand): void {
    try {
      this.child?.stdin?.write(`${encodeFrame(command)}\n`);
    } catch {
      // child already gone; the exit handler fails the active turn.
    }
  }

  private async ensureChild(roomId: string): Promise<void> {
    if (this.child) return;
    if (!this.spawnPromise) {
      // Fast-fail while the breaker is open: after repeated launch failures a
      // turn surfaces a clear "retry in Ns" instead of re-spawning every time.
      const gate = this.breaker.canAttempt(this.breakerKey);
      if (!gate.allowed) {
        throw new Error(
          `Launch circuit open for ${this.breakerKey} after repeated failures; retry in ${Math.ceil((gate.retryInMs ?? 0) / 1000)}s.`,
        );
      }
      // Clear the promise on failure (e.g. a fail-closed sandbox) so a later
      // turn can retry rather than wedging on a one-time spawn error.
      this.spawnPromise = this.spawnChild(roomId).catch((error) => {
        this.spawnPromise = null;
        throw error;
      });
    }
    await this.spawnPromise;
  }

  // A launch is settled exactly once per spawn — on the first `ready` (success)
  // or the first death-before-ready / fail-closed sandbox (failure) — so the
  // breaker never double-counts a single attempt.
  private settleLaunch(outcome: "success" | "failure"): void {
    if (this.launchSettled) return;
    this.launchSettled = true;
    if (outcome === "success") this.breaker.onSuccess(this.breakerKey);
    else this.breaker.onFailure(this.breakerKey);
  }

  private async spawnChild(roomId: string): Promise<void> {
    this.childReady = false;
    this.launchSettled = false;
    // The install marker lets a later daemon's boot sweep find this child if we
    // crash and leave it orphaned (see reaper.ts). The runner ignores the flag;
    // it is a pure, ps-visible label scoped to this checkout.
    const base = this.options.runnerArgv ?? [...selfRelaunchArgv(), "__run-agent"];
    const argv = [...base, ...installMarkerArgs()];
    // The workspace (cwd) is writable, but the governance that launches the
    // next turn is carved back to read-only: the workspace policy files AND
    // this agent's own global agent.json (the authoritative trust bit) — the
    // backend applies these carves AFTER every writable grant (last match
    // wins), so no config-supplied grant can expose them. Room scratch lives
    // under cwd, so it needs no extra grant.
    const policy = this.options.sandbox();
    // Resolve the bridge token + this harness's credential-proxy wiring ONCE, then
    // use it for both the sandbox deny-read and the child env. The wiring is data
    // the harness declares on its spec; applied uniformly with no branch on the
    // harness id (AGENTS.md §RULE #0). denyRead carries any cred store the harness
    // wants hidden so a summon can't exfiltrate the key the proxy is replacing.
    const launchCtx = this.resolveProxyLaunch(roomId, policy);
    // This harness's declared home-dir carves (state dir writable, credential
    // store read-only inside it) — HarnessSpec.sandboxPaths, data on the spec,
    // threaded here with zero knowledge of which harness declared it.
    const sandboxPaths = harnessSpecFor(this.options.harness).sandboxPaths;
    // The child's working directory: the room's git worktree when collab
    // isolation stamped one, else the workspace root — identical for the OS
    // spawn and the sandbox profile (the sandbox's writable cwd IS where the
    // agent works). With a worktree cwd, the room's scratch under the root's
    // .gaia/rooms/<id> is no longer inside cwd, so it gets its writable grant
    // explicitly; the governance carves below still win (applied last).
    const workDir = this.options.workDir?.() ?? this.options.workspace.rootDir;
    let launch;
    try {
      launch = await resolveSandboxLaunch(policy, argv, workDir, {
        writable: [
          ...(sandboxPaths?.writable ?? []).map(expandHome),
          ...(workDir !== this.options.workspace.rootDir ? [workspacePaths.roomDir(this.options.workspace.rootDir, roomId)] : []),
        ],
        readonly: [
          this.options.workspace.configPath,
          this.options.workspace.agentsOverrideDir,
          this.agent.configPath,
          ...(sandboxPaths?.readonly ?? []).map(expandHome),
        ],
        denyRead: launchCtx.proxy?.denyRead,
      });
    } catch (error) {
      // Fail-closed sandbox (e.g. off darwin) is a launch failure for the breaker.
      this.settleLaunch("failure");
      throw error;
    }
    if (env("GAIA_DEBUG_SANDBOX")) {
      process.stderr.write(
        `[sandbox ${this.agent.id}] enabled=${policy.enabled} backend=${policy.backend} proxy=${Boolean(launchCtx.proxy)} launch=${launch.command}\n`,
      );
    }

    const handle = spawnLineReader({
      command: launch.command,
      args: launch.args,
      cwd: workDir,
      env: this.buildEnv(roomId, launchCtx),
      onLine: (line) => this.onMessage(line),
    });
    const child = handle.proc;
    this.child = child;

    child.stderr?.on("data", (chunk: string) => process.stderr.write(`[runner ${this.agent.id}] ${chunk}`));
    child.on("error", (error) => {
      // e.g. ENOENT on the runner binary — a launch failure until proven ready.
      this.settleLaunch("failure");
      this.failActive(error);
    });
    child.on("exit", (code, signal) => {
      handle.rl.close();
      this.child = null;
      this.spawnPromise = null;
      // Dying before the first `ready` is a launch failure (crash-on-start);
      // after that, an exit is a normal teardown and the breaker stays closed.
      if (!this.childReady) this.settleLaunch("failure");
      if (this.activeChannel && !this.disposed) {
        this.failActive(new Error(`agent runner exited (${signal ? `signal ${signal}` : `code ${code}`}).`));
      }
      // A death mid-request must settle any pending single-shot waiter too, or a
      // /compact (or /steer) that spawned the runner would hang until its timeout.
      if (this.compactWaiter && !this.disposed) {
        this.compactWaiter({ ok: false, compacted: false, message: `agent runner exited during compaction (${signal ? `signal ${signal}` : `code ${code}`}).` });
      }
      if (this.steerWaiter && !this.disposed) this.steerWaiter(false);
      // A dead child can hold no turn — release abort()/idle waiters.
      this.settleTurn();
    });
  }

  private onMessage(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const message: RunnerMessage | undefined = parseRunnerMessage(raw);
    if (!message) return;
    switch (message.type) {
      case "ready":
        // The child is up and the harness initialized — a clean launch.
        this.childReady = true;
        this.settleLaunch("success");
        this._modelLabel = message.modelLabel;
        return;
      case "model-label":
        this._modelLabel = message.modelLabel;
        return;
      case "event":
        if (message.event.type === "model-info") {
          this._modelLabel = liveModelLabel(message.event.provider, message.event.modelId, message.event.subscription);
        }
        this.activeChannel?.push(message.event);
        return;
      case "turn-end":
        this.activeChannel?.close();
        this.settleTurn();
        return;
      case "turn-error":
        this.activeChannel?.fail(new Error(message.message));
        this.activeChannel?.close();
        this.settleTurn();
        return;
      case "steer-result":
        this.steerWaiter?.(message.ok);
        return;
      case "compact-progress": {
        const { type: _t, ...update } = message;
        this.compactProgress?.(update);
        return;
      }
      case "compact-result":
        this.compactWaiter?.({ ok: message.ok, compacted: message.compacted, message: message.message, ...(message.summary ? { summary: message.summary } : {}) });
        return;
    }
  }

  private failActive(error: unknown): void {
    this.activeChannel?.fail(error);
    this.activeChannel?.close();
  }

  // Resolve the daemon bridge + per-turn token + this harness's credential-proxy
  // wiring in one place. The wiring is whatever the harness declared on its spec —
  // RunnerHost applies it uniformly and never asks which harness it is.
  private resolveProxyLaunch(roomId: string, policy: SandboxPolicy): ProxyLaunch {
    const host = this.options.harnessHost?.({ allowSummon: this.options.allowSummon() });
    if (!host) return { host: undefined, token: undefined, proxy: undefined };
    const token = host.mintToken({ agentId: this.agent.id, roomId });
    const proxy =
      policy.credentialProxy === true
        ? harnessSpecFor(this.options.harness).credentialProxy?.({
            proxyUrl: host.llmProxyUrl,
            token,
            scratchDir: this.ensureProxyScratch(roomId),
          })
        : undefined;
    return { host, token, proxy };
  }

  private buildEnv(roomId: string, ctx: ProxyLaunch): NodeJS.ProcessEnv {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [RUNNER_ENV.workspacePath]: this.options.workspace.rootDir,
      [RUNNER_ENV.agentId]: this.agent.id,
      [RUNNER_ENV.harness]: this.options.harness,
      [RUNNER_ENV.roomId]: roomId,
      [RUNNER_ENV.memoryDir]: this.agent.memoryDir,
      [RUNNER_ENV.roomDir]: workspacePaths.roomDir(this.options.workspace.rootDir, roomId),
      [RUNNER_ENV.agentIdPublic]: this.agent.id,
      ...(this.options.incognito ? { [RUNNER_ENV.incognito]: "1" } : {}),
    };
    if (ctx.host && ctx.token !== undefined) {
      childEnv[RUNNER_ENV.daemonUrl] = ctx.host.baseUrl;
      childEnv[RUNNER_ENV.daemonToken] = ctx.token;
      if (ctx.proxy) {
        // Route this harness's LLM egress through the loopback proxy (bearing the
        // per-turn token). Order matters: strip every real provider key FIRST (else
        // a harness could fall back to the real key in the env, bypassing the proxy
        // and leaving the key in the sandbox), THEN apply the harness's declared
        // wiring — which may legitimately set the token UNDER a provider-key name
        // (e.g. codex's OPENAI_API_KEY=<token>). Uniform for every harness.
        stripProviderKeys(childEnv);
        childEnv[RUNNER_ENV.llmProxyUrl] = ctx.host.llmProxyUrl;
        Object.assign(childEnv, ctx.proxy.env ?? {});
      }
    }
    return childEnv;
  }

  // Test seam: the full child env for a (room, policy), resolving the bridge token
  // + harness proxy wiring exactly as spawnChild does.
  private envFor(roomId: string, policy: SandboxPolicy): NodeJS.ProcessEnv {
    return this.buildEnv(roomId, this.resolveProxyLaunch(roomId, policy));
  }

  // A per-room writable scratch dir a proxied harness may relocate its cred store
  // into; it sits under the rooms dir, inside the writable cwd. Generic — the
  // harness's descriptor decides what (if anything) to write here.
  private ensureProxyScratch(roomId: string): string {
    const dir = workspacePaths.roomProxyScratch(this.options.workspace.rootDir, roomId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

interface ProxyLaunch {
  host: HarnessHost | undefined;
  token: string | undefined;
  proxy: CredentialProxyWiring | undefined;
}

// --- the factory (v1 runtime-factory.ts) -------------------------------------------

export interface CreateAgentRuntimeOptions {
  workspace: Workspace;
  agent: AgentDef;
  /** The room is incognito — memory/recall tools are stripped in the runner. */
  incognito?: boolean;
  /** Workspace-scoped store. The host itself never touches it (the runner
   * subprocess builds its bridge-backed store); accepted so every runtime
   * factory takes the same construction context. */
  memoryStore: MemoryStore;
  /**
   * Daemon bridge factory: minting the turn token is deferred to spawn (via
   * RunnerHost) so `allowSummon` can reflect room state the caller only knows
   * after init (is this room itself a summon?).
   */
  harnessHost?: (options: { allowSummon: boolean }) => HarnessHost;
  /** Resolved lazily at spawn: may this turn's token create summons? */
  allowSummon?: () => boolean;
  /** Resolved lazily at spawn so the caller can read room state (summon?) first. */
  sandbox?: () => SandboxPolicy;
  /** Lazy working directory for the child (RoomState.workDir — the room's git
   * worktree under collab isolation). Absent/undefined = the workspace root. */
  workDir?: () => string | undefined;
  /** Test seam: override the argv launched (default is `gaia __run-agent`). */
  runnerArgv?: string[];
  /** Launch breaker override (tests); defaults to the daemon-wide shared one. */
  breaker?: CircuitBreaker;
}

/**
 * The runtime the daemon hands the room service. Every harness — Pi included —
 * runs in a per-(room, agent) subprocess via RunnerHost, so the execution model
 * is uniform and the sandbox wraps one process. The runner builds the real
 * runtime (the harness spec's create()) and its bridge-backed memory/summon,
 * so those deps no longer cross this boundary.
 */
export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  return new RunnerHost({
    workspace: options.workspace,
    agent: options.agent,
    harness: harnessIdFor(options.agent, options.workspace),
    ...(options.incognito ? { incognito: true } : {}),
    harnessHost: options.harnessHost,
    allowSummon: options.allowSummon ?? (() => true),
    sandbox: options.sandbox ?? (() => ({ enabled: false, backend: "none" })),
    workDir: options.workDir,
    runnerArgv: options.runnerArgv,
    breaker: options.breaker,
  });
}
