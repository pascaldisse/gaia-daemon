import type { AgentDefinition } from "../agents/types.js";

export interface WorkspaceConfig {
  defaultAgent: string;
  room: string;
  runtime: string;
  transcriptWindow: number;
}

export interface Workspace {
  rootDir: string;
  dir: string;
  configPath: string;
  systemPath: string;
  agentsDir: string;
  roomsDir: string;
  config: WorkspaceConfig;
  agents: Record<string, AgentDefinition>;
}
