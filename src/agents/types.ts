import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentHarness } from "../runtime/capabilities.js";

export interface AgentModelConfig {
  provider?: string;
  name?: string;
}

/** Claude Code `--permission-mode` values (see `claude --help`). */
export type ClaudePermissionMode = "default" | "acceptEdits" | "auto" | "dontAsk" | "plan" | "bypassPermissions";

export const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = [
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "plan",
  "bypassPermissions",
];

export interface AgentDefinition {
  id: string;
  displayName: string;
  icon: string;
  // TTS voice reference for voice surfaces (e.g. an unmute voices.yaml entry).
  voice?: string;
  dir: string;
  configPath: string;
  personaDir: string;
  rolesDir: string;
  soulPath: string;
  memoryDir: string;
  tools: string[];
  model?: AgentModelConfig;
  thinking?: ThinkingLevel;
  /** Agent harness backend. Falls back to workspace config, then "pi". */
  harness?: AgentHarness;
  /**
   * Posture knob exposed as data (Claude harness): permission mode for the
   * session. "plan" is how a read-only "plan mode" is expressed without a
   * hardcoded code path. Ignored by harnesses that have no equivalent.
   */
  permissionMode?: ClaudePermissionMode;
  projectDir?: string;
  projectConfigPath?: string;
  projectPersonaDir?: string;
  projectRolesDir?: string;
  projectIntentPath?: string;
}
