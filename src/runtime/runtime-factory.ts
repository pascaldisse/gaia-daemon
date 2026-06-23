import type { HarnessHost } from "../app/harness-bridge.js";
import type { AgentDefinition } from "../agents/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { SummonCreate } from "../tools/summon-tool.js";
import type { Workspace } from "../workspace/types.js";
import type { AgentHarness } from "./capabilities.js";
import { ClaudeRuntime } from "./claude-runtime.js";
import { CodexRuntime } from "./codex-runtime.js";
import { PiRuntime } from "./pi-runtime.js";
import type { AgentRuntime } from "./types.js";

export type { AgentHarness } from "./capabilities.js";

export function createAgentRuntime(options: {
  workspace: Workspace;
  agent: AgentDefinition;
  memoryStore: MemoryStore;
  summonCreate?: SummonCreate;
  /** Daemon bridge for the Claude harness's memory/recall/summon CLI. */
  harnessHost?: HarnessHost;
}): AgentRuntime {
  const harness: AgentHarness = options.agent.harness ?? options.workspace.config.harness ?? "pi";
  const base = {
    workspace: options.workspace,
    agent: options.agent,
    memoryStore: options.memoryStore,
    summonCreate: options.summonCreate,
  };
  switch (harness) {
    case "pi":
      return new PiRuntime(base);
    case "codex":
      return new CodexRuntime({ ...base, harnessHost: options.harnessHost });
    case "claude":
      return new ClaudeRuntime({ ...base, harnessHost: options.harnessHost });
    default:
      throw new Error(`Unsupported harness: ${harness}`);
  }
}
