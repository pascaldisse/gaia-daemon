// Daemon-side AgentRuntime that runs a harness in a per-(room, agent) subprocess
// (the agent-runner). The daemon launches this the SAME way for every harness —
// Pi included — so the execution model is uniform and the sandbox has exactly
// one process to wrap. It speaks the runner protocol over the child's stdio and
// re-exposes the stream as the normal AgentEvent iterable the controller
// consumes, so nothing upstream knows a turn ran in a subprocess.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { HarnessHost } from "../app/harness-bridge.js";
import type { AgentDefinition } from "../agents/types.js";
import type { Workspace } from "../workspace/types.js";
import type { HarnessCapabilities } from "./capabilities.js";
import { createEventChannel, type EventChannel } from "./event-stream.js";
import { harnessSpecFor } from "./harness-registry.js";
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
}

// The CLI entry is cli.js when built, cli.ts under tsx; the runner re-launches it
// with the `__run-agent` subcommand, exactly how this daemon was launched.
function resolveCliPath(): string {
  const jsPath = fileURLToPath(new URL("../cli.js", import.meta.url));
  return existsSync(jsPath) ? jsPath : fileURLToPath(new URL("../cli.ts", import.meta.url));
}

// Provider API-key env names (pi-ai's env-api-keys map). A container inherits no
// env, so for the apple-container backend these are forwarded by name alongside
// the runner's own GAIA_* vars — but only the ones actually set in this process.
const PROVIDER_KEY_ENV = [
  "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
  "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY", "AZURE_OPENAI_API_KEY",
];

// Inside an apple-container VM the daemon's 127.0.0.1 is the GUEST's loopback, not
// the host. The host is reachable at the container network's gateway (apple's
// default bridge gateway is 192.168.64.1; override with GAIA_CONTAINER_HOST_IP).
function containerHostGateway(): string {
  return process.env.GAIA_CONTAINER_HOST_IP?.trim() || "192.168.64.1";
}

// Rewrite a daemon bridge URL so a containerized runner can reach the host: swap
// the loopback/0.0.0.0 host for the container-network gateway, keeping the port.
// Returns a bare origin (no trailing slash) to match host baseUrl shape — callers
// append a path that already starts with "/", so a trailing slash here would
// produce "//api/harness/..." which misses the daemon's "/api/" router and falls
// through to the SPA handler (a 200 that silently swallows the write).
function daemonUrlForContainer(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "0.0.0.0" || url.hostname === "::1") {
      url.hostname = containerHostGateway();
    }
    return `${url.protocol}//${url.host}`; // e.g. http://192.168.64.1:8796 — no trailing slash, no path
  } catch {
    return baseUrl;
  }
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

  constructor(options: RunnerHostOptions) {
    this.options = options;
    this.agent = options.agent;
    this.capabilities = harnessSpecFor(options.harness).capabilities;
    this._modelLabel = configuredLabel(options.agent);
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
      // Clear the promise on failure (e.g. a fail-closed sandbox) so a later
      // turn can retry rather than wedging on a one-time spawn error.
      this.spawnPromise = this.spawnChild(roomId).catch((error) => {
        this.spawnPromise = null;
        throw error;
      });
    }
    await this.spawnPromise;
  }

  private async spawnChild(roomId: string): Promise<void> {
    const argv = this.options.runnerArgv ?? [process.execPath, ...process.execArgv, resolveCliPath(), "__run-agent"];
    // The workspace (cwd) is writable, but its policy files are carved back to
    // read-only so a confined turn can't rewrite the governance that launches
    // the next one. Room scratch lives under cwd, so it needs no extra grant.
    const policy = this.options.sandbox();
    // Build the env first: the per-turn bridge token lands here, and the
    // container backend forwards env by name, so it needs the keys that are set.
    const env = this.buildEnv(roomId, policy);
    const forwardEnv = [...Object.values(RUNNER_ENV), "GAIA_HOME", ...PROVIDER_KEY_ENV].filter(
      (name) => env[name] !== undefined,
    );
    const launch = await resolveSandboxLaunch(policy, argv, this.options.workspace.rootDir, {
      readonly: [this.options.workspace.configPath, this.options.workspace.agentsOverrideDir],
      forwardEnv,
    });
    if (process.env.GAIA_DEBUG_SANDBOX) {
      process.stderr.write(`[sandbox ${this.agent.id}] enabled=${policy.enabled} backend=${policy.backend} launch=${launch.command}\n`);
    }

    const child = spawn(launch.command, launch.args, {
      cwd: this.options.workspace.rootDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.onMessage(line));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[runner ${this.agent.id}] ${chunk}`));
    child.on("error", (error) => this.failActive(error));
    child.on("exit", (code, signal) => {
      this.child = null;
      this.spawnPromise = null;
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
      // A runner inside an apple-container VM reaches the daemon at the container
      // gateway, not the daemon's own loopback; rewrite the URL it phones home to.
      env[RUNNER_ENV.daemonUrl] = policy.backend === "apple-container" ? daemonUrlForContainer(host.baseUrl) : host.baseUrl;
      env[RUNNER_ENV.daemonToken] = host.mintToken({ agentId: this.agent.id, roomId });
    }
    return env;
  }
}
