import type { AgentDefinition } from "../agents/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { Workspace } from "../workspace/types.js";
import { PiRuntime } from "./pi-runtime.js";
import type { AgentRuntime } from "./types.js";

export function createAgentRuntime(options: {
  cwd: string;
  workspace: Workspace;
  agent: AgentDefinition;
  memoryStore: MemoryStore;
}): AgentRuntime {
  const runtime = options.agent.runtime || options.workspace.config.runtime;
  if (runtime !== "pi") throw new Error(`Unsupported runtime: ${runtime}`);
  return new PiRuntime(options.cwd, options.workspace, options.agent, options.memoryStore);
}
