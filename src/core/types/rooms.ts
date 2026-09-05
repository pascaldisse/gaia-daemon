import type { EventDetails, MessageAttachment, RoomEvent } from "./events.js";
import type { BackgroundTask } from "./harness.js";
import type { MonadConfig } from "./monad.js";

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
  /** Identity of the pinned goal that owns this turn. Preserved through WAL
   * resume so only goal-authored turns can advance or continue that goal. */
  goalStartedAt?: string;
  startedAt: string;
  /** This in-flight turn is a monad dispatch: boot resume must re-dispatch it
   * through the monad engine (targets omitted so routing re-derives from
   * state.monad), never as a plain single-agent turn. */
  monad?: boolean;
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
  /** Identity of the pinned goal that created this synthetic queue entry.
   * Drain drops it when that goal was paused, cleared, completed, or replaced. */
  goalStartedAt?: string;
  /** A harness-native command (e.g. "/deep-research …") that queued behind a
   * busy turn — drain must run it as a command turn to its pinned target, not
   * re-parse it as a slash command (which would just error). */
  nativeCommand?: boolean;
  /** A command-plugin verb rewritten into a message turn before queueing (see
   * RoomService's SendMessageOptions.pluginMessageTurn / PluginResult.
   * rewriteAsMessage) — drain must NOT re-parse this text as a slash command,
   * which would re-run the plugin's state mutation a second time and misroute
   * it back through the command-reply path. */
  pluginMessageTurn?: boolean;
  queuedAt: string;
  /** The user event id pre-assigned to this message. Set durably BEFORE the
   * transcript append so the queue→transcript hand-off is crash-idempotent:
   * the turn appends with THIS id and skips the append when it already made it
   * to disk. Also set (with `recorded`) when a failed steer-by-default already
   * committed the event before falling back to the queue. */
  eventId?: string;
  /** The user event behind this entry is ALREADY committed to the transcript
   * (failed-steer fallback persisted it before enqueueing) — the drained turn
   * must not append it again, and the client renders the committed bubble
   * instead of a queued ghost. */
  recorded?: boolean;
  /** This entry is the ONE automatic retry of a turn RunnerHost's hard stall
   * deadline aborted (UpstreamStallError — src/harness/host.ts) after the
   * harness reported an upstream stall and never recovered. Drain must not
   * re-record the user message (it's already on the transcript from the
   * original run) and a SECOND stall on this retry must not requeue again —
   * a dead upstream must not keep a retry loop alive forever. */
  stallRetried?: boolean;
  /** Number of transient-auth retries already attempted for this message. */
  authRetries?: number;
  /** Earliest ISO timestamp at which drain may dispatch this entry. */
  notBefore?: string;
  /** Logged-in human who sent this (domain/users.ts) — see UserRoomEvent.humanId. */
  humanId?: string;
  humanLabel?: string;
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
  /** Fix #1 (resume-completion tracking, gaia-daemon-triage/FIX-DESIGN.md):
   * durable record for the MOST RECENT `gaia resume` into this ALREADY-
   * delivered summon child. Stamped BEFORE the resumed turn is kicked off —
   * the SAME "stamp before it can run" ordering as `status` above (see
   * SummonCoordinator.resume) — so a daemon crash mid-resume is recoverable
   * at next boot (recoverUndelivered rescans this field too, RC4).
   * Independent of `status`: a summon's first-turn delivery can already read
   * "delivered" while resumeStatus is "running" for a LATER resumed turn.
   * Absent = no resume has ever been tracked for this child. */
  resumeStatus?: "running" | "delivered";
  /** ISO timestamp of the most recent resume's stamp (see resumeStatus). */
  resumeStartedAt?: string;
}

/** Marker an agent must emit VERBATIM (own line, or anywhere in the reply) to
 * declare a room goal finished. Strict by design: no marker → the goal is NOT
 * complete and the loop continues. Never infer completion from prose. */
export const GOAL_COMPLETE_SIGNAL = "GOAL-COMPLETE";

/** A room-pinned autonomous objective (`/goal`). Shared daemon state — no
 * harness knows it exists: continuations ride the ordinary durable queue, so
 * every harness (present + future) drives a goal identically.
 * Durable in state.json; a restart resumes from it. */
export interface RoomGoal {
  /** What the room is working toward, verbatim from `/goal <objective>`. */
  objective: string;
  /** Agent the goal is pinned to (the room's target when it was set). */
  agentId: string;
  /** "active" = continuations enqueue after each turn; "paused" = held (state
   * kept, nothing enqueued); "done" = the agent emitted GOAL_COMPLETE_SIGNAL. */
  status: "active" | "paused" | "done";
  /** Optional token ceiling (`--tokens N`). Reaching it pauses the goal. */
  tokenBudget?: number;
  /** Tokens attributed to goal turns so far (harness-uniform context-usage
   * accounting — an approximation, not a billing figure). */
  tokensUsed: number;
  /** Continuation turns run for this goal. */
  iterations: number;
  startedAt: string;
  updatedAt: string;
  /** Why the goal stopped continuing (budget exhausted, completed, …). */
  stoppedReason?: string;
}

