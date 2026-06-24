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
  harnessHost?: HarnessHost;
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
    const launch = await resolveSandboxLaunch(this.options.sandbox(), argv, this.options.workspace.rootDir);

    const child = spawn(launch.command, launch.args, {
      cwd: this.options.workspace.rootDir,
      env: this.buildEnv(roomId),
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

  private buildEnv(roomId: string): NodeJS.ProcessEnv {
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
      env[RUNNER_ENV.daemonUrl] = this.options.harnessHost.baseUrl;
      env[RUNNER_ENV.daemonToken] = this.options.harnessHost.mintToken({ agentId: this.agent.id, roomId });
    }
    return env;
  }
}
