import type { AgentDefinition } from "../agents/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { SummonCreate } from "../tools/summon-tool.js";
import type { Workspace } from "../workspace/types.js";
import { ClaudeRuntime } from "./claude-runtime.js";
import { CodexRuntime } from "./codex-runtime.js";
import { PiRuntime } from "./pi-runtime.js";
import type { AgentRuntime } from "./types.js";

export type AgentHarness = "pi" | "codex" | "claude";

export function createAgentRuntime(options: {
  workspace: Workspace;
  agent: AgentDefinition;
  memoryStore: MemoryStore;
  summonCreate?: SummonCreate;
}): AgentRuntime {
  const harness: AgentHarness = options.agent.harness ?? options.workspace.config.harness ?? "pi";
  switch (harness) {
    case "pi":
      return new PiRuntime(options.workspace, options.agent, options.memoryStore, undefined, options.summonCreate);
    case "codex":
      return new CodexRuntime(options.workspace, options.agent, options.memoryStore, undefined, options.summonCreate);
    case "claude":
      return new ClaudeRuntime(options.workspace, options.agent, options.memoryStore, undefined, options.summonCreate);
    default:
      throw new Error(`Unsupported harness: ${harness}`);
  }
}
