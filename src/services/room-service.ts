// RoomService — one per (workspace, room). The v1 GaiaController's eleven jobs,
// redistributed: parsing lives in commands.ts, turn streaming in turns.ts,
// summon policy in summons.ts, monad in monad.ts, durability in RoomHandle's
// WAL protocol. What remains here is orchestration: task lifecycle, the durable
// queue, and the command handler registry.
//
// Durability differences from v1 (each closes a real hole):
// - Queued messages persist in state.queue and re-drain on boot (v1 held them
//   in a private array; a crash ate them).
// - A turn's transcript event id is reserved BEFORE streaming; commit is
//   append-then-one-state-write, and resume can tell "committed but not
//   acknowledged" from "needs re-run" (v1 could double-run that window).
// - Runtime details commit onto the transcript event itself (v1 kept a
//   50-entry LRU side-table: metadata amnesia by design).

import { readFileSync } from "node:fs";
import { appendFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { attachmentMime, sanitizeAttachmentName } from "../core/attachments.js";
import { Bus } from "../core/bus.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import { globalPaths } from "../core/paths.js";
import type { SanitizeProposal, SanitizeStatus } from "../core/types.js";
import type {
  AgentDef,
  AgentEvent,
  AgentStatus,
  CompactProgress,
  CompactProgressUpdate,
  CompactResult,
  ContextGatePending,
  EventDetails,
  LiveTurn,
  MessageAttachment,
  ModelFallback,
  PendingTurn,
  PetProgressStatus,
  QueuedMessage,
  RoomEvent,
  RoomEventKind,
  Snapshot,
  Task,
  UiEvent,
  Workspace,
} from "../core/types.js";
import { DEFAULTS, DEFAULT_CONTEXT_WARN_TOKENS } from "../core/config.js";
import type { RenderCap } from "../domain/render-cap.js";
import { estimateTokens } from "../core/tokens.js";
import { deriveRoomTitle, isAutoRoomId, newRoomEventId, normalizeRoomState, normalizeRoomTitle, RoomHandle } from "../domain/rooms.js";
import { DEFAULT_PET_NAME, listWorkspacePetBindings, loadPet } from "../domain/pets.js";
import { resolveRoomWorkDir } from "../domain/worktree.js";
import { effectiveAgentTools } from "../domain/roles.js";
import type { MemoryStore, MemoryAction, MemoryMutationResult } from "../domain/memory.js";
import { formatMemoryHits, type ActiveContextRef, type MemorySearchHit } from "../domain/workspace-index.js";
import type { AgentRuntime, HarnessHost } from "../harness/spec.js";
import { capabilitiesFor, contextWindowFor, findHarness, harnessIdFor, usageAccountFor } from "../harness/spec.js";
import { readOptional, renderAttachmentLines, renderRoomTranscript } from "../harness/prompt.js";
import { readUserNameSetting } from "./user-name.js";
import { HELP_TEXT, hasExplicitMention, parseCommand, planMentionRoute, type SlashCommand } from "./commands.js";
import { loadCommandPlugins, pluginStateKey, type CommandPlugin, type CommandPluginRegistry, type PluginContext, type PluginPanel, type PluginResult } from "./plugins.js";
import type { PluginTurnBoundary } from "./plugins/registry.js";
import { SANITIZE_REVIEWER_ID, buildSanitizePrompt, parseSanitizeProposal, type SanitizeContext } from "./sanitize.js";
import { applyEventToDetails, finalizeInterruptedTools, runAgentTurn } from "./turns.js";
import { ContextPolicyStore } from "./context-policy-store.js";
import { DEFAULT_CONTEXT_DIET_POLICY } from "../domain/context-diet.js";
import type { EpisodeCapture } from "./memory-service.js";
import { formatDreamProposal } from "./consolidate.js";
import type { ConsolidateLlm, ConsolidateResult } from "./consolidate.js";
import { allowSummonForTurn, effectiveTrust, type SummonHost } from "./summons.js";
import { HOOK_TEXT_CAP, runHooks, type HookEvent } from "./hooks.js";
import { createAgentRuntime } from "../harness/host.js";
import { configuredModelLabel } from "../harness/model-label.js";
import { resolveSandboxPolicy } from "../harness/sandbox/spec.js";
import { sttEngineIds } from "./transcribe.js";
import { RoomFork } from "./room/fork.js";
import { configureRoomServiceReload, runCommand as executeCommand, runReloadCommand, runSttCommand } from "./room/command-execution.js";
export { configureRoomServiceReload } from "./room/command-execution.js";
import { installRoomTaskOperations, RoomTaskOperationsMixin } from "./room/task-operations.js";
import { installRoomMonadExecution, RoomMonadExecutionMixin } from "./room/monad-execution.js";
import type { RoomTaskOperationsPort } from "./room/ports.js";
import { buildRoomRuntimes, resolveRoomOpen, RoomLifecycle } from "./room/lifecycle.js";
import type { RoomLifecyclePort } from "./room/ports.js";
import { RoomTurnResults } from "./room/turn-results.js";
import { installRoomAgentCommands, RoomAgentCommandsMixin } from "./room/agent-commands.js";
import { RoomQueue } from "./room/queue.js";
import { installRoomCommands, RoomCommandsMixin } from "./room/commands-facade.js";
import { installRoomSanitize, RoomSanitizeMixin } from "./room/sanitize-facade.js";
import { installRoomUi, RoomUiMixin } from "./room/ui.js";
import { installRoomSnapshot, RoomSnapshotMixin } from "./room/snapshot.js";
export { readAmbientWatchdog, scanRoomActivity, writeRoomOrder } from "./room/snapshot.js";
import { installRoomSummonLifecycle, RoomSummonLifecycleMixin } from "./room/summon-lifecycle.js";
export { AGENT_DIALOGUE_MAX_HOPS } from "./room/summon-lifecycle.js";
import { readVoiceSettings } from "./voice.js";
import { BackgroundTasks } from "./room/background-tasks.js";
import { installRoomMaintenance, RoomMaintenanceMixin } from "./room/maintenance.js";
import type { RoomMaintenancePort } from "./room/ports.js";

export interface RoomServiceOptions {
  workspaceId: string;
  workspace: Workspace;
  roomId?: string;
  /** This room is incognito (RoomState.incognito) — invisible to long-term
   * memory. Read once at open (the flag is immutable) and threaded here so the
   * constructor can strip the memory/recall tools before any runtime is built,
   * and the turn path can skip capture + auto-recall. */
  incognito?: boolean;
  /** Workspace-scoped store shared by every room service (single writer). */
  memoryStore: MemoryStore;
  runtimeFactory?: (agent: AgentDef) => AgentRuntime;
  /** Host-provided thinking setter (scopes to an active voice call first). */
  setThinking?: (agentId: string, level: string) => Promise<string>;
  harnessHost?: (options: { allowSummon: boolean }) => HarnessHost;
  summonHost?: SummonHost;
  /** Memory v3 hooks (auto-recall, episodic capture, consolidation). Absent →
   * turns run exactly as before; the hooks are additive. */
  memory?: RoomMemoryHooks;
  /** One-shot LLM call (same caller consolidation uses) for the context-gate
   * "compact" option — summarizes the room to seed a new agent. Absent → the
   * compact choice degrades to a raw transcript slice. */
  llm?: ConsolidateLlm;
  /** Workspace-scoped scheduler surface backing /schedule. */
  scheduler?: RoomSchedulerHooks;
  /** Daemon's settings-change reload (applySettingsChange): commands that
   * rewrite agent.json (/model, /thinking) fire this so every resident room
   * service rebuilds and the next turn spawns a runner that reads the new
   * config — runners snapshot agent.json at spawn, so an in-place mutation
   * alone never reaches a live subprocess. */
  settingsChanged?: (scope: "global" | "workspace") => Promise<void>;
  /** Test seam around the real safe Codex package loader. Production omits it. */
  petLoader?: (name: string) => Promise<unknown>;
  /** Manifest-plugin generations shared by the daemon; legacy command plugins remain unchanged. */
  pluginRegistry?: PluginTurnBoundary & CommandPluginRegistry;
}

/** What /schedule needs from the scheduler (daemon-provided, workspace-bound). */
export interface RoomSchedulerHooks {
  list(): Promise<string>;
  runNow(jobId: string): Promise<string>;
}

/** The narrow slice of MemoryService a room needs (kept as an interface so
 * tests can fake it and the room never learns about embeddings/LLMs). */
export interface RoomMemoryHooks {
  /** `context` is the asking agent's active window — same-room hits inside it
   * are self-matches and excluded (MEMORY-DESIGN.md §7). */
  autoRecallBlock(agentId: string, query: string, context?: ActiveContextRef): Promise<string>;
  capture(agentId: string, capture: EpisodeCapture): Promise<void>;
  consolidate(agentId: string, options?: { force?: boolean; propose?: boolean }): Promise<ConsolidateResult>;
  /** Dream v2 apply: commits a standing dream-proposal.json (backs `/dream
   * [agent] --apply`, mirrors the CLI/harness route). null = no proposal
   * pending. */
  applyDreamProposal?(agentId: string): Promise<{ applied: number; skipped: number } | null>;
  /** Ranked search over facts, episodes, and room history — backs /recall.
   * `degraded` notes are rendered, never dropped (§10). */
  search(agentId: string, query: string, request?: { limit?: number; context?: ActiveContextRef }): Promise<{ hits: MemorySearchHit[]; degraded: string[] }>;
  /** Deep-path variant (§8: reranked, chunk-window expanded) — explicit
   * invocations (/recall) prefer it; absent → search. */
  deepSearch?(agentId: string, query: string, request?: { limit?: number; context?: ActiveContextRef }): Promise<{ hits: MemorySearchHit[]; degraded: string[] }>;
  /** Composer chips when the memory subsystem is degraded ([] = healthy). */
  healthChips?(): Promise<string[]>;
}

export interface SendMessageOptions {
  targets?: string[];
  /** Force the durable queue instead of steering the running turn (the
   * Cmd/Ctrl+Enter shortcut). Steer-by-default otherwise injects a message
   * aimed at the busy agent into its live turn. */
  queue?: boolean;
  channel?: "text" | "voice";
  /** Synthetic prompts (call greetings, silence nudges) skip the user event. */
  recordUserMessage?: boolean;
  /** Logged-in human posting this (domain/users.ts) — rides the RoomEvent as
   * humanId/humanLabel for multi-human attribution. Absent = today's default
   * single-implicit-user behavior, unchanged. */
  human?: { id: string; label: string };
  thinking?: string;
  /** Files attached to the message (already stored in the room's files dir). */
  attachments?: MessageAttachment[];
  /** This turn was produced by room agent-dialogue (one agent addressing
   * another), not a human — it doesn't reset the dialogue hop count. */
  fromAgentDialogue?: boolean;
  /** Internal identity for a resumed pinned-goal turn. Ordinary user and agent
   * dialogue turns never carry it and therefore cannot advance a goal. */
  goalStartedAt?: string;
  // --- context-gate resume knobs (set only when replaying a held turn) --------
  /** Force this target's starting cursor (last-N loads a tail; compact loads
   * nothing raw). Also signals "already decided" so the gate never re-triggers. */
  cursorOverride?: number;
  /** One-shot turn-level context overlay (the compact summary) — injected in the
   * recall slot for this turn only, never part of the session. */
  recallOverride?: string;
  /** Skip the context-gate check for this run (the resumed turn already chose). */
  bypassContextGate?: boolean;
  /** This turn is a harness-native command (e.g. "/deep-research …") routed to
   * the active agent: the runtime runs it as a raw command, and monad routing is
   * bypassed. Set by sendMessage's native-passthrough detection. */
  nativeCommand?: boolean;
  /** This turn is a command-plugin verb rewritten into a message
   * (PluginResult.rewriteAsMessage — see services/plugins.ts) — targets are
   * already pinned explicitly, so this ONLY needs to survive onto the durable
   * queue entry (QueuedMessage.pluginMessageTurn) to tell drain() to skip
   * re-parsing the queued text as a slash command a second time (which would
   * re-run the plugin's state mutation a second time and misroute it back
   * through the command-reply path). Never reaches the harness — unlike
   * nativeCommand, it carries no special prompt-building behavior. */
  pluginMessageTurn?: boolean;
  /** Set by drain(): the durable queue entry this turn consumes. The entry
   * stays queued until the turn's first durable record replaces it (the
   * two-phase hand-off — see RoomHandle.peekQueue). */
  queued?: QueuedMessage;
}

/** Min gap between durable partial-reply flushes during a streaming turn. */
export const PARTIAL_FLUSH_MS = 1000;
/** Render the reason carried by the uniform runtime/channel failure contract. */
function turnEndReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.trim() || "unknown reason";
}

