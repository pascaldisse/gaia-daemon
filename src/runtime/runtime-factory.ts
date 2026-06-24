import type { HarnessHost } from "../app/harness-bridge.js";
import type { AgentDefinition } from "../agents/types.js";
import { DEFAULTS } from "../config/defaults.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { SummonCreate } from "../tools/summon-tool.js";
import type { Workspace } from "../workspace/types.js";
// Importing the barrel self-registers every harness before the first lookup.
import { harnessSpecFor } from "./index.js";
import type { AgentRuntime } from "./types.js";

export type { AgentHarness } from "./capabilities.js";

export function createAgentRuntime(options: {
  workspace: Workspace;
  agent: AgentDefinition;
  memoryStore: MemoryStore;
  summonCreate?: SummonCreate;
  /** Daemon bridge for subprocess harnesses' memory/recall/summon CLI. */
  harnessHost?: HarnessHost;
}): AgentRuntime {
  const harness = options.agent.harness ?? options.workspace.config.harness ?? DEFAULTS.harness;
  return harnessSpecFor(harness).create({
    workspace: options.workspace,
    agent: options.agent,
    memoryStore: options.memoryStore,
    summonCreate: options.summonCreate,
    harnessHost: options.harnessHost,
  });
}
