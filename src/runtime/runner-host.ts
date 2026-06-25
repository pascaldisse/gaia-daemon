// Daemon-side AgentRuntime that runs a harness in a per-(room, agent) subprocess
// (the agent-runner). The daemon launches this the SAME way for every harness —
// Pi included — so the execution model is uniform and the sandbox has exactly
// one process to wrap. It speaks the runner protocol over the child's stdio and
// re-exposes the stream as the normal AgentEvent iterable the controller
// consumes, so nothing upstream knows a turn ran in a subprocess.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
import { harnessSpecFor } from "./harness-registry.js";
import { installMarkerArgs } from "./orphan-reaper.js";
import { RUNNER_ENV, type RunnerCommand, type RunnerMessage } from "./runner-protocol.js";
import { resolveSandboxLaunch, type SandboxPolicy } from "./sandbox/index.js";
import type { AgentEvent, AgentInput, AgentRuntime } from "./types.js";

// The real Pi credential store the daemon hides from a proxied turn: Pi reads its
// key here (and a dumb summon could `cat` it), so it is both read-denied in the
// sandbox and side-stepped by relocating Pi's agent dir (PI_CODING_AGENT_DIR).
function realPiAuthJson(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

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
    // When the credential proxy is on, deny the sandbox read access to the real
    // Pi cred store on top of the backend's built-in sensitive set, so a summon
    // cannot exfiltrate the key the proxy is hiding. (A no-op when unsandboxed.)
    const denyRead = this.proxyEnabled(policy) ? [realPiAuthJson()] : undefined;
    let launch;
    try {
      launch = await resolveSandboxLaunch(policy, argv, this.options.workspace.rootDir, {
        readonly: [this.options.workspace.configPath, this.options.workspace.agentsOverrideDir],
        denyRead,
      });
    } catch (error) {
      // Fail-closed sandbox (e.g. off darwin) is a launch failure for the breaker.
      this.settleLaunch("failure");
      throw error;
    }
    if (process.env.GAIA_DEBUG_SANDBOX) {
      process.stderr.write(`[sandbox ${this.agent.id}] enabled=${policy.enabled} backend=${policy.backend} proxy=${this.proxyEnabled(policy)} launch=${launch.command}\n`);
    }

    const child = spawn(launch.command, launch.args, {
      cwd: this.options.workspace.rootDir,
      env: this.buildEnv(roomId, policy),
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

  // The credential proxy is Pi-only for now (claude/codex redirect comes later).
  private proxyEnabled(policy: SandboxPolicy): boolean {
    return policy.credentialProxy === true && this.options.harness === "pi";
  }

  // A per-room scratch agent dir for a proxied Pi turn. Relocating Pi's agent dir
  // here (empty auth.json) means Pi's AuthStorage resolves no real key, so the
  // placeholder token registered against the proxy is what reaches the wire. It
  // sits under the workspace rooms dir, which is inside the writable cwd.
  private piAgentScratchDir(roomId: string): string {
    return join(this.options.workspace.roomsDir, roomId, "pi-agent-dir");
  }

  private buildEnv(roomId: string, policy: SandboxPolicy): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [RUNNER_ENV.workspacePath]: this.options.workspace.rootDir,
      [RUNNER_ENV.agentId]: this.agent.id,
      [RUNNER_ENV.harness]: this.options.harness,
      [RUNNER_ENV.roomId]: roomId,
      [RUNNER_ENV.memoryDir]: this.agent.memoryDir,
      [RUNNER_ENV.roomDir]: join(this.options.workspace.roomsDir, roomId),
    };
    if (this.options.harnessHost) {
      const host = this.options.harnessHost({ allowSummon: this.options.allowSummon() });
      env[RUNNER_ENV.daemonUrl] = host.baseUrl;
      env[RUNNER_ENV.daemonToken] = host.mintToken({ agentId: this.agent.id, roomId });
      if (this.proxyEnabled(policy)) {
        // Point Pi at the loopback proxy (it bears GAIA_DAEMON_TOKEN), relocate
        // its agent dir so it finds no real key, and strip every provider key
        // env var — otherwise Pi's getApiKey() falls back to the env and uses the
        // REAL key, bypassing the proxy and leaving the key in the sandbox.
        env[RUNNER_ENV.llmProxyUrl] = host.llmProxyUrl;
        env.PI_CODING_AGENT_DIR = this.ensurePiAgentScratch(roomId);
        stripProviderKeys(env);
      }
    }
    return env;
  }

  // Materialize the scratch agent dir + an empty auth.json so Pi's AuthStorage
  // loads a valid-but-empty store (no key) rather than tripping on a missing dir.
  private ensurePiAgentScratch(roomId: string): string {
    const dir = this.piAgentScratchDir(roomId);
    mkdirSync(dir, { recursive: true });
    const authJson = join(dir, "auth.json");
    if (!existsSync(authJson)) writeFileSync(authJson, "{}\n");
    return dir;
  }
}
