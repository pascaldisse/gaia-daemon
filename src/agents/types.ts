import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export interface AgentModelConfig {
  provider?: string;
  name?: string;
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  icon: string;
  // TTS voice reference for voice surfaces (e.g. an unmute voices.yaml entry).
  voice?: string;
  runtime: string;
  dir: string;
  configPath: string;
  personaDir: string;
  rolesDir: string;
  soulPath: string;
  memoryPath: string;
  tools: string[];
  model?: AgentModelConfig;
  thinking?: ThinkingLevel;
  projectDir?: string;
  projectConfigPath?: string;
  projectPersonaDir?: string;
  projectRolesDir?: string;
  projectIntentPath?: string;
}