/** The visible tail every abnormal turn with output commits on its reserved id. */
export function preservePartialReply(reply: string, error: unknown): string {
  const notice = `⚠ turn ended without completion (${turnEndReason(error)}) — partial output preserved`;
  const partial = reply.trim();
  return partial ? `${partial}\n\n${notice}` : notice;
}

/** The durable system failure used when an abnormal turn emitted no output. */
export function diedWithoutOutput(error: unknown): Error {
  return new Error(`turn died without output (${turnEndReason(error)})`);
}

/** Min gap between visible "upstream stall" system lines within one streaming
 * turn — a harness retrying against a dead upstream can emit the notice
 * repeatedly; the room should say it's stuck once, not spam the transcript. */
export const STALL_NOTICE_THROTTLE_MS = 60_000;

/** Cap on the flagged agent's persona context handed to the Thanks-Dario
 * reviewer — enough for a SOUL + role, bounded so a huge persona can't bloat
 * the review turn (a big reasoning stream has wedged the reviewer before). */
const PERSONA_CONTEXT_CAP = 16_000;

/** Default "load last N messages" when the human doesn't specify N. */
const CONTEXT_GATE_LAST_N = 20;

/** System prompt for the context-gate "compact" summary (option 1). */
const CONTEXT_SUMMARY_SYSTEM = [
  "You are compacting a group-chat room transcript so a NEW participant can catch up fast.",
  "Write a tight briefing that preserves: the current topic, key facts and decisions, open questions,",
  "who said what that still matters, and any commitments or next steps. Drop small talk and resolved tangents.",
  "Use short sections or bullets. Do not add commentary about the summary itself.",
].join(" ");

