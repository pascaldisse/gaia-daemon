import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export interface AgentModelConfig {
  provider?: string;
  name?: string;
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  icon: string;
  public: boolean;
  runtime: string;
  dir: string;
  configPath: string;
  soulPath: string;
  memoryPath: string;
  tools: string[];
  skills: string[];
  model?: AgentModelConfig;
  thinking?: ThinkingLevel;
  projectDir?: string;
  projectConfigPath?: string;
  projectSoulAppendPath?: string;
  soulSource: "global" | "project-override";
}
