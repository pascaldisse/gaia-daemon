import type { BackgroundTask, UiDeviceCodeInfo, UiPromptField } from "./harness.js";
import type { EventDetails, LiveTurn, MessageAttachment, ModelFallback, RoomEvent, SkillInvocation } from "./events.js";
import type { AgentDef } from "./agents.js";
import type { ContextGatePending, RoomState } from "./rooms.js";
import type { SanitizeStatus } from "./sanitize.js";
import type { FieldHintOption } from "./settings.js";
import type { UsageLimits } from "./usage.js";

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
  /** Agent-authored, not human-typed: a room agent-dialogue hand-off or a
   * summon callback (see enqueueAgentDialogue). Its `text` is a pointer/replay,
   * not something a person wrote — the client must NOT render it as a queued
   * "user →" ghost bubble. */
  callback?: boolean;
  /** The queued message's user event is ALREADY committed to the transcript
   * (failed-steer fallback) — the committed bubble renders it, so the client
   * must not add a queued ghost on top. */
  recorded?: boolean;
  /** Attachments on a queued message — carried on the chip so the client's
   * queued ghost bubble can render them before the user event commits. */
  attachments?: MessageAttachment[];
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
  defaultRole?: string;
  /** Effective harness id (agent.json's own, else the workspace/global default) —
   * harness-blind consumers just compare this string, never a literal id. */
  harness: string;
  /** Named provider account (a record id in ~/.gaia/accounts.json) this agent is
   * pinned to; absent = the harness's ambient/shared login. Mirrors AgentDef.account. */
  account?: string;
  /** Resolved usage key for this agent's bound or ambient login. */
  usageAccount?: string;
  roles: string[];
  status: "idle" | "running" | "error" | "compacting";
  /** Live compaction progress while status === "compacting"; absent otherwise.
   * The client renders a ticking elapsed from startedAt even when the harness
   * reports no token counts. */
  compact?: CompactProgress;
  isDefault: boolean;
}

/** Token counts a harness reports mid-compaction — the harness-neutral payload
 * carried from the runtime up to the snapshot. A harness that can report
 * nothing simply never sends one; the elapsed timer still works. */
export interface CompactProgressUpdate {
  /** Tokens of context being compacted — the size of the job. */
  contextTokens?: number;
  /** Tokens of summary produced so far. */
  outputTokens?: number;
}

/** Compaction progress as the snapshot carries it: the harness-reported counts
 * plus the daemon-stamped start time (one clock, so the client's elapsed is
 * consistent across agents). */
export interface CompactProgress extends CompactProgressUpdate {
  /** Epoch ms the pass began (daemon clock). */
  startedAt: number;
}

/** What a harness's compact() reports back. `compacted` is the authoritative
 * signal that history was actually evicted into a summary — the daemon marks the
 * visible compact-boundary from THIS boolean, never by scraping `message` prose
 * (message wording varies per harness; a keyword match is a RULE #0 smell and
 * silently drops the marker whenever the wording changes). `compacted:false` is
 * a clean no-op ("nothing to compact — no active session"). A real failure
 * rejects, it does not return here. */
export interface CompactResult {
  compacted: boolean;
  message: string;
  /** The harness's own summary of the evicted history, when it can surface one.
   * gaia persists this per-agent (keyed to the context floor) so a later session
   * loss reloads [summary + tail after floor] instead of raw-from-0 or a thin
   * tail — durable compaction that survives every reset. Optional: a harness that
   * cannot expose its summary omits it, and the shared layer simply stores none
   * (uniform, read as data — never an `=== "claude"` branch). */
  summary?: string;
}

/** The uniform clean no-op above, defined ONCE: every harness returns this when
 * the room has no session to compact (each guards its own live condition — no
 * pi session, unstarted claude room, unattached codex thread). The structured
 * `compacted:false` is authoritative, but keep the "nothing to compact" phrase:
 * the web client's legacy-event fallback (web/src/transcript.js) matches it. */
export const NO_SESSION_TO_COMPACT: CompactResult = {
  compacted: false,
  message: "nothing to compact — no active session for this room.",
};

