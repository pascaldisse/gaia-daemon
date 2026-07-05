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

/** A provider-side model switch during a turn (capacity fallback, safety
 * reroute, model retirement). `reason` is the harness's human-readable
 * explanation, passed through verbatim. */
export interface ModelFallback {
  from: string;
  to: string;
  reason: string;
}

/** A file pasted into the composer and attached to a user message. The bytes
 * live durably under the room's files/ dir; `path` is the absolute location on
 * the daemon host (readable by every harness's tools), `name` the original
 * client-side filename shown in the UI. */
export interface MessageAttachment {
  name: string;
  mime: string;
  size: number;
  path: string;
}

/** Runtime metadata for one agent message. v2 stores this ON the transcript
 * event at commit, so history never forgets what produced it. (v1 kept a
 * 50-entry LRU in state.json; those legacy entries are still read.) */
export interface EventDetails {
  model?: string;
  modelFallback?: ModelFallback;
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
  attachments?: MessageAttachment[];
  /** Text was rewritten by a sanitize apply; the original line lives in
   * redactions.jsonl beside the transcript. */
  redacted?: boolean;
}

export interface AgentRoomEvent {
  id: string;
  timestamp: string;
  author: string; // agent id
  text: string;
  channel?: string;
  details?: EventDetails;
  /** Text was rewritten by a sanitize apply; the original line lives in
   * redactions.jsonl beside the transcript. */
  redacted?: boolean;
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
  /** Files attached to the prompt — replayed with it on resume. */
  attachments?: MessageAttachment[];
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
  attachments?: MessageAttachment[];
  /** This message was produced by room agent-dialogue (one agent addressing
   * another), not typed by a human — drain must treat it as plain text, never
   * parse it as a slash command, and it doesn't reset the dialogue hop count. */
  fromAgentDialogue?: boolean;
  queuedAt: string;
}

export interface RoomState {
  activeRoles: Record<string, string>;
  agentCursors: Record<string, number>;
  /** Legacy v1 per-event details, read-only in v2 (new details go on the
   * transcript event itself). Preserved so old rooms keep their metadata. */
  runtimeDetails?: Record<string, EventDetails>;
  parentRoomId?: string;
  /** Display name when the room id alone isn't it (e.g. an imported chat's
   * original title). */
  title?: string;
  /** Set on rooms created by a history import (scripts/import-claude-export):
   * the original conversation's created_at. The sidebar groups these into a
   * collapsed archive section instead of the live rooms list. */
  imported?: string;
  monad?: MonadConfig;
  pendingTurn?: PendingTurn;
  queue?: QueuedMessage[];
  /** Latest harness-reported context accounting per agent, keyed by agent id.
   * Persisted so the composer's `ctx` chip survives a restart instead of
   * blanking until the next turn re-reports. Harness-agnostic — every runtime
   * feeds the same `context-usage` event. */
  contextUsage?: Record<string, { usedTokens: number; maxTokens?: number }>;
  /** A held first turn for a newly-addressed agent whose transcript load would
   * exceed the warn threshold; the human picks how much context to give it
   * before it runs. Durable so the choice survives a restart. */
  contextGate?: ContextGatePending;
  /** Thanks-Dario mode: when a provider-side safeguard reroutes the model
   * mid-turn, the reviewer persona is asked for redaction suggestions. */
  thanksDario?: boolean;
  /** The agent this room is currently talking to — the last one addressed
   * (via @mention, a summon target, or an agent hand-off). A message with no
   * leading @mention routes here; absent → the workspace defaultAgent seeds it.
   * Per-room, unlike the workspace-wide defaultAgent. */
  activeAgent?: string;
  /** Room agent-dialogue: when on, an agent's reply that @mentions another
   * known agent triggers that agent to respond in this room (bounded by a
   * hop cap). Off by default — opt-in per room to avoid runaway loops. */
  agentDialogue?: boolean;
}

