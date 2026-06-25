// Daemon-side AgentRuntime that runs a harness in a per-(room, agent) subprocess
// (the agent-runner). The daemon launches this the SAME way for every harness —
// Pi included — so the execution model is uniform and the sandbox has exactly
// one process to wrap. It speaks the runner protocol over the child's stdio and
// re-exposes the stream as the normal AgentEvent iterable the controller
// consumes, so nothing upstream knows a turn ran in a subprocess.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { HarnessHost } from "../app/harness-bridge.js";
import { stripProviderKeys } from "../app/provider-key-env.js";
import type { AgentDefinition } from "../agents/types.js";
import type { Workspace } from "../workspace/types.js";
import type { HarnessCapabilities } from "./capabilities.js";
import { CircuitBreaker, defaultBreaker } from "./circuit-breaker.js";
import { createEventChannel, type EventChannel } from "./event-stream.js";
import { type CredentialProxyWiring, harnessSpecFor } from "./harness-registry.js";
import { installMarkerArgs } from "./orphan-reaper.js";
import { RUNNER_ENV, type RunnerCommand, type RunnerMessage } from "./runner-protocol.js";
import { resolveSandboxLaunch, type SandboxPolicy } from "./sandbox/index.js";
import type { AgentEvent, AgentInput, AgentRuntime } from "./types.js";

export interface RunnerHostOptions {
  workspace: Workspace;
  agent: AgentDefinition;
  harness: string;
  /** Bridge factory; the turn token is minted at spawn with the resolved allowSummon. */
  harnessHost?: (options: { allowSummon: boolean }) => HarnessHost;
  /** Resolved lazily at spawn: may this turn's token create summons? */
  allowSummon: () => boolean;
  /** Resolved lazily at spawn, so the controller can read room state (summon?) first. */
  sandbox: () => SandboxPolicy;
  /** Test seam: override the argv launched (default is `gaia __run-agent`). */
  runnerArgv?: string[];
  /** Launch breaker keyed by target; defaults to the daemon-wide shared one. */
  breaker?: CircuitBreaker;
}

// The CLI entry is cli.js when built, cli.ts under tsx; the runner re-launches it
// with the `__run-agent` subcommand, exactly how this daemon was launched.
function resolveCliPath(): string {
  const jsPath = fileURLToPath(new URL("../cli.js", import.meta.url));
  return existsSync(jsPath) ? jsPath : fileURLToPath(new URL("../cli.ts", import.meta.url));
}

function configuredLabel(agent: AgentDefinition): string {
  const provider = agent.model?.provider;
  const name = agent.model?.name;
  return provider && name ? `${provider}/${name}` : "default";
}

export class RunnerHost implements AgentRuntime {
  readonly agent: AgentDefinition;
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

  constructor(options: RunnerHostOptions) {
    this.options = options;
    this.agent = options.agent;
    this.capabilities = harnessSpecFor(options.harness).capabilities;
    this._modelLabel = configuredLabel(options.agent);
    this.breaker = options.breaker ?? defaultBreaker;
    this.breakerKey = `${options.harness}:${configuredLabel(options.agent)}`;
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
    // crash and leave it orphaned (see orphan-reaper). The runner ignores the
    // flag; it is a pure, ps-visible label scoped to this checkout.
    const base = this.options.runnerArgv ?? [process.execPath, ...process.execArgv, resolveCliPath(), "__run-agent"];
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
    if (process.env.GAIA_DEBUG_SANDBOX) {
      process.stderr.write(`[sandbox ${this.agent.id}] enabled=${policy.enabled} backend=${policy.backend} proxy=${Boolean(launchCtx.proxy)} launch=${launch.command}\n`);
    }

    const child = spawn(launch.command, launch.args, {
      cwd: this.options.workspace.rootDir,
      env: this.buildEnv(roomId, launchCtx),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.onMessage(line));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[runner ${this.agent.id}] ${chunk}`));
    child.on("error", (error) => {
      // e.g. ENOENT on the runner binary — a launch failure until proven ready.
      this.settleLaunch("failure");
      this.failActive(error);
    });
    child.on("exit", (code, signal) => {
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
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: RunnerMessage;
    try {
      message = JSON.parse(trimmed) as RunnerMessage;
    } catch {
      return;
    }
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
          this._modelLabel = `${message.event.provider}/${message.event.modelId}${message.event.subscription ? " (oauth)" : ""}`;
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [RUNNER_ENV.workspacePath]: this.options.workspace.rootDir,
      [RUNNER_ENV.agentId]: this.agent.id,
      [RUNNER_ENV.harness]: this.options.harness,
      [RUNNER_ENV.roomId]: roomId,
      [RUNNER_ENV.memoryDir]: this.agent.memoryDir,
      [RUNNER_ENV.roomDir]: join(this.options.workspace.roomsDir, roomId),
    };
    if (ctx.host && ctx.token !== undefined) {
      env[RUNNER_ENV.daemonUrl] = ctx.host.baseUrl;
      env[RUNNER_ENV.daemonToken] = ctx.token;
      if (ctx.proxy) {
        // Route this harness's LLM egress through the loopback proxy (bearing the
        // per-turn token). Order matters: strip every real provider key FIRST (else
        // a harness could fall back to the real key in the env, bypassing the proxy
        // and leaving the key in the sandbox), THEN apply the harness's declared
        // wiring — which may legitimately set the token UNDER a provider-key name
        // (e.g. codex's OPENAI_API_KEY=<token>). Uniform for every harness.
        stripProviderKeys(env);
        env[RUNNER_ENV.llmProxyUrl] = ctx.host.llmProxyUrl;
        Object.assign(env, ctx.proxy.env ?? {});
      }
    }
    return env;
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
