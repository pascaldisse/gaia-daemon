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

/** One segment of an agent turn in the order it actually streamed. The harness
 * event stream interleaves prose, thinking, and tool calls (text → tool →
 * text → thinking → …); `MessageBlock[]` preserves that order so the UI renders
 * inline like a native agent transcript instead of the flattened
 * thinking→tools→text buckets. `text`/`thinking` carry their span inline;
 * `tool` references a `ToolDetail` in `EventDetails.tools[]` by id (the tool's
 * live status/args/result stay the single source of truth). Thinking can occur
 * more than once per turn, so multiple `thinking` blocks are expected. */
export type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string };

/** Runtime metadata for one agent message. v2 stores this ON the transcript
 * event at commit, so history never forgets what produced it. (v1 kept a
 * 50-entry LRU in state.json; those legacy entries are still read.) */
export interface EventDetails {
  model?: string;
  modelFallback?: ModelFallback;
  thinkingStarted?: boolean;
  thinking?: string;
  tools?: ToolDetail[];
  /** The turn's segments in stream order (see `MessageBlock`). Additive and
   * v1-compatible: events committed before this field existed have no `blocks`,
   * and the UI falls back to the bucketed thinking→tools→text layout. `thinking`
   * and `tools` above are still populated in full so non-ordered consumers
   * (prompt replay, read-aloud, summaries) are unaffected. */
  blocks?: MessageBlock[];
  /** This agent event is a summon worker's result landed back in the parent
   * room (see SummonDelivery). The UI renders it as a COLLAPSED, summon-labeled
   * block reusing the thinking/tool expander — not a plain agent message and
   * never a "user →" bubble. Absent on ordinary turns. */
  summonResult?: SummonResultMeta;
}

/** Provenance carried on a summon worker's result note so the UI can render a
 * collapsed "↩︎ summon <room> finished / ⚠️ FAILED" header without baking it
 * into the message text. */
export interface SummonResultMeta {
  /** The child (worker) room whose turn produced this result — open it to
   * inspect the full run. */
  childRoomId: string;
  /** The worker turn errored (vs. finished cleanly). */
  failed: boolean;
}

/** The in-flight agent reply's accumulated view, mirrored on the snapshot so a
 * client that (re)subscribes mid-turn — e.g. after switching rooms — renders the
 * running turn immediately (text + thinking + tools so far) instead of a blank
 * until it commits. Ephemeral in-memory only: present while a turn streams,
 * cleared on commit/failure/cancel. Durability of the reply text is separate
 * (PendingTurn.partialReply on disk). Keyed by the reserved commit `eventId`, so
 * the moment the room-event with that id lands, the client drops this. */