/** Cap on the transcript chars fed to the context-gate summarizer, biased to the
 * recent tail. Keeps a huge room from overflowing the summarizer model's context
 * (~25k tokens of input, safe even for a small-window consolidation model).
 * Rooms that exceed this should be joined with "Load full" if they fit the
 * agent's own (much larger) window. */
const MAX_SUMMARY_INPUT_CHARS = 100_000;

/** Max hits a /recall command reply lists. */
const RECALL_COMMAND_LIMIT = 8;

/** Char budget for the Thanks-Dario review span. The reviewer must see the
 * SAME context the flagged agent replays — not a 20-message tail — or it can't
 * find where the conversation first drifted onto the sensitive topic (often a
 * user question several turns before the model ever refused). We review from the
 * agent's context floor to the end, capped to this budget biased to the tail
 * (freshest re-scored content + the reroute point); any older span that doesn't
 * fit is reported, never silently dropped. ~40k tokens — safe for the reviewer. */
const SANITIZE_REVIEW_CHAR_BUDGET = 160_000;

/** Commands that rewrite the transcript itself (wipe / branch / truncate).
 * Their reply is a live-only confirmation — persisting it would drop a stray
 * event back into the history they just reset. */
const TRANSCRIPT_STRUCTURAL_COMMANDS = new Set(["clear", "fork", "rewind"]);

