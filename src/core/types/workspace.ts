import type { AgentDef, HooksConfig, McpServerConfig, MemoryConfig, SandboxConfig, CollabConfig } from "./agents.js";

// ---------------------------------------------------------------------------
// Workspace (.gaia/config.json + resolved layout)

export interface WorkspaceConfig {
  defaultAgent: string;
  room: string;
  transcriptWindow: number;
  /** Enables the agent-initiated graceful conversation-ending tool. Default on;
   * agents choose whether to invoke it. */
  agentEndConversation: boolean;
  memory: MemoryConfig;
  harness?: string;
  maxSummonsPerRoom?: number;
  /** Image reads via GAIA's progressive renderer (default) or Pi native read. */
  imageRead?: "gaia" | "native";
  sandbox?: SandboxConfig;
  /** Multi-agent same-repo collaboration policy (.gaia/config.json `collab`).
   * Optional like `sandbox`: absent = `shared` = today's one-working-tree
   * behavior, byte-for-byte. */
  collab?: CollabConfig;
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: HooksConfig;
  /** Context-gate: warn before a NEWLY-addressed agent loads a transcript above
   * this many (estimated) tokens. Omitted → the built-in default. 0 disables. */
  contextGate?: { warnAboveTokens: number };
  /** Generic runner env passthrough (.gaia/config.json `env`): merged into every
   * harness subprocess's env, e.g. skill API keys (BRAVE_API_KEY, ...). Applied
   * BEFORE credential-proxy stripping — never a channel to smuggle an LLM
   * provider key past the proxy (host.ts buildEnv). Uniform across harnesses;
   * this layer has no idea what any key means. */
  env?: Record<string, string>;
}

export interface ContextFile {
  path: string;
  content: string;
}

export interface Workspace {
  rootDir: string;
  dir: string; // .gaia/
  configPath: string;
  agentsOverrideDir: string;
  roomsDir: string;
  globalAgentsDir: string;
  config: WorkspaceConfig;
  contextFiles: ContextFile[]; // boot-time snapshot — NOT used for prompt assembly (prompts re-read via discoverContextFiles at session boundaries: birth, /compact, /clear, /refresh); kept for test fixtures
  agents: Record<string, AgentDef>;
}

/** A workspace known to the daemon (~/.gaia/app.json recents) — the registry
 * entry served to clients in /api/app and the add-workspace response. */
export interface WorkspaceRecord {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: string;
  isInitialized: boolean;
  /** Human owner for an isolated workspace. Absent = legacy shared scope. */
  humanId?: string;
  /** Sidebar-pinned to the top of the workspace list, ahead of every non-favorite
   * (right-click "Add favorite", same UX as RoomState.favorite). Display metadata
   * only. */
  favorite?: boolean;
  /** Manual drag-drop sort key set by the sidebar reorder gesture. Absent =
   * never dragged; those sort after every explicitly-ordered record, by
   * `lastOpenedAt` among themselves (see WorkspaceRegistry.list). */
  order?: number;
}

/** "Keep laptop awake while GAIA runs" — a daemon-managed (macOS-only)
 * setting served in /api/app so the client can render the Global Settings
 * checkbox and hide/disable it where the capability doesn't exist. */
export interface KeepAwakeCapability {
  /** false off-macOS: the setting is inert there (see services/keep-awake.ts). */
  supported: boolean;
  enabled: boolean;
}