export interface LiveTurn {
  eventId: string;
  taskId: string;
  agentId: string;
  startedAt: string;
  text: string;
  details: EventDetails;
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

export type RoomEventKind = "compact-complete";

export interface AgentRoomEvent {
  id: string;
  timestamp: string;
  author: string; // agent id
  text: string;
  /** Optional persisted rendering discriminator for system/special transcript rows. */
  kind?: RoomEventKind;
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
  /** A harness-native command (e.g. "/deep-research …") that queued behind a
   * busy turn — drain must run it as a command turn to its pinned target, not
   * re-parse it as a slash command (which would just error). */
  nativeCommand?: boolean;
  queuedAt: string;
}

/** Durable record on a summon CHILD room: how its result gets back to the
 * parent room. Stamped at launch, marked "delivered" only after the callback
 * landed — a daemon restart re-arms delivery from this record (the summon
 * coordinator's boot sweep), so a summon result is never silently lost. */
export interface SummonDelivery {
  /** The summoned worker agent (authors the result message in the parent). */
  agentId: string;
  /** "note": result appended to the parent room; "turn": the note plus a
   * queued turn for callerAgentId — the subagent callback. */
  deliver: "note" | "turn";
  /** Parent-room agent re-invoked with the result (deliver: "turn"). */
  callerAgentId?: string;
  status: "running" | "delivered";
  launchedAt: string;
}

export interface RoomState {
  activeRoles: Record<string, string>;
  agentCursors: Record<string, number>;
  /** Per-agent active-context floor: the transcript line index below which
   * content is NOT in the agent's live context (never loaded via a context-gate
   * choice, or evicted by /compact). Recall's self-match exclusion (CALMem,
   * MEMORY-DESIGN.md §7) drops same-room hits AT/ABOVE the floor and keeps
   * everything below it — compacted-away history must stay recallable.
   * Absent = 0 = the whole room is in the agent's context. */
  contextFloors?: Record<string, number>;
  /** Legacy v1 per-event details, read-only in v2 (new details go on the
   * transcript event itself). Preserved so old rooms keep their metadata. */
  runtimeDetails?: Record<string, EventDetails>;
  parentRoomId?: string;
  /** Present on summon child rooms whose result must reach the parent room;
   * see SummonDelivery. */
  summon?: SummonDelivery;
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
  /** The original text this edit replaces. For a `whole`-message rewrite this
   *  is the entire event text; for a span edit it is the exact substring. */
  quote: string;
  replacement: string;
  reason: string;
  /** True when `quote` is the WHOLE message and `replacement` rewrites it end
   *  to end — the aggressive default, so no residual trigger word survives a
   *  surgical span-swap. The apply path is identical (quote→replacement); this
   *  only tells the UI to render it as a full-message rewrite. */
  whole?: boolean;
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
  /** Deep-path reranker (local-only; "auto" = managed sidecar or GAIA_RERANK_URL). */
  reranker: "auto" | "off";
  consolidate: MemoryConsolidateConfig;
  decayHalfLifeDays: number;
}

export interface MemoryConfigPatch {
  autoRecall?: boolean;
  autoRecallBudget?: number;
  embeddings?: MemoryConfig["embeddings"];
  reranker?: MemoryConfig["reranker"];
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
  /** Opt in to harness-native slash commands (claude skills like
   * `/deep-research`): an unrecognized `/command` is passed through to this
   * agent's harness CLI verbatim instead of erroring. Off by default — it drops
   * the harness's config isolation for that turn (claude runs with its skill
   * surface enabled), so it's a knowing choice like revealThinking. Toggle with
   * `/native`. Only harnesses that declare `supportsNativeCommands` honor it. */
  nativeCommands?: boolean;
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
// Account usage limits (a harness's subscription/rate caps — NOT per-room
// context). Harness-agnostic: every harness that can report account usage maps
// its provider's shape onto this one shape; the daemon polls each spec's
// probeUsage() and the status bar renders the result uniformly, never learning
// which harness produced it. The same standing applies to every room/agent on
// that harness, so this is broadcast daemon-global, not per-room.

export interface UsageWindow {
  /** Stable window id, e.g. "session" | "weekly_all" | "weekly_scoped". Only
   * used to key/order; display uses `label`. */
  kind: string;
  /** Human label, e.g. "Current session", "Weekly · all models", "Weekly · Fable". */
  label: string;
  /** Percent of the cap consumed, 0–100 (clamped). */
  percent: number;
  /** How close to the cap — drives the status-bar colour. */
  severity: "normal" | "warning" | "critical";
  /** ISO 8601 instant the window resets, when the harness reports one. */
  resetsAt?: string;
  /** For a model-scoped window (e.g. a per-model weekly cap), the model it
   * applies to, as the provider names it (e.g. "Fable"). Absent on account-wide
   * windows (session, all-models weekly). The status bar shows a scoped window
   * only when its model is the active one in the open room. */
  model?: string;
}

export interface UsageLimits {
  /** Which harness reported this (display + client keying; never a branch). */
  harness: string;
  /** Optional plan/account label, e.g. the subscription tier. */
  plan?: string;
  /** Windows to show, most-relevant first. */
  windows: UsageWindow[];
  /** ISO 8601 instant this snapshot was fetched. */
  fetchedAt: string;
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
  /** Agent-authored, not human-typed: a room agent-dialogue hand-off or a
   * summon callback (see enqueueAgentDialogue). Its `text` is a pointer/replay,
   * not something a person wrote — the client must NOT render it as a queued
   * "user →" ghost bubble. */
  callback?: boolean;
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
}

export interface RoomSummary {
  id: string;
  path: string;
  isCurrent: boolean;
  parentRoomId?: string;
  /** True while an agent turn is streaming in this room — any room, not just
   * summons. Derived from the durable pendingTurn marker, so a background room's
   * dot lights the moment its turn starts and clears when it commits. */
  running?: boolean;
  title?: string;
  /** Original created_at of an imported chat (see RoomState.imported). */
  imported?: string;
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
    /** The running turn's accumulated view, so a client (re)subscribing mid-turn
     * (e.g. switching back to a busy room) renders it at once. Absent when idle. */
    liveTurn?: LiveTurn;
  };
  rooms: RoomSummary[];
  commands: SlashCommandDefinition[];
  agents: AgentStatus[];
  tasks: Task[];
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
  | ({ type: "tool-start"; toolName: string; toolCallId?: string; args?: unknown } & StreamScope)
  | ({ type: "tool-update"; toolName: string; toolCallId?: string; partialResult?: unknown } & StreamScope)
  | ({ type: "tool-end"; toolName: string; toolCallId?: string; result?: unknown; isError: boolean } & StreamScope)
  | { type: "settings-saved"; workspaceId?: string; roomId?: string; fileId: string }
  | { type: "voice-status"; workspaceId: string; roomId: string; voice: VoiceCallInfo | null; pending?: { agentId: string; message: string } }
  // Workspace-scoped (NO roomId): the room list changed — a room started or
  // finished a turn, or its activity advanced. Fans out to EVERY client in the
  // workspace so a sidebar updates a room's running dot / unread badge even when
  // that room isn't the one being viewed (the per-room SSE only carries the open
  // room's own events).
  | { type: "rooms"; workspaceId: string; rooms: RoomSummary[] }
  // Daemon-global (NO workspaceId → fans out to EVERY connected client): one
  // harness's account usage limits refreshed. Usage is account-level, not
  // per-workspace/room. `usage: null` clears that harness's chip (probe failed,
  // signed out, or API-key auth with no subscription caps).
  | { type: "usage-limits"; harness: string; usage: UsageLimits | null };

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