/** Command handlers, keyed by parsed type. Adding a command = one entry here
 * plus one line in SLASH_COMMANDS. Each returns the system reply text, with an
 * optional event discriminator when the transcript should render it specially,
 * and an optional `author` override for the rare handler that still needs one.
 * DogMode (/dog + its discipline verbs) is a bundled command-plugin now (whip
 * 348, see plugins/defaults/dog-mode.mjs) and is NOT in this registry at all —
 * it's dispatched through the generic command-plugin path in sendMessage(),
 * same as /whip or /ultrawhip. */
type CommandReply = string | { text: string; kind?: RoomEventKind; author?: string };
type RoomCommand = SlashCommand;
type CommandHandler = (service: RoomService, command: RoomCommand) => Promise<CommandReply>;

const COMMANDS: Record<string, CommandHandler> = {
  help: async () => HELP_TEXT,
  agents: (service) => service.renderAgentsList(),
  roles: (service, command) => service.renderRoles(command.type === "roles" ? command.agent : undefined),
  role: (service, command) => (command.type === "role" ? service.setRole(command.agent, command.role) : Promise.resolve("")),
  thinking: (service, command) => (command.type === "thinking" ? service.runThinkingCommand(command.agent, command.level) : Promise.resolve("")),
  "thinking-level": (service, command) => (command.type === "thinking-level" ? service.runThinkingLevelCommand(command.level) : Promise.resolve("")),
  model: (service, command) => (command.type === "model" ? service.runModelCommand(command.agent, command.spec) : Promise.resolve("")),
  pet: (service, command) => (command.type === "pet" ? service.runPetCommand(command) : Promise.resolve("")),
  summon: (service, command) => (command.type === "summon" ? service.runSummonCommand(command.agent, command.task) : Promise.resolve("")),
  setup: (service, command) => (command.type === "setup" ? service.runSetupCommand(command) : Promise.resolve("")),
  clear: (service) => service.runClearCommand(),
  refresh: (service) => service.runRefreshCommand(),
  consolidate: (service, command) => (command.type === "consolidate" ? service.runConsolidateCommand(command.agent) : Promise.resolve("")),
  dream: (service, command) => (command.type === "dream" ? service.runDreamCommand(command.agent, command.apply) : Promise.resolve("")),
  compact: (service, command) => (command.type === "compact" ? service.runCompactCommand(command.agent, command.edit) : Promise.resolve("")),
  stt: (service, command) => (command.type === "stt" ? service.runSttCommand(command.engine, command.alias) : Promise.resolve("")),
  diet: (service, command) => (command.type === "diet" ? service.runDietCommand(command.sub, command.scope) : Promise.resolve("")),
  reload: (service) => service.runReloadCommand(),
  schedule: (service, command) => (command.type === "schedule" ? service.runScheduleCommand(command.sub, command.id) : Promise.resolve("")),
  rewind: (service, command) => (command.type === "rewind" ? service.runRewindCommand(command.count) : Promise.resolve("")),
  goal: (service, command) => (command.type === "goal" ? service.runGoalCommand(command) : Promise.resolve("")),
  recall: (service, command) => (command.type === "recall" ? service.runRecallCommand(command.agent, command.query) : Promise.resolve("")),
  "thanks-dario": (service, command) => (command.type === "thanks-dario" ? service.runThanksDarioCommand(command.sub) : Promise.resolve("")),
  // DogMode (/dog + its discipline verbs) is a bundled command-plugin, not a
  // registry entry — see plugins/defaults/dog-mode.mjs + sendMessage()'s
  // generic plugin dispatch.
  // steer and cancel never reach this registry: both must run WHILE a task is
  // active, so sendMessage handles them before the busy-queue branch.
  steer: (service, command) => (command.type === "steer" ? service.runSteerCommand(command.text) : Promise.resolve("")),
  cancel: (service) => service.runCancelCommand(),
  fork: (service) => service.runForkCommand(),
  unknown: (service, command) => (command.type === "unknown" ? service.runUnknownCommand(command) : Promise.resolve("")),
};

