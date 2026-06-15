import type { AgentDefinition } from "../agents/types.js";

export interface WorkspaceConfig {
  defaultAgent: string;
  room: string;
  transcriptWindow: number;
  /** Default agent harness for all agents in this workspace; overridden by AgentDefinition.harness. */
  harness?: "pi" | "codex";
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