export interface RoomSummary {
  id: string;
  path: string;
  isCurrent: boolean;
  parentRoomId?: string;
  /** True while an agent turn is streaming in this room — any room, not just
   * summons. Derived from the durable pendingTurn marker, so a background room's
   * dot lights the moment its turn starts and clears when it commits. */
  running?: boolean;
  /** ISO timestamp of the durable pending turn's reservation/start. */
  runningSince?: string;
  title?: string;
  /** Human-pinned room (see RoomState.favorite). */
  favorite?: boolean;
  /** Original created_at of an imported chat (see RoomState.imported). */
  imported?: string;
  /** Incognito room (see RoomState.incognito) — the tab/list marks it so an
   * off-the-record room is obvious wherever it's listed, not just when open. */
  incognito?: boolean;
  /** Last transcript write (epoch ms) — the chat-list sort key, and the client's
   * unread signal: a room whose lastActivity exceeds the last value seen while it
   * was open has an unread agent reply. */
  lastActivity?: number;
}

/** One chat-search result: a transcript chunk that matched, resolved enough to
 * render a preview and jump straight to the message. Matched terms in `snippet`
 * are wrapped in the SEARCH_MARK sentinels (the client escapes then swaps them
 * for <mark>). Workspace-wide search returns hits from many rooms/workspaces. */
export interface ChatSearchHit {
  workspaceId: string;
  workspaceName: string;
  roomId: string;
  roomTitle?: string;
  /** Primary navigation anchor — the first message id in the matched chunk. */
  eventId: string;
  /** Every message id the matched chunk spans (chunks can cross turns). */
  eventIds: string[];
  /** FTS excerpt with matched terms wrapped in the SEARCH_MARK sentinels. */
  snippet: string;
  ts: string;
  speakers: string[];
  score: number;
}

export interface ChatSearchResult {
  hits: ChatSearchHit[];
  /** Loud degradation notes (index catch-up budget hit, workspace unloadable). */
  degraded: string[];
}

/** One native desktop pet window. Bindings are durable in each room's
 * RoomState; workspaceId/roomId are added when the daemon snapshots them for
 * the shell. */
export interface PetBinding {
  workspaceId: string;
  roomId: string;
  agentId: string;
  package: string;
}

export type PetProgressStatus = "thinking" | "tool" | "working" | "done" | "failed";

export interface PetProgress {
  workspaceId: string;
  roomId: string;
  agentId: string;
  taskId: string;
  status: PetProgressStatus;
  /** Present only while status === "tool"; this is the shared AgentEvent's
   * toolName, never a harness-specific label. */
  toolName?: string;
}

export interface SlashCommandDefinition {
  name: string;
  type: string;
  description: string;
  aliases?: string[];
  /** A harness-native passthrough command (advertised by a harness, not a gaia
   * command): typing it routes a command turn to the active agent instead of
   * being parsed by gaia. Drives autocomplete hints. */
  native?: boolean;
}

/** One field in a room-local plugin popup's form. Mirrors
 * services/plugins.ts's PluginPanelField — kept as its own named export so
 * the web client's JSDoc typedefs (web/src/types.js) can reference it. */
export interface SnapshotPluginPanelField {
  name: string;
  label: string;
  type: "text" | "select";
  value?: string;
  options?: Array<{ value: string; label: string }>;
}

/** A room-local plugin's declarative popup. Mirrors services/plugins.ts's
 * PluginPanel: forms/items only — no iframe embed. Rendered as a transient,
 * theme-inheriting overlay dialog (web/src/plugins-panel.js), present only
 * while the plugin's own state says it's open. */