export class RoomService {
  readonly room: RoomHandle;
  readonly runtimes: Record<string, AgentRuntime>;
  readonly bus = new Bus<UiEvent>();
  activeTask: Task | undefined;
  /** The active task ONLY when it's a streaming agent turn (via startTask) —
   * never a synchronous slash command. `activeTask` covers both, so guards that
   * mean "an agent is mid-turn" (e.g. /compact) must consult this instead, or
   * they trip on the command's own task. */
  activeAgentTurn: Task | undefined;
  /** The running agent-turn's full unwind (streaming + partial commit + settle
   * paths). cancelActiveTask awaits it so a stop settles AFTER the streamed
   * partial is committed — never blanking progress from the UI. */
  activeTurnUnwind: Promise<void> | undefined;
  /** Set by settleTask to the in-flight settle→drain continuation (the settle
   * snapshot emit, then drain()'s decision of what — if anything — runs
   * next). settleTask clears activeTask SYNCHRONOUSLY but only calls drain()
   * after that async emit; sendMessage awaits this before evaluating
   * busy/idle so a message can never land in that gap, see activeTask===
   * undefined, and run immediately — jumping ahead of a message that's
   * already been durably queued far longer. (The jumped message would then
   * never drain: drain() sees the interloper's activeTask and bails, so it
   * sits showing "queued" until the interloper's own turn eventually settles
   * and drains it — very late, and out of send order.) Resolves fast: it
   * covers only drain()'s OWN decision, not a queued command's execution
   * (drain sets activeTask before awaiting a command turn, so a concurrent
   * sendMessage sees that instead of blocking on the command). */
  draining: Promise<void> | undefined;
  /** Single wake-up for the durable queue head's transient-auth backoff. */
  authRetryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Agents whose harness is mid-compaction, so the snapshot can show a live
   * "compacting" status. Set around the uniform runtime.compact() call — every
   * harness that declares supportsCompact gets it, with no harness branches. */
  readonly compactingAgents = new Set<string>();
  /** Live compaction progress per agent (job size + summary-so-far + start
   * time), surfaced on the snapshot so the UI can render real progress, not
   * just a spinner. Present only while the agent is in `compactingAgents`. */
  readonly compactProgress = new Map<string, CompactProgress>();
  /** Throttle clock for progress-driven snapshot emits (token deltas arrive in
   * bursts; we re-render at most ~2/s). */
  lastCompactEmit = 0;
  /** Agents whose in-flight compaction the user cancelled: /cancel aborts the
   * runtime (which kills the harness pass), and this marker turns the resulting
   * rejection into "cancelled", not a scary harness exit error. */
  readonly compactCancels = new Set<string>();
  recentTasks: Task[] = [];
  /** Tasks mirroring the DURABLE queue (state.queue) for snapshot chips. */
  queuedTasks: Task[] = [];
  /** Last sanitize proposal marker (full body lives in sanitize.json). */
  sanitizeStatus: SanitizeStatus | undefined;
  /** Last provider-side model switch per agent; cleared by the next turn that
   * completes without one. Transient — the durable record is the transcript
   * event's details.modelFallback. */
  readonly modelFallbacks: Record<string, ModelFallback> = {};
  /** Latest harness-reported context accounting per agent (transient). */
  contextUsage: Record<string, { usedTokens: number; maxTokens?: number }> = {};
  /** The running turn's accumulated view (text + thinking + tools so far),
   * mirrored on the snapshot so a client that (re)subscribes mid-turn — the
   * common case of switching rooms while an agent works — renders it instantly
   * instead of a blank until commit. Fed from the ONE onEvent sink below, so it
   * applies to every harness with zero harness branches (RULE #0). Cleared on
   * commit/failure/cancel; the durable resume record is PendingTurn.partialReply. */
  liveTurn: LiveTurn | undefined;
  /** A held first turn awaiting the human's context-size choice (durable copy in
   * state.contextGate); surfaced on the snapshot to drive the modal. */
  contextGate: ContextGatePending | undefined;
  /** Consecutive agent→agent hand-offs since the last human message. Bounds
   * room agent-dialogue so a mutual @mention can't loop forever; reset to 0
   * whenever a human speaks. In-memory (a runaway chain shouldn't outlive a
   * restart anyway). */
  agentDialogueHops = 0;
  /** Per-target terminal pet states already emitted for a multi-agent task, so
   * a later target failure cannot repaint an earlier successful pet as failed. */
  private readonly settledPetTargets = new Set<string>();
  readonly startedPetTargets = new Set<string>();
  private initPromise: Promise<void> | undefined;
  /** Adapters belong to one registry generation; a swap discards them. */
  private pluginAdapterGeneration: number | undefined;
  private pluginAdapters: Map<string, CommandPlugin> | undefined;

  /** Immutable: this room is invisible to long-term memory. See RoomState.incognito. */
  readonly incognito: boolean;
  /** Context-diet policy store (09-MEMORY-CONTEXT): workspace default + this
   * room's override, file-backed under .gaia/ — backs `/diet` and the
   * `diet`/`tool_result_fetch` gaia-tool verbs. Default OFF (IRON). */
  readonly dietPolicyStore: ContextPolicyStore;
  readonly backgroundTasks: BackgroundTasks;

  constructor(readonly options: RoomServiceOptions & { room: RoomHandle }) {
    this.room = options.room;
    this.incognito = options.incognito === true;
    this.dietPolicyStore = new ContextPolicyStore(options.workspace.rootDir);
    this.backgroundTasks = new BackgroundTasks({ room: this.room, roomId: this.roomId, emitSnapshot: () => this.emitSnapshot() });
    this.runtimes = buildRoomRuntimes(options, this.incognito, this);
  }
  static async open(options: RoomServiceOptions): Promise<RoomService> {
    const { room, incognito } = await resolveRoomOpen(options);
    return new RoomService({ ...options, room, incognito });
  }
  isSummonRoom = false;
  /** This room inherited the untrusted tier from its summon chain (see
   * RoomState.summonUntrusted) — feeds effectiveTrust for sandbox resolution. */
  summonUntrusted = false;
  /** This room's isolated working directory (RoomState.workDir — its git
   * worktree under collab isolation), validated against the filesystem at
   * init. Assigned at room-service init for EVERY room — default,
   * interactive, and summon children alike — not at summon launch.
   * undefined = run at the workspace root. Feeds the runtimes' workDir thunk. */
  workDir: string | undefined;

  get workspace(): Workspace {
    return this.options.workspace;
  }

  get workspaceId(): string {
    return this.options.workspaceId;
  }

  get roomId(): string {
    return this.room.roomId;
  }

  get hasActiveTask(): boolean {
    return Boolean(this.activeTask);
  }