/** A NEW agent was addressed in a room whose transcript would exceed the
 * configured warn threshold on its first load. The turn is held until the human
 * chooses how much context to hand it — full, last-N messages, or a compacted
 * summary. The compaction affects ONLY this agent's first seed; the transcript
 * and every other agent's session are untouched. One pending per room. */
export interface ContextGatePending {
  agentId: string;
  /** The user message the agent will answer once the choice is made (already in
   * the transcript — replayed, never re-recorded). */
  message: string;
  /** Estimated tokens of the transcript it would load (visible text only — no
   * tool calls or thinking, exactly what the agent would receive). */
  estTokens: number;
  /** The agent's context window, when the harness declares one — for the %
   * display. Absent → the UI shows tokens only. */
  window?: number;
  /** Transcript length at gate time; last-N and compact position against it. */
  totalEvents: number;
  /** Attachments on the held message, replayed with the resumed turn. */
  attachments?: MessageAttachment[];
  /** Why the turn was held: a new agent's first load (default when absent), or
   * an existing agent whose harness session vanished — the history behind its
   * cursor must be replayed rather than silently continuing mid-conversation. */
  reason?: "new-agent" | "session-lost";
  at: string;
}

// ---------------------------------------------------------------------------
// Thanks-Dario context sanitize (services/sanitize.ts)

/** One proposed rewrite of a past transcript event's text. `quote` must be an
 * exact substring of the event's current text — apply validates it, so a
 * hallucinated quote is skipped instead of corrupting the transcript. */
export interface SanitizeSuggestion {
  id: string;
  eventId: string;
  /** Author of the event being edited (display context for the review UI). */
  author: string;
  quote: string;
  replacement: string;
  reason: string;
}

/** A named strategy grouping a subset of the suggestions (e.g. "light touch"
 * vs "full scrub") — the review UI preselects the chosen option's set. */
export interface SanitizeOption {
  id: string;
  label: string;
  description: string;
  suggestionIds: string[];
}

/** A reviewer's full proposal for a room, persisted as sanitize.json in the
 * room dir so a dismissed popup can be reopened. Nothing in it is applied
 * until the human approves specific suggestions. */
export interface SanitizeProposal {
  at: string;
  roomId: string;
  reviewer: string;
  /** How many transcript events the reviewer saw. */
  window: number;
  summary: string;
  options: SanitizeOption[];
  suggestions: SanitizeSuggestion[];
  /** Suggestions discarded at parse time (unknown event or stale quote). */
  discarded?: number;
  /** Raw reviewer reply, kept when it did not parse as the JSON contract. */
  raw?: string;
  parseError?: string;
  appliedAt?: string;
}

