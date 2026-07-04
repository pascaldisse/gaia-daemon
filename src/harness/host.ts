// Daemon-side AgentRuntime that runs a harness in a per-(room, agent) subprocess
// (the agent-runner, harness/runner.ts). The daemon launches this the SAME way
// for every harness — Pi included — so the execution model is uniform and the
// sandbox has exactly one process to wrap. It speaks the runner protocol over
// the child's stdio and re-exposes the stream as the normal AgentEvent iterable
// the turn engine consumes, so nothing upstream knows a turn ran in a
// subprocess. v1's runner-host.ts + runtime-factory.ts, folded into one module.

import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "../core/env.js";
import type { AgentDef, AgentEvent, Workspace } from "../core/types.js";
import type { MemoryStore } from "../domain/memory.js";
import { CircuitBreaker, defaultBreaker } from "./breaker.js";
import { createEventChannel, type EventChannel } from "./events.js";
import { configuredModelLabel, liveModelLabel } from "./model-label.js";
import { selfRelaunchArgv, spawnLineReader } from "./proc.js";
import { parseRunnerMessage, RUNNER_ENV, type RunnerCommand, type RunnerMessage } from "./protocol.js";
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

// --- the host ---------------------------------------------------------------------

export interface RunnerHostOptions {
  workspace: Workspace;
  agent: AgentDef;
  harness: string;
  /** Bridge factory; the turn token is minted at spawn with the resolved allowSummon. */
  harnessHost?: (options: { allowSummon: boolean }) => HarnessHost;
  /** Resolved lazily at spawn: may this turn's token create summons? */
  allowSummon: () => boolean;
  /** Resolved lazily at spawn, so the caller can read room state (summon?) first. */
  sandbox: () => SandboxPolicy;
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
  /** Resolver for the single in-flight /steer round trip. */
  private steerWaiter: ((ok: boolean) => void) | undefined;
  /** Resolver for the single in-flight /compact round trip. */
  private compactWaiter: ((result: { ok: boolean; message: string }) => void) | undefined;

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
    const channel = createEventChannel();
    this.activeChannel = channel;
    this.write({ type: "turn", input });
    try {
      for await (const event of channel.stream()) yield event;
    } finally {
      this.activeChannel = null;
    }
  }

  async abort(): Promise<void> {
    this.write({ type: "abort" });
  }

  /** Forward /steer to the runner; resolves with the harness's answer (false
   * when no child, no support, or no reply within the timeout). */
  async steer(roomId: string, message: string): Promise<boolean> {
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
      this.write({ type: "steer", roomId, message });
    });
  }

  /** Forward /compact to the runner and relay the harness's own result line.
   * Generous timeout: compaction is an LLM summarization pass. */
  async compact(roomId: string): Promise<string> {
    if (!this.capabilities.supportsCompact) throw new Error("this harness has no native compaction");
    if (!this.child) return "nothing to compact — no active session yet.";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.compactWaiter = undefined;
        reject(new Error("compaction timed out after 180s"));
      }, 180_000);
      timer.unref?.();
      this.compactWaiter = (result) => {
        clearTimeout(timer);
        this.compactWaiter = undefined;
        if (result.ok) resolve(result.message);
        else reject(new Error(result.message || "compaction failed"));
      };
      this.write({ type: "compact", roomId });
    });
  }

  resetRoom(roomId: string): void {
    if (this.child) this.write({ type: "reset", roomId });
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
      this.child?.stdin?.write(`${JSON.stringify(command)}\n`);
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
    // The workspace (cwd) is writable, but its policy files are carved back to
    // read-only so a confined turn can't rewrite the governance that launches
    // the next one. Room scratch lives under cwd, so it needs no extra grant.
    const policy = this.options.sandbox();
    // Resolve the bridge token + this harness's credential-proxy wiring ONCE, then
    // use it for both the sandbox deny-read and the child env. The wiring is data
    // the harness declares on its spec; applied uniformly with no branch on the
    // harness id (AGENTS.md §RULE #0). denyRead carries any cred store the harness
    // wants hidden so a summon can't exfiltrate the key the proxy is replacing.
    const launchCtx = this.resolveProxyLaunch(roomId, policy);
    let launch;
    try {
      launch = await resolveSandboxLaunch(policy, argv, this.options.workspace.rootDir, {
        readonly: [this.options.workspace.configPath, this.options.workspace.agentsOverrideDir],
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
      cwd: this.options.workspace.rootDir,
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
        return;
      case "turn-error":
        this.activeChannel?.fail(new Error(message.message));
        this.activeChannel?.close();
        return;
      case "steer-result":
        this.steerWaiter?.(message.ok);
        return;
      case "compact-result":
        this.compactWaiter?.({ ok: message.ok, message: message.message });
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
      [RUNNER_ENV.roomDir]: join(this.options.workspace.roomsDir, roomId),
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
    const dir = join(this.options.workspace.roomsDir, roomId, "proxy-scratch");
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
    harnessHost: options.harnessHost,
    allowSummon: options.allowSummon ?? (() => true),
    sandbox: options.sandbox ?? (() => ({ enabled: false, backend: "none" })),
    runnerArgv: options.runnerArgv,
    breaker: options.breaker,
  });
}
