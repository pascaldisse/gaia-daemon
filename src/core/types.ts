// The single vocabulary. Every layer speaks these types; no layer redefines
// them. On-disk shapes (transcript.jsonl lines, state.json, agent.json,
// .gaia/config.json) are v1-compatible: v2 adds optional fields, never
// requires them.

// ---------------------------------------------------------------------------
// Room events (transcript.jsonl lines)

export interface ToolDetail {
  id: string;
  toolName: string;
  status: "running" | "complete" | "error";
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
}

/** Runtime metadata for one agent message. v2 stores this ON the transcript
 * event at commit, so history never forgets what produced it. (v1 kept a
 * 50-entry LRU in state.json; those legacy entries are still read.) */
export interface EventDetails {
  model?: string;
  thinkingStarted?: boolean;
  thinking?: string;
  tools?: ToolDetail[];
}

export interface UserRoomEvent {
  id: string;
  timestamp: string;
  author: "user";
  targets: string[];
  text: string;
  channel?: string; // "voice" for spoken turns
}

export interface AgentRoomEvent {
  id: string;
  timestamp: string;
  author: string; // agent id
  text: string;
  channel?: string;
  details?: EventDetails;
}

export type RoomEvent = UserRoomEvent | AgentRoomEvent;

// ---------------------------------------------------------------------------
// Room state (state.json)

export interface PendingTurn {
  /** Originating task id. */
  id: string;
  /** Transcript event id RESERVED for the reply before streaming starts —
   * the commit-idempotence key of the WAL protocol (see domain/rooms.ts). */
  eventId?: string;
  /** The prompt that drove the turn — replayed verbatim to resume it. */
  prompt: string;
  /** Agents still to run (the in-flight one stays until it completes). */
  targets: string[];
  /** The agent whose turn is currently streaming. */
  agentId: string;
  /** Reply text streamed so far — flushed durably as it arrives. */
  partialReply: string;
  channel?: "voice";
  startedAt: string;
}

/** A user message waiting behind the active task. Durable: survives crashes
 * (v1 kept these in a private array; that array is why v1's "no progress
 * ever lost" was a lie). */
export interface QueuedMessage {
  taskId: string;
  text: string;
  targets: string[];
  channel?: "voice";
  queuedAt: string;
}

export interface RoomState {
  activeRoles: Record<string, string>;
  agentCursors: Record<string, number>;
  /** Legacy v1 per-event details, read-only in v2 (new details go on the
   * transcript event itself). Preserved so old rooms keep their metadata. */
  runtimeDetails?: Record<string, EventDetails>;
  parentRoomId?: string;
  monad?: MonadConfig;
  pendingTurn?: PendingTurn;
  queue?: QueuedMessage[];
}

// ---------------------------------------------------------------------------
// Agents (agent.json + resolved paths)

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ClaudePermissionMode = "default" | "acceptEdits" | "auto" | "dontAsk" | "plan" | "bypassPermissions";

export const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = ["default", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"];

export interface AgentModelConfig {
  provider?: string;
  name?: string;
}

// Memory v3 (MEMORY-DESIGN.md): auto-recall, embeddings, consolidation.
// Workspace config resolves to a full MemoryConfig over the defaults; agents
// may override any subset via agent.json's `memory` patch.
export interface MemoryEmbeddingsProviderConfig {
  provider: string;
  model?: string;
  baseUrl?: string;
  envKey?: string;
}

export interface MemoryConsolidateConfig {
  enabled: boolean;
  idleMinutes: number;
  maxPerDay: number;
  /** Consolidation model; unset = the agent's own model. */
  model?: AgentModelConfig;
}

export interface MemoryConfig {
  autoRecall: boolean;
  autoRecallBudget: number;
  embeddings: "auto" | "off" | MemoryEmbeddingsProviderConfig;
  consolidate: MemoryConsolidateConfig;
  decayHalfLifeDays: number;
}

export interface MemoryConfigPatch {
  autoRecall?: boolean;
  autoRecallBudget?: number;
  embeddings?: MemoryConfig["embeddings"];
  consolidate?: Partial<MemoryConsolidateConfig>;
  decayHalfLifeDays?: number;
}

export interface SandboxConfig {
  enabled?: boolean;
  backend?: string;
  writable?: string[];
  net?: "full" | "none";
  credentialProxy?: boolean;
}

export interface AgentDef {
  id: string;
  displayName: string;
  icon: string;
  voice?: string;
  // Resolved locations (global agent dir + optional project overlay).
  dir: string;
  configPath: string;
  personaDir: string;
  rolesDir: string;
  soulPath: string;
  memoryDir: string;
  projectDir?: string;
  projectConfigPath?: string;
  projectPersonaDir?: string;
  projectRolesDir?: string;
  projectIntentPath?: string;
  // Hard control.
  tools: string[];
  model?: AgentModelConfig;
  thinking?: ThinkingLevel;
  harness?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: SandboxConfig;
  /** Trust tier (default true). false → forced real sandbox, may never summon. */
  trust?: boolean;
  /** May summon further workers when itself a summon (default false). */
  allowNestedSummon?: boolean;
  /** Per-agent memory overrides applied over the workspace MemoryConfig. */
  memory?: MemoryConfigPatch;
}

// ---------------------------------------------------------------------------
// Workspace (.gaia/config.json + resolved layout)

export interface WorkspaceConfig {
  defaultAgent: string;
  room: string;
  transcriptWindow: number;
  memory: MemoryConfig;
  harness?: string;
  maxSummonsPerRoom?: number;
  sandbox?: SandboxConfig;
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
  contextFiles: ContextFile[]; // AGENTS.md chain, parent-most first
  agents: Record<string, AgentDef>;
}

// ---------------------------------------------------------------------------
// Harness stream events (what a runtime yields during a turn)

export type AgentEvent =
  | { type: "model-info"; provider: string; modelId: string; subscription: boolean }
  | { type: "text-delta"; delta: string }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; delta: string }
  | { type: "thinking-end"; content?: string }
  | { type: "tool-start"; toolName: string; toolCallId?: string; args?: unknown }
  | { type: "tool-update"; toolName: string; toolCallId?: string; partialResult?: unknown }
  | { type: "tool-end"; toolName: string; toolCallId?: string; result?: unknown; isError: boolean };

