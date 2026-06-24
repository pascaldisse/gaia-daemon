import type { HarnessHost } from "../app/harness-bridge.js";
import type { AgentDefinition } from "../agents/types.js";
import { DEFAULTS } from "../config/defaults.js";
import type { Workspace } from "../workspace/types.js";
// Importing the barrel self-registers every harness before the first lookup.
import "./index.js";
import { RunnerHost } from "./runner-host.js";
import type { SandboxPolicy } from "./sandbox/index.js";
import type { AgentRuntime } from "./types.js";

export type { AgentHarness } from "./capabilities.js";

/**
 * The runtime the daemon hands the controller. Every harness — Pi included — runs
 * in a per-(room, agent) subprocess via RunnerHost, so the execution model is
 * uniform and the sandbox wraps one process. The runner builds the real runtime
 * (PiRuntime/ClaudeRuntime/CodexRuntime) and its bridge-backed memory/summon, so
 * those deps no longer cross this boundary.
 */
export function createAgentRuntime(options: {
  workspace: Workspace;
  agent: AgentDefinition;
  /** Daemon bridge: the runner forwards its token for memory writes + summon. */
  harnessHost?: HarnessHost;
  /** Resolved lazily at spawn so the controller can read room state (summon?) first. */
  sandbox?: () => SandboxPolicy;
}): AgentRuntime {
  const harness = options.agent.harness ?? options.workspace.config.harness ?? DEFAULTS.harness;
  return new RunnerHost({
    workspace: options.workspace,
    agent: options.agent,
    harness,
    harnessHost: options.harnessHost,
    sandbox: options.sandbox ?? (() => ({ enabled: false, backend: "none" })),
  });
}
