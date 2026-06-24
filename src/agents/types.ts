import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentHarness } from "../runtime/capabilities.js";
import type { SandboxConfig } from "../runtime/sandbox/registry.js";

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
  /** Per-agent sandbox override (above the harness; merged over the workspace default). */
  sandbox?: SandboxConfig;
  /**
   * Trust tier (default true). An untrusted agent (`trust: false`) can never run
   * outside a sandbox — forced isolation that no sandbox config can weaken (see
   * resolveSandboxPolicy) — and may never summon further workers. The cheap or
   * erratic models go here; the trusted lead runs wide open.
   */
  trust?: boolean;
  /**
   * May this agent summon further workers when it is ITSELF a summon (running in
   * a nested child room)? Default false — a summoned worker gets a scoped task,
   * not the keys to spawn its own swarm (prevents runaway summon fan-out). Top-
   * level turns are unaffected. Forced false for untrusted agents regardless
   * (see mayNestSummon).
   */
  allowNestedSummon?: boolean;
  projectDir?: string;
  projectConfigPath?: string;
  projectPersonaDir?: string;
  projectRolesDir?: string;
  projectIntentPath?: string;
}