  /** Busy = running a turn, holding queued-but-undrained work, or has a live
   * background summon. Guards a service from LRU eviction while its
   * background work would be killed with it. The queue check matters even
   * when activeTask is momentarily unset: settleTask clears activeTask
   * synchronously but drain() (which claims the next queued item) only runs
   * after an async emitSnapshot — evicting in that window would strand a
   * queued message with a persisted entry but no live driver to pick it up. */
  get isBusy(): boolean {
    return (
      Boolean(this.activeTask) ||
      this.queuedTasks.length > 0 ||
      Boolean(this.options.summonHost?.runningChildren(this.roomId).length)
    );
  }

  get activeTaskId(): string | undefined {
    return this.activeTask?.id;
  }

  init(): Promise<void> {
    this.initPromise ??= this.initOnce();
    return this.initPromise;
  }

  async initOnce(): Promise<void> {
    return new RoomLifecycle(this).initOnce();
  }
  subscribe(listener: (event: UiEvent) => void): () => void {
    return new RoomLifecycle(this).subscribe(listener);
  }
  async dispose(): Promise<void> {
    return new RoomLifecycle(this).dispose();
  }
  // --- messaging -------------------------------------------------------------
  async isConversationEnded(agentId: string): Promise<boolean> {
    return Boolean((await this.room.state()).conversationEndedAgents?.[agentId]);
  }
  async endedConversationTargets(targets: readonly string[]): Promise<string[]> {
    const ended = (await this.room.state()).conversationEndedAgents ?? {};
    return targets.filter((target) => ended[target] !== undefined);
  }
  async reactivateConversation(targets: readonly string[]): Promise<void> {
    if (targets.length === 0) return;
    await this.room.updateState((state) => {
      if (!state.conversationEndedAgents) return;
      for (const target of targets) delete state.conversationEndedAgents[target];
      if (Object.keys(state.conversationEndedAgents).length === 0) delete state.conversationEndedAgents;
    });
  }
  /** Agent tool entry: persist a visible goodbye before aborting its runner.
   * The next human message to that agent clears this state in sendMessage(). */
  async endConversation(agentId: string, farewell: string): Promise<string> {
    if (this.workspace.config.agentEndConversation === false) throw new Error("Agent-initiated conversation ending is disabled by workspace config.");
    const text = farewell.trim();
    if (!text) throw new Error("farewell is required.");
    const event: RoomEvent = { id: newRoomEventId(), timestamp: new Date().toISOString(), author: agentId, text };
    await this.room.endConversation(agentId, event);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
    void this.emitSnapshot();
    // The tool call runs inside this runtime. Abort only after the farewell is
    // durable, so a runner death cannot turn an intentional goodbye into loss.
    if (this.activeAgentTurn?.targets.includes(agentId)) void this.runtimes[agentId]?.abort().catch(() => {});
    return "Conversation ended. Your farewell is visible; wait for a user message before another turn.";
  }

  private readonly queue = new RoomQueue(this);
  async sendMessage(text: string, options: SendMessageOptions = {}): Promise<Task> {
    return this.queue.sendMessage(text, options);
  }
  async drain(onDecided?: () => void): Promise<void> {
    return this.queue.drain(onDecided);
  }
  async roomDefaultTarget(): Promise<string> {
    return this.queue.roomDefaultTarget();
  }
  /** /pet persists one room+agent package binding. Native windows are a shell
   * concern: the daemon emits a complete workspace snapshot after every change,
   * and browsers/iOS deliberately render no fake in-chat or cross-app pet. */
  // --- task operations: ./room/task-operations.ts (RoomTaskOperationsMixin) ---
  // --- summon lifecycle + agent-dialogue delivery: ./room/summon-lifecycle.ts (RoomSummonLifecycleMixin) ---
  /** A live-only system line in the room (not persisted) — used for transient
   * room notices like the agent-dialogue loop-guard pause. */
  emitSystemNote(text: string): void {
    this.emit({
      type: "room-event",
      workspaceId: this.workspaceId,
      roomId: this.roomId,
      event: { id: newRoomEventId(), timestamp: new Date().toISOString(), author: "system", text },
    });
  }

  /** Toggle room agent-dialogue (agents replying to each other's @mentions).
   * Persisted per-room; resets the hop budget so a fresh enable starts clean. */
  // --- the turn
  // --- the turn --------------------------------------------------------------

