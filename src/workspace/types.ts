import type { AgentDefinition } from "../agents/types.js";
import type { AgentHarness } from "../runtime/capabilities.js";
import type { SandboxConfig } from "../runtime/sandbox/registry.js";

export interface WorkspaceConfig {
  defaultAgent: string;
  room: string;
  transcriptWindow: number;
  /** Default agent harness for all agents in this workspace; overridden by AgentDefinition.harness. */
  harness?: AgentHarness;
  /** Max summons (whales) allowed to run concurrently per room. Bounds swarm fan-out. */
  maxSummonsPerRoom?: number;
  /** Default sandbox policy for this workspace's agents (overridden per agent). */
  sandbox?: SandboxConfig;
}

export interface ContextFile {
  path: string;
  content: string;
}

export interface Workspace {
  rootDir: string;
  dir: string;
  configPath: string;
  agentsOverrideDir: string;
  roomsDir: string;
  globalAgentsDir: string;
  config: WorkspaceConfig;
  contextFiles: ContextFile[];
  agents: Record<string, AgentDefinition>;
}