export interface SnapshotPluginPanel {
  title: string;
  description?: string;
  forms?: Array<{ action: string; label: string; fields: SnapshotPluginPanelField[] }>;
  items?: Array<{ title: string; detail?: string; actions?: Array<{ action: string; label: string; args?: string[]; danger?: boolean }> }>;
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
    /** Exact account-usage keys currently eligible to spend in this room. */
    usageAccounts?: string[];
    /** Room agent-dialogue toggle (agents replying to each other's @mentions). */
    agentDialogue?: boolean;
    /** Native desktop pet bindings for this room, keyed by agent. Empty/absent
     * means pets are off. Browser/iOS clients do not render an in-chat stand-in. */
    petBindings?: Record<string, string>;
    /** Declarative room panels supplied by local command plugins. */
    pluginPanels?: Record<string, SnapshotPluginPanel>;
    /** Incognito room: no memory capture, no auto-recall, not indexed for recall,
     * memory/recall tools stripped. Immutable; drives the client's indicator. */
    incognito?: boolean;
    /** Ambient watchdog (e.g. /ultrawhip) is active — a generic, plugin-driven
     * toggle read fresh every tool call (see room-service.ts's
     * readAmbientWatchdog), global to whichever turn is running, in any room.
     * Surfaced here so the client can pin a live indicator while it's on. */
    ambientWatchdog?: { toolCalls: number; label?: string };
    /** The running turn's accumulated view, so a client (re)subscribing mid-turn
     * (e.g. switching back to a busy room) renders it at once. Absent when idle. */
    liveTurn?: LiveTurn;
  };
  rooms: RoomSummary[];
  commands: SlashCommandDefinition[];
  agents: AgentStatus[];
  tasks: Task[];
  backgroundTasks: BackgroundTask[];
  thinkingLevels: string[];
  /** Memory-subsystem degradation chips ("embedder dead", "index degraded") —
   * absent/empty when healthy. Degradation is loud (MEMORY-DESIGN.md §10):
   * the composer renders these like the model-fallback warning. */
  memoryChips?: string[];
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
  | ({ type: "skill-invocation"; skill: SkillInvocation } & StreamScope)
  | ({ type: "tool-start"; toolName: string; toolCallId?: string; args?: unknown } & StreamScope)
  | ({ type: "tool-update"; toolName: string; toolCallId?: string; partialResult?: unknown } & StreamScope)
  | ({ type: "tool-end"; toolName: string; toolCallId?: string; result?: unknown; isError: boolean } & StreamScope)
  // A mid-turn steer landed at this point of the reply's stream. `steerEventId`
  // is the steer's user RoomEvent (scope.eventId is, as always, the REPLY's).
  | ({ type: "steered"; steerEventId: string } & StreamScope)
  // pi ExtensionAPI surface (see core/types/harness.ts AgentEvent doc comments
  // for the full ui.widget/ui.prompt/ui.shortcut/auth.request/ext.lifecycle
  // vocabulary) — identical shape, just scoped to the emitting agent+turn so the
  // client knows which composer/agent a reply or shortcut fire targets.
  | ({ type: "ui.widget"; id: string; placement: "aboveEditor" | "belowEditor"; lines: string[] } & StreamScope)
  | ({ type: "ui.prompt"; id: string; kind: "input" | "select" | "confirm" | "editor"; title: string; message?: string; fields?: UiPromptField[] } & StreamScope)
  | ({ type: "ui.shortcut"; commandId: string; key: string; description?: string } & StreamScope)
  | ({ type: "auth.request"; id: string; providerId: string; method: "oauth" | "apiKey" | "device"; url?: string; instructions?: string; deviceCode?: UiDeviceCodeInfo; fields?: UiPromptField[] } & StreamScope)
  | ({ type: "ext.lifecycle"; id: string; state: "loaded" | "failed" | "disposed"; reason?: string } & StreamScope)
  | { type: "settings-saved"; workspaceId?: string; roomId?: string; fileId: string }
  | { type: "voice-status"; workspaceId: string; roomId: string; voice: VoiceCallInfo | null; pending?: { agentId: string; message: string } }
  // Workspace-TAGGED, globally DELIVERED (NO roomId): the room list of the named
  // workspace changed — a room started or finished a turn, or its activity
  // advanced. The workspaceId only says WHICH workspace this describes; the
  // fan-out sends it to EVERY connected client (not just those viewing that
  // workspace) so a sidebar can update both the open workspace's room tree AND
  // the running/unread dots rolled up onto every OTHER workspace in the list.
  | { type: "rooms"; workspaceId: string; rooms: RoomSummary[] }
  // Workspace-wide native-pet control plane. Both are globally DELIVERED by
  // the SSE server (not selected-room scoped): the shell must keep windows for
  // bindings in background rooms alive and track their agents' live progress.
  | { type: "pet-bindings"; workspaceId: string; bindings: PetBinding[] }
  | ({ type: "pet-progress" } & PetProgress)
  // Daemon-global (NO workspaceId → fans out to EVERY connected client): one
  // subscription account's usage limits refreshed. Usage is account-level, not
  // per-workspace/room. `usage: null` clears that account's meter (every
  // credential source authoritatively reports signed out / API-key auth).
  | { type: "usage-limits"; account: string; usage: UsageLimits | null };