  // --- turn results and context gate ---------------------------------------
  async commandPlugins(): Promise<Map<string, CommandPlugin>> {
    const registry = this.options.pluginRegistry;
    if (!registry) return new Map();
    const generation = registry.current?.generation;
    if (generation === undefined) return loadCommandPlugins(registry);
    if (this.pluginAdapterGeneration !== generation) {
      this.pluginAdapters = await loadCommandPlugins(registry);
      this.pluginAdapterGeneration = generation;
    }
    return this.pluginAdapters ?? new Map();
  }
  async withPluginTurn<T>(run: () => Promise<T>): Promise<T> {
    const registry = this.options.pluginRegistry;
    const lease = registry?.beginTurn();
    try {
      return await run();
    } finally {
      lease?.end();
      if (lease) await registry?.applyTurnBoundary();
    }
  }
  async runPluginCommand(command: string, args: string[]): Promise<PluginResult | undefined> {
    return this.withPluginTurn(async () => {
      const plugin = (await this.commandPlugins()).get(command);
      return plugin ? this.runPlugin(plugin, args, command) : undefined;
    });
  }
  async runAgentTask(task: Task, text: string, options: SendMessageOptions): Promise<void> {
    return this.withPluginTurn(() => new RoomTurnResults(this).runAgentTask(task, text, options));
  }
  private contextFor(agent: AgentDef): { usedTokens: number; maxTokens?: number } | undefined {
    return new RoomTurnResults(this).contextFor(agent);
  }
  private async openContextGate(agent: AgentDef, message: string, estTokens: number, totalEvents: number, attachments: MessageAttachment[] | undefined, reason: "new-agent" | "session-lost"): Promise<void> {
    return new RoomTurnResults(this).openContextGate(agent, message, estTokens, totalEvents, attachments, reason);
  }
  async resolveContextGate(choice: "full" | "last" | "compact", n?: number): Promise<void> {
    return new RoomTurnResults(this).resolveContextGate(choice, n);
  }
  async setContextFloor(agentId: string, floorIdx: number): Promise<void> {
    return new RoomTurnResults(this).setContextFloor(agentId, floorIdx);
  }
  async recallContext(agentId: string): Promise<ActiveContextRef> {
    return new RoomTurnResults(this).recallContext(agentId);
  }
  private async summarizeRoom(target: string, uptoEvents: number): Promise<string> {
    return new RoomTurnResults(this).summarizeRoom(target, uptoEvents);
  }
  async commitReply(agentId: string, eventId: string, reply: string, details: EventDetails, channel: "voice" | undefined, nextPending?: PendingTurn, renderCap?: RenderCap): Promise<void> {
    return new RoomTurnResults(this).commitReply(agentId, eventId, reply, details, channel, nextPending, renderCap);
  }
  async appendPluginEvent(text: string, kind: RoomEventKind, details?: EventDetails): Promise<RoomEvent> {
    return new RoomTurnResults(this).appendPluginEvent(text, kind, details);
  }
  async appendTurnFailure(agentId: string, error: unknown): Promise<void> {
    return new RoomTurnResults(this).appendTurnFailure(agentId, error);
  }
  async appendTurnRetry(attempt: number, retries: number): Promise<void> {
    return new RoomTurnResults(this).appendTurnRetry(attempt, retries);
  }
  async appendTurnStopped(agentId: string): Promise<void> {
    return new RoomTurnResults(this).appendTurnStopped(agentId);
  }
  async maybeRequeueStall(targets: string[], agentId: string, text: string, error: unknown, partialReply: string, channel: "voice" | undefined, attachments: MessageAttachment[] | undefined, options: SendMessageOptions): Promise<boolean> {
    return new RoomTurnResults(this).maybeRequeueStall(targets, agentId, text, error, partialReply, channel, attachments, options);
  }
  async maybeRequeueAuth(targets: string[], agentId: string, text: string, error: unknown, partialReply: string, channel: "voice" | undefined, attachments: MessageAttachment[] | undefined, options: SendMessageOptions): Promise<boolean> {
    return new RoomTurnResults(this).maybeRequeueAuth(targets, agentId, text, error, partialReply, channel, attachments, options);
  }
  async captureEpisode(agentId: string, task: string, reply: string, outcome: EpisodeCapture["outcome"], details: EventDetails, channel: "voice" | undefined): Promise<void> {
    return new RoomTurnResults(this).captureEpisode(agentId, task, reply, outcome, details, channel);
  }
  async runConsolidateCommand(agentId?: string): Promise<string> {
    const target = agentId ?? (await this.roomDefaultTarget());
    if (!this.workspace.agents[target]) return `Unknown agent: ${target}`;
    if (!this.options.memory) return "Memory consolidation is not available in this workspace.";
    const result = await this.options.memory.consolidate(target, { force: true });
    if (!result.ran) return `Consolidation skipped for @${target}: ${result.reason ?? "nothing to do"}.`;
    return `Consolidated @${target}: ${result.episodesSeen} episodes reviewed → ${result.factsAdded} facts added, ${result.factsInvalidated} superseded, ${result.memoryEdits} core-memory edits${result.opsSkipped ? `, ${result.opsSkipped} ops skipped` : ""}.`;
  }

  /** Dream v2, reachable from the chat composer (was CLI-only via `gaia
   * dream` — the command existed but no room recognized it as a slash
   * command, so autocomplete showed "no matches"). `/dream [agent]` proposes
   * (never applies); `/dream [agent] --apply` commits the standing proposal.
   * Same underlying MemoryService calls the CLI/harness route uses, so the
   * two surfaces can never drift. */
  async runDreamCommand(agentId?: string, apply?: boolean): Promise<string> {
    const target = agentId ?? (await this.roomDefaultTarget());
    if (!this.workspace.agents[target]) return `Unknown agent: ${target}`;
    if (!this.options.memory) return "Memory consolidation is not available in this workspace.";
    if (apply) {
      if (!this.options.memory.applyDreamProposal) return "Dream apply is not available in this workspace.";
      const result = await this.options.memory.applyDreamProposal(target);
      if (!result) return `No pending dream proposal for @${target} — run \`/dream ${target}\` first.`;
      return `Applied ${result.applied} ops (${result.skipped} skipped) for @${target}.`;
    }
    const result = await this.options.memory.consolidate(target, { propose: true, force: true });
    return formatDreamProposal(result, `run: /dream ${target} --apply to accept, or /dream ${target} again to regenerate.`);
  }