// ---------------------------------------------------------------------------
// Tasks + UI events (SSE payloads; the v1 wire shape exactly, plus `eventId`
// on the streaming events so clients key runtime details by transcript event
// instead of guessing by author+text)

export type TaskStatus = "queued" | "running" | "complete" | "error" | "cancelled";

export interface Task {
  id: string;
  roomId: string;
  text: string;
  targets: string[];
  status: TaskStatus;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export interface AgentStatus {
  id: string;
  displayName: string;
  icon: string;
  modelLabel: string;
  tools: string[];
  voice?: string;
  thinking?: string;
  activeRole?: string;
  roles: string[];
  status: "idle" | "running" | "error";
  isDefault: boolean;
}

export interface RoomSummary {
  id: string;
  path: string;
  isCurrent: boolean;
  parentRoomId?: string;
  /** True while this room is a summon whose first turn is still streaming. */
  running?: boolean;
}

export interface SlashCommandDefinition {
  name: string;
  type: string;
  description: string;
  aliases?: string[];
}

export interface Snapshot {
  workspace: {
    id: string;
    rootDir: string;
    configPath: string;
    defaultAgent: string;
  };
  room: {
    id: string;
    statePath: string;
    /** Events carry their runtime details on `details` (v1 sent side-band
     * underscore fields merged client-side; that heuristic is gone). */
    events: RoomEvent[];
  };
  rooms: RoomSummary[];
  commands: SlashCommandDefinition[];
  agents: AgentStatus[];
  tasks: Task[];
  thinkingLevels: string[];
}

/** Active voice call binding, broadcast to clients and returned by voice/start. */
export interface VoiceCallInfo {
  agentId: string;
  roomId: string;
  unmuteUrl: string;
  voice?: string;
  thinking?: string;
  startedAt: string;
}

interface StreamScope {
  workspaceId: string;
  roomId: string;
  taskId: string;
  agentId: string;
  /** The transcript event id RESERVED for this reply (the WAL id) — present
   * from the first delta so clients render into the final event node. */
  eventId: string;
}

export type UiEvent =
  | { type: "snapshot"; workspaceId: string; roomId: string; snapshot: Snapshot }
  | { type: "room-event"; workspaceId: string; roomId: string; event: RoomEvent }
  | { type: "task-start"; workspaceId: string; roomId: string; task: Task }
  | { type: "task-end"; workspaceId: string; roomId: string; task: Task }
  | { type: "task-error"; workspaceId: string; roomId: string; task: Task; error: string }
  | ({ type: "model-info"; provider: string; modelId: string; subscription: boolean } & StreamScope)
  | ({ type: "text-delta"; delta: string } & StreamScope)
  | ({ type: "thinking-start" } & StreamScope)
  | ({ type: "thinking-delta"; delta: string } & StreamScope)
  | ({ type: "thinking-end"; content?: string } & StreamScope)
  | ({ type: "tool-start"; toolName: string; toolCallId?: string; args?: unknown } & StreamScope)
  | ({ type: "tool-update"; toolName: string; toolCallId?: string; partialResult?: unknown } & StreamScope)
  | ({ type: "tool-end"; toolName: string; toolCallId?: string; result?: unknown; isError: boolean } & StreamScope)
  | { type: "settings-saved"; workspaceId?: string; roomId?: string; fileId: string }
  | { type: "voice-status"; workspaceId: string; roomId: string; voice: VoiceCallInfo | null; pending?: { agentId: string; message: string } };

// ---------------------------------------------------------------------------
// Monad vocabulary (embedded in state.json → core, not a layer above)

export interface ChatMessage {
  role: string;
  content: string;
}

export interface MonadSlot {
  index: number;
  agentId: string;
  label?: string;
  defaultRole?: string;
}

export interface MonadStep {
  index: number;
  agentId: string;
  role: string;
  subtask: string;
  reply: string;
  sees: number[] | "all";
}

export interface MonadObservation {
  query: string;
  steps: MonadStep[];
}

export interface RouteDecision {
  agentId: string;
  role: string;
  subtask: string;
  sees: number[] | "all";
}

export type MonadOutcome = { kind: "dispatch"; decision: RouteDecision } | { kind: "accept" } | { kind: "stop"; reason: string };

export interface MonadConfig {
  policy: string;
  policyConfig?: unknown;
  slots: MonadSlot[];
  roles: string[];
  maxTurns: number;
  coordinatorAgentId?: string;
  terminate?: { on: "verifier-accept"; acceptToken: string };
  /** Role prompt text inlined at setup activation — the room is self-contained. */
  rolePrompts?: Record<string, string>;
}

export interface MonadResult {
  final: string;
  steps: MonadStep[];
  terminatedBy: "accept" | "max-turns" | "stop";
}