/** Lightweight sanitize state carried on the room snapshot. */
export interface SanitizeStatus {
  at: string;
  suggestions: number;
  appliedAt?: string;
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

/** One observer hook: a shell command run by the daemon at a room-lifecycle
 * point. The event payload arrives as JSON on stdin (+ GAIA_HOOK_* env).
 * Fire-and-forget — a hook never blocks or fails a turn. */
export interface HookCommand {
  command: string;
  /** Kill the hook after this many seconds (default 10). */
  timeoutSec?: number;
}

/** Hooks run at the ROOM layer, so they are uniform for every harness by
 * construction — no per-harness translation, no gating (the sandbox is the
 * boundary; hooks observe). */
export interface HooksConfig {
  /** Before an agent turn is dispatched. */
  preTurn?: HookCommand[];
  /** After a reply commits (payload carries reply, outcome, tools). */
  postTurn?: HookCommand[];
  /** After each tool call inside a turn settles. */
  toolUse?: HookCommand[];
  /** A turn failed (payload carries the error). */
  error?: HookCommand[];
}

/** One MCP server, workspace- or agent-scoped. `command` (stdio) or `url`
 * (remote) — each harness translates this shape onto its own MCP surface
 * (claude --mcp-config, codex mcp_servers config); pi has no core MCP. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface SandboxConfig {
  enabled?: boolean;
  backend?: string;
  writable?: string[];
  net?: "full" | "none";
  credentialProxy?: boolean;
}

/** Per-agent read-aloud TTS choice (agent.json `tts`): which registered engine
 * speaks this agent's messages, and the engine-specific voice to use. */
export interface AgentTtsConfig {
  engine?: string;
  voice?: string;
}

export interface AgentDef {
  id: string;
  displayName: string;
  icon: string;
  voice?: string;
  /** Read-aloud TTS for the transcript play button (voice calls use `voice`). */
  tts?: AgentTtsConfig;
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
  /** Skills to load for this agent, by name — resolved against every
   * auto-detected skill dir (gaia/pi/claude/codex/hermes). Merged with the
   * active role's skills. Detected ≠ loaded: this is where you opt in. */
  skills?: string[];
  model?: AgentModelConfig;
  thinking?: ThinkingLevel;
  harness?: string;
  permissionMode?: ClaudePermissionMode;
  /** Reveal the model's extended-thinking text (claude harness). Opt-in: it
   * injects thinking.display:"summarized" into the CLI's Anthropic egress so the
   * otherwise-redacted reasoning streams. Off by default — mutates provider
   * requests, so it's a knowing choice like the credential proxy. */
  revealThinking?: boolean;
  sandbox?: SandboxConfig;
  /** Trust tier (default true). false → forced real sandbox, may never summon. */
  trust?: boolean;
  /** May summon further workers when itself a summon (default false). */
  allowNestedSummon?: boolean;
  /** Per-agent memory overrides applied over the workspace MemoryConfig. */
  memory?: MemoryConfigPatch;
  /** Per-agent MCP servers, merged over the workspace set (agent wins). */
  mcpServers?: Record<string, McpServerConfig>;
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
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: HooksConfig;
  /** Context-gate: warn before a NEWLY-addressed agent loads a transcript above
   * this many (estimated) tokens. Omitted → the built-in default. 0 disables. */
  contextGate?: { warnAboveTokens: number };
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
  | { type: "model-fallback"; fromModel: string; toModel: string; reason: string }
  | { type: "context-usage"; usedTokens: number; maxTokens?: number }
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
  /** The model agent.json asks for, e.g. `anthropic/fable`. `modelLabel`
   * tracks what live turns actually run; they diverge on a fallback. */
  configuredModel: string;
  /** The last turn's provider-side model switch, if any — cleared by the
   * next turn that completes on the configured model. */
  modelFallback?: ModelFallback;
  /** Session context accounting from the harness's own reporting; absent
   * until a turn reports it. maxTokens absent = window size unknown. */
  context?: { usedTokens: number; maxTokens?: number };
  tools: string[];
  voice?: string;
  thinking?: string;
  activeRole?: string;
  roles: string[];
  status: "idle" | "running" | "error" | "compacting";
  isDefault: boolean;
}

export interface RoomSummary {
  id: string;
  path: string;
  isCurrent: boolean;
  parentRoomId?: string;
  /** True while this room is a summon whose first turn is still streaming. */
  running?: boolean;
  title?: string;
  /** Original created_at of an imported chat (see RoomState.imported). */
  imported?: string;
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
    /** Total committed events in the transcript; `events` is only the tail
     * window, so the client knows how much "load older" can page in. */
    eventTotal: number;
    /** Thanks-Dario mode flag (auto-review on model fallback). */
    thanksDario?: boolean;
    /** Last sanitize proposal, if any (full body via GET .../sanitize). */
    sanitize?: SanitizeStatus;
    /** A held first turn awaiting the human's context-size choice (modal). */
    contextGate?: ContextGatePending;
    /** The agent this room is currently addressing — drives the composer's
     * default target. Absent → the workspace defaultAgent stands in. */
    activeAgent?: string;
    /** Room agent-dialogue toggle (agents replying to each other's @mentions). */
    agentDialogue?: boolean;
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
  | ({ type: "model-fallback"; fromModel: string; toModel: string; reason: string } & StreamScope)
  | ({ type: "context-usage"; usedTokens: number; maxTokens?: number } & StreamScope)
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