  /** Steer-by-default core: inject a plain message into @target's running turn.
   * PERSISTS FIRST (NO PROGRESS EVER LOST): the guidance is committed to the
   * transcript before the harness sees it — a crash right after the harness
   * accepts it would rerun the turn from partialReply, and the guidance must
   * be on disk to survive that. Returns true when the running turn accepted
   * it; otherwise the committed event's id, and the caller falls back to a
   * normal turn that reuses the committed event instead of re-recording it.
   * On success a `steered` marker pins WHERE in the running reply it landed
   * (folds into details.blocks at the current stream position, so the UI
   * renders the message inline right there, live and after commit), and the
   * steer task completes — the running turn's continued output IS the reply,
   * so there's no turn of its own. */
  async steerRunningTurn(
    target: string,
    text: string,
    task: Task,
    attachments?: MessageAttachment[],
    human?: { id: string; label: string }
  ): Promise<true | string> {
    const event = await this.room.addUserMessage(text, [target], undefined, attachments, undefined, human);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
    // Attachments travel two ways, uniformly: the same breadcrumb lines the turn
    // prompt uses ride in the text (the file sits on disk at that path, openable
    // by any harness's tools), AND the attachments are handed to the harness's
    // steer() so one with a native mid-turn image channel additionally inlines
    // the bytes (pi steer images, claude stream-json image blocks, codex
    // localImage) — its own translation, no shared-code branch.
    const steerText = attachments?.length ? `${text}\n\n${renderAttachmentLines(attachments)}` : text;
    const ok = (await this.runtimes[target]?.steer?.(this.roomId, steerText, attachments)) ?? false;
    if (!ok) return event.id;
    // Best-effort marker — if the stream just closed, the standalone bubble
    // simply keeps the legacy placement.
    this.runtimes[target]?.injectEvent?.({ type: "steered", eventId: event.id });
    task.status = "complete";
    task.endedAt = new Date().toISOString();
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
    this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.roomId, task });
    void this.emitSnapshot();
    return true;
  }

  /** Retry a reply: fork the room at the user message that produced the
   * given event and re-run it verbatim. Works on an agent reply (regenerate
   * it) or on a user message (re-send it). */
  async retryMessage(eventId: string): Promise<Task> {
    return new RoomFork(this).retryMessage(eventId);
  }

  async editMessage(eventId: string, text: string, keepAttachmentPaths?: string[]): Promise<Task> {
    return new RoomFork(this).editMessage(eventId, text, keepAttachmentPaths);
  }

  async resetAfterTruncation(mode: "reset-sessions" | "reset-keep-context", cut?: number, forkOrigin?: { id: string; userOrdinal: number }): Promise<void> {
    return new RoomFork(this).resetAfterTruncation(mode, cut, forkOrigin);
  }

  async runScheduleCommand(sub: "list" | "run", jobId?: string): Promise<string> {
    const hooks = this.options.scheduler;
    if (!hooks) return "The scheduler is not available in this workspace.";
    if (sub === "run") {
      if (!jobId) return "Usage: /schedule run <id>";
      return hooks.runNow(jobId);
    }
    return hooks.list();
  }

  /** Append an agent-authored event WITHOUT running a turn — how the scheduler
   * delivers an isolated run's result into its target room, and how a summon
   * result lands as a collapsed note (details.summonResult). */
  async postAgentNote(agentId: string, text: string, details?: EventDetails): Promise<void> {
    await this.init();
    if (!this.workspace.agents[agentId]) throw new Error(this.unknownAgentMessage(agentId));
    const event: RoomEvent = {
      id: newRoomEventId(),
      timestamp: new Date().toISOString(),
      author: agentId,
      text,
      ...(details ? { details } : {}),
    };
    await this.room.appendEvent(event);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
  }

  // --- durable pending-turn resume: ./room/queue.ts (RoomQueue) ---
  async resumePendingTurn(pending: PendingTurn): Promise<void> {
    return this.queue.resumePendingTurn(pending);
  }

  // --- monad run execution: ./room/monad-execution.ts (RoomMonadExecutionMixin) ---

  // --- commands ----------------------------------------------------------------

  async runCommand(task: Task, command: RoomCommand): Promise<void> {
    return executeCommand(this, task, command, (candidate) => COMMANDS[candidate.type]?.(this, candidate));
  }

  async runSttCommand(engine?: string, alias?: "tts"): Promise<string> {
    return runSttCommand(engine, alias);
  }

  async runReloadCommand(): Promise<string> {
    return runReloadCommand(this);
  }

  // --- agent configuration commands: ./room/agent-commands.ts (RoomAgentCommandsMixin) ---

  // --- room maintenance: ./room/maintenance.ts (RoomMaintenanceMixin) ---


}

export interface RoomService
  extends RoomSnapshotMixin,
    RoomUiMixin,
    RoomCommandsMixin,
    RoomSanitizeMixin,
    RoomAgentCommandsMixin,
    RoomSummonLifecycleMixin,
    RoomLifecyclePort,
    RoomTaskOperationsMixin,
    RoomTaskOperationsPort,
    RoomMaintenanceMixin,
    RoomMaintenancePort,
    RoomMonadExecutionMixin {}
installRoomSnapshot(RoomService.prototype);
installRoomUi(RoomService.prototype);
installRoomCommands(RoomService.prototype);
installRoomSanitize(RoomService.prototype);
installRoomAgentCommands(RoomService.prototype);
installRoomSummonLifecycle(RoomService.prototype);
installRoomTaskOperations(RoomService.prototype);
installRoomMaintenance(RoomService.prototype);
installRoomMonadExecution(RoomService.prototype);