export interface RoomAutoCompactState {
/** Per-room overrides; absent fields inherit WorkspaceConfig.autoCompact. */
thresholdPct?: number | null;
cooldownTurns?: number;
/** Durable next-turn passes, keyed by agent. */
pending?: Record<string, number>;
/** Remaining completed turns that cannot schedule another pass. */
cooldowns?: Record<string, number>;
}

export interface RoomState {
  activeRoles: Record<string, string>;
  /** Room-pinned autonomous objective (see RoomGoal). Absent = no goal. */
  goal?: RoomGoal;
  /** Room-scoped Codex-pet bindings, keyed by agent id. Absence means pets are
   * off. Each entry binds exactly this room + that agent to one validated pet
   * package; several agents may be bound at once. */
  petBindings?: Record<string, string>;
  /** Opaque JSON state owned by local command plugins. Plugin code never writes
   * state.json directly; RoomHandle remains the sole serialized writer. */
  pluginState?: Record<string, Record<string, unknown>>;
  /** Per-agent room-scoped thinking-level override (mirrors activeRoles):
   * room entry wins; absent inherits the agent.json global default
   * (agent.thinking). Never written to agent.json. */
  thinkingOverrides: Record<string, string>;
  /** Room-wide GAIA-THINK protocol level (0-10), set via `/thinking N`.
   * Distinct from thinkingOverrides (per-agent SDK reasoning effort): this is
   * a single room value driving the `# Protocols` section's thinking line for
   * ALL agents. Absent/0 = thought blocks disabled. */
  thinkingLevel?: number;
  /** Agents that gracefully ended this room conversation. Automatic work aimed
   * at one stays suppressed until a human addresses that agent again. */
  conversationEndedAgents?: Record<string, string>;
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
  /** This summon child room runs under the untrusted tier: its launching caller
   * was untrusted (or its parent room already carried the tier), so every turn
   * here resolves its sandbox with effectiveTrust(agent, true) — forced real
   * backend — and summons launched from here inherit the tier. Stamped ONCE at
   * launch by the summon coordinator, derived data never config: absence means
   * trusted, and no workspace/agent setting can clear it. */
  summonUntrusted?: true;
  /** Absolute path this room's turns use as their working directory (OS cwd +
   * sandbox cwd) when it is NOT the workspace root (collab.isolation
   * "worktree"). A top-level room OWNS this git worktree, stamped on first
   * open; a summon room INHERITS the nearest ancestor's, stamped once at
   * summon launch. `.gaia/` is always addressed via the root (the runner
   * child reads GAIA_RUNNER_WORKSPACE, never cwd), so a moved workDir never
   * strands the room's transcript/state/memory. Validated against the
   * filesystem on read: a vanished worktree degrades to the root instead of
   * wedging the spawn. */
  workDir?: string;
  /** Display name when the room id alone isn't it (e.g. an imported chat's
   * original title). */
  title?: string;
  /** Provenance for mutable titles. Manual wins forever; auto/model titles may
   * be refined only while they are still machine-owned. Absent covers legacy
   * imported titles and old state files. */
  titleSource?: "auto" | "model" | "manual";
  /** Pinned by the human for quick filtering in the room list. Display-only
   * room metadata, like title: the room id/path stay stable. */
  favorite?: boolean;
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
/** Per-room auto-compact overrides and durable scheduling state. */
autoCompact?: RoomAutoCompactState;
  /** Harness-native shells that detached into the background during a turn.
   * These are start records only: the harness exposes no reliable exit marker,
   * so consumers must not infer liveness from their presence. */
  backgroundTasks?: BackgroundTask[];
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
  /** Incognito room: this room is invisible to long-term memory. No episodes
   * are captured from its turns, no auto-recall is injected into its agents,
   * its transcript is never indexed for recall, and the memory/recall tools are
   * stripped from its agents' vocabulary. Set ONCE at creation and immutable
   * (a room is incognito or it isn't) — normalizeRoomState preserves it, and
   * ensureWorkspaceRoom only seeds it on a brand-new room. Off/absent = a normal
   * room that participates in memory. */
  incognito?: boolean;
  /** Human-membership allowlist (domain/users.ts ids).
   * Absent → legacy open room; present → only listed humans; [] → deny all.
   * Last-member removal preserves [] rather than reopening prior content. */
  humans?: string[];
  /** DogMode (09-DOG-MODE, and every other multi-command persona-register
   * style plugin) durable state now lives generically in `pluginState` above,
   * keyed by the plugin's id (services/plugins.ts pluginStateKey) — e.g.
   * `pluginState.dog`. Core has no dedicated field or type for it; the
   * plugin owns its own shape and validation (see plugins/defaults/dog-mode.mjs
   * normalizeState). */
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

