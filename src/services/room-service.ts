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

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { attachmentMime, sanitizeAttachmentName } from "../core/attachments.js";
import { Bus } from "../core/bus.js";
import { newId } from "../core/ids.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import { workspacePaths } from "../core/paths.js";
import type { SanitizeProposal, SanitizeStatus } from "../core/types.js";
import type {
  AgentDef,
  AgentEvent,
  AgentModelConfig,
  AgentStatus,
  CompactProgress,
  ContextGatePending,
  EventDetails,
  LiveTurn,
  MessageAttachment,
  ModelFallback,
  PendingTurn,
  QueuedMessage,
  RoomEvent,
  RoomEventKind,
  SlashCommandDefinition,
  Snapshot,
  Task,
  UiEvent,
  Workspace,
} from "../core/types.js";
import { DEFAULT_CONTEXT_WARN_TOKENS } from "../core/config.js";
import { estimateTokens } from "../core/tokens.js";
import { newRoomEventId, normalizeRoomState, RoomHandle } from "../domain/rooms.js";
import { listAgentRoles, resolveAgentRole } from "../domain/roles.js";
import type { MemoryStore, MemoryAction, MemoryMutationResult } from "../domain/memory.js";
import { formatMemoryHits, type ActiveContextRef, type MemorySearchHit } from "../domain/workspace-index.js";
import type { AgentRuntime, HarnessHost } from "../harness/spec.js";
import { capabilitiesFor, contextWindowFor, findHarness, harnessIdFor, nativeCommandsFor } from "../harness/spec.js";
import { readOptional, renderRoomTranscript } from "../harness/prompt.js";
import { HELP_TEXT, SLASH_COMMANDS, hasExplicitMention, mentionedAgents, parseCommand, planMentionRoute, type SlashCommand } from "./commands.js";
import { SANITIZE_REVIEWER_ID, buildSanitizePrompt, parseSanitizeProposal, type SanitizeContext } from "./sanitize.js";
import { applyEventToDetails, finalizeInterruptedTools, runAgentTurn } from "./turns.js";
import type { EpisodeCapture } from "./memory-service.js";
import type { ConsolidateLlm, ConsolidateResult } from "./consolidate.js";
import { allowSummonForTurn, isTrusted, type SummonHost, type SummonResultDelivery } from "./summons.js";
import { HOOK_TEXT_CAP, runHooks, type HookEvent } from "./hooks.js";
import { MonadEngine } from "./monad.js";
import { activateSetup, deactivateMonad, discoverSetups } from "./setups.js";
import { sdkThinkingLevels } from "./hints.js";
import { createAgentRuntime } from "../harness/host.js";
import { configuredModelLabel } from "../harness/model-label.js";
import { resolveSandboxPolicy } from "../harness/sandbox/spec.js";

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
  consolidate(agentId: string, options?: { force?: boolean }): Promise<ConsolidateResult>;
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
  thinking?: string;
  /** Files attached to the message (already stored in the room's files dir). */
  attachments?: MessageAttachment[];
  /** This turn was produced by room agent-dialogue (one agent addressing
   * another), not a human — it doesn't reset the dialogue hop count. */
  fromAgentDialogue?: boolean;
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
  /** Set by drain(): the durable queue entry this turn consumes. The entry
   * stays queued until the turn's first durable record replaces it (the
   * two-phase hand-off — see RoomHandle.peekQueue). */
  queued?: QueuedMessage;
}

/** Min gap between durable partial-reply flushes during a streaming turn. */
const PARTIAL_FLUSH_MS = 1000;

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

/** Max consecutive agent→agent hand-offs before room agent-dialogue pauses and
 * waits for a human. The toggle is the on/off; this is the runaway backstop. */
export const AGENT_DIALOGUE_MAX_HOPS = 8;

/** Commands that rewrite the transcript itself (wipe / branch / truncate).
 * Their reply is a live-only confirmation — persisting it would drop a stray
 * event back into the history they just reset. */
const TRANSCRIPT_STRUCTURAL_COMMANDS = new Set(["clear", "fork", "rewind"]);

/** Command handlers, keyed by parsed type. Adding a command = one entry here
 * plus one line in SLASH_COMMANDS. Each returns the system reply text, with an
 * optional event discriminator when the transcript should render it specially. */
type CommandReply = string | { text: string; kind?: RoomEventKind };
type CommandHandler = (service: RoomService, command: SlashCommand) => Promise<CommandReply>;

const COMMANDS: Record<string, CommandHandler> = {
  help: async () => HELP_TEXT,
  agents: (service) => service.renderAgentsList(),
  roles: (service, command) => service.renderRoles(command.type === "roles" ? command.agent : undefined),
  role: (service, command) => (command.type === "role" ? service.setRole(command.agent, command.role) : Promise.resolve("")),
  thinking: (service, command) => (command.type === "thinking" ? service.runThinkingCommand(command.agent, command.level) : Promise.resolve("")),
  model: (service, command) => (command.type === "model" ? service.runModelCommand(command.agent, command.spec) : Promise.resolve("")),
  summon: (service, command) => (command.type === "summon" ? service.runSummonCommand(command.agent, command.task) : Promise.resolve("")),
  setup: (service, command) => (command.type === "setup" ? service.runSetupCommand(command) : Promise.resolve("")),
  clear: (service) => service.runClearCommand(),
  consolidate: (service, command) => (command.type === "consolidate" ? service.runConsolidateCommand(command.agent) : Promise.resolve("")),
  compact: (service, command) => (command.type === "compact" ? service.runCompactCommand(command.agent) : Promise.resolve("")),
  schedule: (service, command) => (command.type === "schedule" ? service.runScheduleCommand(command.sub, command.id) : Promise.resolve("")),
  rewind: (service, command) => (command.type === "rewind" ? service.runRewindCommand(command.count) : Promise.resolve("")),
  recall: (service, command) => (command.type === "recall" ? service.runRecallCommand(command.agent, command.query) : Promise.resolve("")),
  "thanks-dario": (service, command) => (command.type === "thanks-dario" ? service.runThanksDarioCommand(command.sub) : Promise.resolve("")),
  native: (service, command) => (command.type === "native" ? service.runNativeCommand(command.agent, command.sub) : Promise.resolve("")),
  // steer and cancel never reach this registry: both must run WHILE a task is
  // active, so sendMessage handles them before the busy-queue branch.
  steer: (service, command) => (command.type === "steer" ? service.runSteerCommand(command.text) : Promise.resolve("")),
  cancel: (service) => service.runCancelCommand(),
  fork: (service) => service.runForkCommand(),
  unknown: async (_service, command) => `Unknown command: /${command.type === "unknown" ? command.command : "?"}. Try /help.`,
};

export class RoomService {
  readonly room: RoomHandle;
  private readonly runtimes: Record<string, AgentRuntime>;
  private readonly bus = new Bus<UiEvent>();
  private activeTask: Task | undefined;
  /** The active task ONLY when it's a streaming agent turn (via startTask) —
   * never a synchronous slash command. `activeTask` covers both, so guards that
   * mean "an agent is mid-turn" (e.g. /compact) must consult this instead, or
   * they trip on the command's own task. */
  private activeAgentTurn: Task | undefined;
  /** The running agent-turn's full unwind (streaming + partial commit + settle
   * paths). cancelActiveTask awaits it so a stop settles AFTER the streamed
   * partial is committed — never blanking progress from the UI. */
  private activeTurnUnwind: Promise<void> | undefined;
  /** Agents whose harness is mid-compaction, so the snapshot can show a live
   * "compacting" status. Set around the uniform runtime.compact() call — every
   * harness that declares supportsCompact gets it, with no harness branches. */
  private readonly compactingAgents = new Set<string>();
  /** Live compaction progress per agent (job size + summary-so-far + start
   * time), surfaced on the snapshot so the UI can render real progress, not
   * just a spinner. Present only while the agent is in `compactingAgents`. */
  private readonly compactProgress = new Map<string, CompactProgress>();
  /** Throttle clock for progress-driven snapshot emits (token deltas arrive in
   * bursts; we re-render at most ~2/s). */
  private lastCompactEmit = 0;
  /** Agents whose in-flight compaction the user cancelled: /cancel aborts the
   * runtime (which kills the harness pass), and this marker turns the resulting
   * rejection into "cancelled", not a scary harness exit error. */
  private readonly compactCancels = new Set<string>();
  private recentTasks: Task[] = [];
  /** Tasks mirroring the DURABLE queue (state.queue) for snapshot chips. */
  private queuedTasks: Task[] = [];
  /** Last sanitize proposal marker (full body lives in sanitize.json). */
  private sanitizeStatus: SanitizeStatus | undefined;
  /** Last provider-side model switch per agent; cleared by the next turn that
   * completes without one. Transient — the durable record is the transcript
   * event's details.modelFallback. */
  private modelFallbacks: Record<string, ModelFallback> = {};
  /** Latest harness-reported context accounting per agent (transient). */
  private contextUsage: Record<string, { usedTokens: number; maxTokens?: number }> = {};
  /** The running turn's accumulated view (text + thinking + tools so far),
   * mirrored on the snapshot so a client that (re)subscribes mid-turn — the
   * common case of switching rooms while an agent works — renders it instantly
   * instead of a blank until commit. Fed from the ONE onEvent sink below, so it
   * applies to every harness with zero harness branches (RULE #0). Cleared on
   * commit/failure/cancel; the durable resume record is PendingTurn.partialReply. */
  private liveTurn: LiveTurn | undefined;
  /** A held first turn awaiting the human's context-size choice (durable copy in
   * state.contextGate); surfaced on the snapshot to drive the modal. */
  private contextGate: ContextGatePending | undefined;
  /** Consecutive agent→agent hand-offs since the last human message. Bounds
   * room agent-dialogue so a mutual @mention can't loop forever; reset to 0
   * whenever a human speaks. In-memory (a runaway chain shouldn't outlive a
   * restart anyway). */
  private agentDialogueHops = 0;
  private initPromise: Promise<void> | undefined;

  /** Immutable: this room is invisible to long-term memory. See RoomState.incognito. */
  readonly incognito: boolean;

  constructor(private readonly options: RoomServiceOptions & { room: RoomHandle }) {
    this.room = options.room;
    this.incognito = options.incognito === true;
    // In an incognito room the memory/recall tools are stripped from every agent.
    // The strip happens in the runner subprocess (it re-loads the agent from disk,
    // so a daemon-side strip here would never reach it); we just pass the flag
    // down. It applies uniformly to every harness — RULE #0 — because the runner
    // is the one path all harnesses go through. `this.incognito` also gates the
    // daemon-side episode-capture and auto-recall paths below.
    this.runtimes = Object.fromEntries(
      Object.values(options.workspace.agents).map((agent) => [
        agent.id,
        options.runtimeFactory
          ? options.runtimeFactory(agent)
          : createAgentRuntime({
              workspace: options.workspace,
              agent,
              ...(this.incognito ? { incognito: true } : {}),
              memoryStore: options.memoryStore,
              harnessHost: options.harnessHost,
              // Resolved at spawn (after init), when parentRoomId is known.
              allowSummon: () => allowSummonForTurn(agent, this.isSummonRoom),
              sandbox: () =>
                resolveSandboxPolicy(options.workspace.config.sandbox, agent.sandbox, this.isSummonRoom, {
                  trusted: isTrusted(agent),
                }),
            }),
      ]),
    );
  }

  static async open(options: RoomServiceOptions): Promise<RoomService> {
    const roomId = options.roomId ?? options.workspace.config.room;
    const room = await RoomHandle.open(options.workspace.rootDir, roomId);
    // The incognito flag is immutable, so read it once here and let the
    // constructor strip tools + the turn path skip capture/auto-recall.
    const incognito = options.incognito ?? (await room.state()).incognito === true;
    return new RoomService({ ...options, room, incognito });
  }

  private isSummonRoom = false;

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

  /** Busy = running a turn OR has a live background summon. Guards a service
   * from LRU eviction while its background work would be killed with it. */
  get isBusy(): boolean {
    return Boolean(this.activeTask) || Boolean(this.options.summonHost?.runningChildren(this.roomId).length);
  }

  get activeTaskId(): string | undefined {
    return this.activeTask?.id;
  }

  init(): Promise<void> {
    this.initPromise ??= this.initOnce();
    return this.initPromise;
  }

  private async initOnce(): Promise<void> {
    await Promise.all(Object.values(this.workspace.agents).map((agent) => this.options.memoryStore.init(agent.memoryDir, agent.displayName)));
    const state = await this.room.state();
    this.isSummonRoom = Boolean(state.parentRoomId);
    // Restore the per-agent context accounting so the composer's `ctx` chip is
    // present from first paint after a restart, not blank until the next turn.
    if (state.contextUsage) this.contextUsage = { ...state.contextUsage };
    // Reopen a held context-gate decision (the modal persists across a restart).
    this.contextGate = state.contextGate;

    // Surface a previously saved sanitize proposal (popup reopens after restart).
    const savedProposal = (await readJson(this.sanitizeProposalPath)) as SanitizeProposal | null;
    if (savedProposal?.at && Array.isArray(savedProposal.suggestions)) {
      this.sanitizeStatus = {
        at: savedProposal.at,
        suggestions: savedProposal.suggestions.length,
        ...(savedProposal.appliedAt ? { appliedAt: savedProposal.appliedAt } : {}),
      };
    }

    // Interrupted turn? Resume in the background — never blocks opening.
    if (state.pendingTurn) void this.resumePendingTurn(state.pendingTurn).catch(() => {});
    // Durable queue survivors from a prior process: rebuild their task chips
    // and drain once idle. Voice-channel synthetics are dropped — their call
    // is gone.
    const queue = state.queue ?? [];
    if (queue.length > 0) {
      const stale = queue.filter((message) => message.channel === "voice");
      if (stale.length > 0) {
        await this.room.updateState((current) => {
          current.queue = current.queue?.filter((message) => message.channel !== "voice");
          if (current.queue?.length === 0) delete current.queue;
        });
      }
      this.queuedTasks = queue
        .filter((message) => message.channel !== "voice")
        .map((message) => ({
          id: message.taskId,
          roomId: this.roomId,
          text: message.text,
          targets: message.targets,
          status: "queued" as const,
          startedAt: message.queuedAt,
          // Agent-authored hand-offs/summon callbacks aren't "user →" ghosts.
          ...(message.fromAgentDialogue ? { callback: true } : {}),
        }));
      if (!this.activeTask) void this.drain();
    }
  }

  subscribe(listener: (event: UiEvent) => void): () => void {
    return this.bus.on(listener);
  }

  dispose(): void {
    for (const runtime of Object.values(this.runtimes)) runtime.dispose();
  }

  // --- messaging -------------------------------------------------------------

  async sendMessage(text: string, options: SendMessageOptions = {}): Promise<Task> {
    await this.init();

    let command = parseCommand(text);
    // Harness-native passthrough: an unrecognized `/command` becomes a command
    // TURN to the active agent when that agent opted into nativeCommands and its
    // harness can run them (claude skills like /deep-research). Anything else
    // stays the "unknown command" reply. Rewritten to a message turn here so it
    // rides the normal WAL/queue/streaming path — just flagged nativeCommand.
    if (command.type === "unknown") {
      const target = await this.nativeCommandTarget();
      const agent = this.workspace.agents[target];
      if (agent?.nativeCommands && capabilitiesFor(harnessIdFor(agent, this.workspace)).supportsNativeCommands) {
        command = { type: "message", text };
        options = { ...options, targets: [target], nativeCommand: true };
      } else if (text.trim().split(/\s+/).length > 1) {
        // Not a known command, and no agent can run it as a native command — but
        // it carries content ("/note buy milk", "/deep-research quantum"), so it
        // is the user's MESSAGE, not a typo. Deliver it rather than discard it
        // with an "Unknown command" reply. A user message may never disappear.
        // (A lone contentless "/typo" still falls through to the corrective hint.)
        command = { type: "message", text };
      }
    }
    // Validate routing up-front so unknown-agent errors surface immediately,
    // whether the turn runs now or is queued behind a busy one.
    let targets: string[] = [];
    if (command.type === "message") {
      targets = options.nativeCommand
        ? (options.targets ?? [])
        : (await this.isMonadMessage(text, options))
          ? await this.monadAuthor()
          : (options.targets ?? (await this.routeTargets(text)));
      for (const target of targets) {
        if (!this.workspace.agents[target]) throw new Error(this.unknownAgentMessage(target));
      }
    }

    const task = this.createTask(text, targets);

    // /steer and /cancel must run WHILE a turn is active — steer injects into
    // the running turn, cancel stops it — so neither queues behind it.
    if (command.type === "steer" || command.type === "cancel") {
      this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
      const reply = command.type === "steer" ? await this.runSteerCommand(command.text) : await this.runCancelCommand();
      const event: RoomEvent = { id: `system_${task.id}`, timestamp: new Date().toISOString(), author: "system", text: reply };
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
      task.status = "complete";
      task.endedAt = new Date().toISOString();
      this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.roomId, task });
      return task;
    }

    // Steer-by-default: while an agent turn is streaming, a plain message aimed
    // at that same agent injects into the RUNNING turn (mid-turn guidance)
    // instead of queuing behind it. Queuing is the explicit opt-in
    // (options.queue, from the Cmd/Ctrl+Enter shortcut) or the fallback when
    // steering can't apply — the message is addressed to a different agent,
    // several agents are running, the running harness can't inject, or the
    // message carries attachments (steer is text-only). Uniform: gated on the
    // runtime's supportsSteer, never a harness id.
    let recordedSteerEventId: string | undefined;
    if (
      command.type === "message" &&
      !options.nativeCommand &&
      !options.queue &&
      !options.attachments?.length &&
      this.activeAgentTurn &&
      this.activeAgentTurn.targets.length === 1
    ) {
      const runner = this.activeAgentTurn.targets[0];
      const runtime = this.runtimes[runner];
      const aimedAtRunner = targets.length > 0 && targets.every((id) => id === runner);
      if (aimedAtRunner && runtime?.capabilities.supportsSteer) {
        const steered = await this.steerRunningTurn(runner, text, task);
        if (steered === true) return task;
        // The turn just ended under us: the guidance is ALREADY committed to
        // the transcript (persist-first). Fall through to the queue with the
        // committed event's id riding the entry, so the drained turn replays
        // it without re-recording and the client shows the committed bubble
        // instead of a queued ghost.
        recordedSteerEventId = steered;
      }
    }

    // Busy? Persist to the durable queue and return — it runs on settle and
    // survives a daemon crash in between.
    if (this.activeTask) {
      task.status = "queued";
      if (recordedSteerEventId) task.recorded = true;
      await this.room.enqueue({
        taskId: task.id,
        text,
        targets,
        ...(options.channel === "voice" ? { channel: "voice" as const } : {}),
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
        ...(options.nativeCommand ? { nativeCommand: true } : {}),
        ...(recordedSteerEventId ? { eventId: recordedSteerEventId, recorded: true } : {}),
        queuedAt: task.startedAt,
      });
      this.queuedTasks.push(task);
      this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
      void this.emitSnapshot();
      return task;
    }

    // Idle. A command resolves synchronously so callers can read its system
    // reply right after awaiting; message turns start and stream asynchronously.
    if (command.type !== "message") {
      task.status = "running";
      task.startedAt = new Date().toISOString();
      this.activeTask = task;
      this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
      await this.runCommand(task, command);
      return task;
    }

    // A failed steer's guidance is already committed — the direct run (the
    // turn ended AND settled before we reached the queue check) must not
    // record it a second time; the prompt text still drives the turn.
    this.startTask(task, text, recordedSteerEventId ? { ...options, recordUserMessage: false } : options);
    return task;
  }

  private startTask(task: Task, text: string, options: SendMessageOptions): void {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.activeTask = task;
    this.activeAgentTurn = task;
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
    void this.emitRoomsChanged();

    // Held so cancelActiveTask can await the turn's unwind — the unwind is what
    // commits a streamed partial, and the cancel's settle snapshot must come
    // AFTER that commit or the partial vanishes from the UI until much later.
    this.activeTurnUnwind = this.runAgentTask(task, text, options)
      .catch((error) => {
        if (this.taskCancelled(task)) return;
        this.settleTask(task, "error", error);
      })
      .finally(() => {
        this.activeTurnUnwind = undefined;
      });
  }

  /** Dispatches the next durably-queued message once the room goes idle.
   * Two-phase hand-off: the entry is PEEKED, not dequeued — it stays in
   * state.json.queue until a successor durable record replaces it (the turn's
   * pendingTurn marker, or a command's persisted reply), so a crash anywhere
   * in between re-drains the message instead of losing it. */
  private async drain(): Promise<void> {
    if (this.activeTask) return;
    const next = await this.room.peekQueue();
    if (!next) return;
    const chip = this.queuedTasks.find((task) => task.id === next.taskId);
    this.queuedTasks = this.queuedTasks.filter((task) => task.id !== next.taskId);
    const task = chip ?? this.createTask(next.text, next.targets);
    try {
      // Agent-dialogue hand-offs are agent-authored text, never slash commands —
      // skip command parsing (a reply opening with "/" is prose, not /clear). A
      // native command already decided it's a command turn to a pinned target;
      // re-parsing would just "unknown"-error it, so run it as a message too.
      const command =
        next.fromAgentDialogue || next.nativeCommand ? ({ type: "message", text: next.text } as const) : parseCommand(next.text);
      if (command.type !== "message") {
        task.status = "running";
        task.startedAt = new Date().toISOString();
        this.activeTask = task;
        this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
        await this.runCommand(task, command);
        // The reply is durable (runCommand persists it) — only now consume the
        // entry. A crash before this line re-runs the command on boot
        // (at-least-once; commands are idempotent-enough, loss is not).
        await this.room.spliceQueued(next.taskId);
        return;
      }
      this.startTask(task, next.text, {
        targets: next.targets,
        queued: next,
        ...(next.channel ? { channel: next.channel } : {}),
        ...(next.attachments?.length ? { attachments: next.attachments } : {}),
        ...(next.fromAgentDialogue ? { fromAgentDialogue: true, recordUserMessage: false } : {}),
        ...(next.recorded ? { recordUserMessage: false } : {}),
        ...(next.nativeCommand ? { nativeCommand: true } : {}),
      });
    } catch (error) {
      this.settleTask(task, "error", error);
    }
  }

  private async routeTargets(text: string): Promise<string[]> {
    const route = planMentionRoute(text, Object.keys(this.workspace.agents), await this.roomDefaultTarget());
    if (!route.ok) {
      throw new Error(
        `Unknown agent: ${route.unknown.map((id) => `@${id}`).join(", ")}. Available agents: ${Object.keys(this.workspace.agents)
          .map((id) => `@${id}`)
          .join(", ")}`,
      );
    }
    return route.targets;
  }

  /** Fallback target for a message with no leading @mention: the room's active
   * agent (the last one addressed here), or the workspace defaultAgent when the
   * room has none yet — or its active agent was since removed. Per-room, so
   * every room remembers who you were last talking to independently. */
  private async roomDefaultTarget(): Promise<string> {
    const active = (await this.room.state()).activeAgent;
    return active && this.workspace.agents[active] ? active : this.workspace.config.defaultAgent;
  }

  /** Remember the agent a turn addressed as this room's active agent (persisted,
   * best-effort). The last target of a broadcast wins — that's who a bare next
   * message goes to. Skips unknown ids so a stale write can't wedge routing. */
  private async rememberActiveAgent(targets: string[]): Promise<void> {
    const next = [...targets].reverse().find((id) => this.workspace.agents[id]);
    if (!next) return;
    if ((await this.room.state()).activeAgent === next) return;
    await this.room.updateState((state) => {
      state.activeAgent = next;
    });
  }

  /** Room agent-dialogue: after @author's reply commits, if the room toggle is
   * on, let any OTHER known agent it @mentioned (anywhere in the reply) respond
   * in this room. Bounded by AGENT_DIALOGUE_MAX_HOPS consecutive hand-offs since
   * the last human message so a mutual @mention can't loop forever. */
  private async maybeDispatchAgentDialogue(author: string, reply: string): Promise<void> {
    if (!(await this.room.state()).agentDialogue) return;
    const targets = mentionedAgents(reply, new Set(Object.keys(this.workspace.agents))).filter((id) => id !== author);
    if (targets.length === 0) return;
    if (this.agentDialogueHops >= AGENT_DIALOGUE_MAX_HOPS) {
      this.emitSystemNote(`Agent dialogue paused after ${AGENT_DIALOGUE_MAX_HOPS} hops (loop guard) — send a message to continue.`);
      return;
    }
    this.agentDialogueHops += 1;
    await this.enqueueAgentDialogue(targets, reply);
  }

  /** Queue an agent-authored turn durably. The addressing text is already in
   * the transcript, so the turn replays it as the "newest message" WITHOUT
   * re-recording (recordUserMessage:false, set by drain from the
   * fromAgentDialogue flag). Never command-parsed. Backs both agent-dialogue
   * hand-offs (queued mid-turn; settle drains) and summon callbacks (queued
   * from outside; kick drain when idle). Marked `callback` so the client
   * renders no "user →" ghost — the driving text is an agent message/pointer,
   * not something a person typed. */
  private async enqueueAgentDialogue(targets: string[], text: string): Promise<void> {
    const task = this.createTask(text, targets);
    task.status = "queued";
    task.callback = true;
    await this.room.enqueue({ taskId: task.id, text, targets, fromAgentDialogue: true, queuedAt: task.startedAt });
    this.queuedTasks.push(task);
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
    void this.emitSnapshot();
    if (!this.activeTask) void this.drain();
  }

  /** Deliver a background worker's result into this room (the summon callback):
   * append it as a COLLAPSED, summon-labeled note authored by the worker, then
   * — deliver:"turn" — nudge the caller agent to continue (Claude-Code subagent
   * style). The nudge STEERS the caller's running turn if it has one, else it
   * runs a fresh turn; either way the caller reads the full result from the note
   * (loaded as context past its cursor) and no misleading "user →" bubble is
   * created. Durable: the note is on disk before we nudge, and the nudge itself
   * rides the durable queue when it can't run now. */
  async deliverAgentResult(fromAgentId: string, reply: string, delivery: SummonResultDelivery): Promise<void> {
    await this.init();
    await this.postAgentNote(fromAgentId, reply, {
      summonResult: { childRoomId: delivery.childRoomId, failed: delivery.failed },
    });
    const target = delivery.triggerTarget;
    if (target && this.workspace.agents[target]) await this.triggerSummonCallback(target, reply, delivery);
  }

  /** Re-invoke a caller agent after its summon returned — steer its live turn if
   * it has one (the harness picks up the nudge at the next tool boundary), else
   * a fresh turn. Never records a "user →" bubble. Two paths, two shapes:
   * - STEER: the running turn began before the result note existed and can't
   *   re-read the transcript, so the steer carries the FULL result inline.
   * - FRESH TURN: the note is already on disk and loads as context (past the
   *   caller's cursor), so the prompt is a short pointer, not a re-paste
   *   (recordUserMessage:false / callback:true → no user ghost). */
  private async triggerSummonCallback(target: string, reply: string, delivery: SummonResultDelivery): Promise<void> {
    const runtime = this.runtimes[target];
    if (this.activeAgentTurn?.targets.includes(target) && runtime?.capabilities.supportsSteer) {
      const header = delivery.failed
        ? `Your summon '${delivery.childRoomId}' FAILED (decide how to proceed):`
        : `Your summon '${delivery.childRoomId}' returned:`;
      const ok = (await runtime.steer?.(this.roomId, `${header}\n\n${reply}`)) ?? false;
      if (ok) return; // else the turn just ended — fall through to a fresh turn
    }
    const pointer = delivery.failed
      ? `Your summon '${delivery.childRoomId}' FAILED — its error is in the message just above. Decide how to proceed (retry, work around, or report it).`
      : `Your summon '${delivery.childRoomId}' finished — its result is in the message just above. Continue from it.`;
    await this.enqueueAgentDialogue([target], pointer);
  }

  /** Resolves when the room has FULLY settled: no running task, no durable
   * pending turn, an empty queue — stable across two consecutive checks
   * (init() resumes a prior process's turn asynchronously, so a single
   * idle observation right after open can be a lie). Unlike waitForIdle
   * (one task), this covers everything the room is still going to run —
   * the summon-recovery wait. */
  async waitForSettled(): Promise<void> {
    await this.init();
    let stable = 0;
    for (;;) {
      if (this.activeTask) {
        stable = 0;
        await this.waitForIdle();
      }
      const state = await this.room.state();
      const settled = !this.activeTask && !state.pendingTurn && (state.queue?.length ?? 0) === 0;
      stable = settled ? stable + 1 : 0;
      if (stable >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Mark this (summon child) room's durable delivery record as delivered —
   * called by the coordinator AFTER the result landed in the parent room, so
   * a crash in between re-delivers instead of losing the result. */
  async markSummonDelivered(): Promise<void> {
    await this.init();
    await this.room.updateState((state) => {
      if (state.summon) state.summon.status = "delivered";
    });
  }

  /** A live-only system line in the room (not persisted) — used for transient
   * room notices like the agent-dialogue loop-guard pause. */
  private emitSystemNote(text: string): void {
    this.emit({
      type: "room-event",
      workspaceId: this.workspaceId,
      roomId: this.roomId,
      event: { id: newRoomEventId(), timestamp: new Date().toISOString(), author: "system", text },
    });
  }

  /** Toggle room agent-dialogue (agents replying to each other's @mentions).
   * Persisted per-room; resets the hop budget so a fresh enable starts clean. */
  async setAgentDialogue(on: boolean): Promise<void> {
    await this.init();
    await this.room.updateState((state) => {
      if (on) state.agentDialogue = true;
      else delete state.agentDialogue;
    });
    this.agentDialogueHops = 0;
    await this.emitSnapshot();
  }

  async cancelActiveTask(): Promise<Task | undefined> {
    await this.init();
    // Stop targets the RUNNING turn only. Queued messages are the user's own
    // work and SURVIVE a stop (NO PROGRESS EVER LOST) — they run next, against
    // the now-idle runner, via settle's normal drain.
    const task = this.activeTask;
    if (!task) return undefined;
    // Mark first so in-flight event handling sees the cancellation.
    task.status = "cancelled";
    // A /compact command task carries no targets — the mid-compaction agents
    // live in compactingAgents. Abort them too, or "stop" leaves the harness
    // pass running and the session compacts anyway after we said cancelled.
    for (const target of this.compactingAgents) this.compactCancels.add(target);
    const targets = new Set([...task.targets, ...this.compactingAgents]);
    // abort() is authoritative (host kills a runner that won't settle), so when
    // it resolves the runner is idle or dead — the next turn can never bounce
    // off a ghost "runner busy" lock.
    await Promise.allSettled([...targets].map((target) => this.runtimes[target]?.abort()).filter(Boolean));
    // Let the aborted turn unwind: it commits any streamed partial and emits
    // its room-event. Settling AFTER that keeps the partial visible in the
    // settle snapshot instead of blanking it. Bounded — the abort above already
    // guaranteed the stream is finished; this is just the commit I/O.
    const unwind = this.activeTurnUnwind;
    if (unwind) {
      await Promise.race([unwind, new Promise((resolve) => setTimeout(resolve, 10_000).unref?.())]);
    }
    if (this.activeTask?.id === task.id) this.settleTask(task, "cancelled");
    return task;
  }

  private async clearQueued(): Promise<void> {
    await this.room.clearQueue();
    const dropped = this.queuedTasks;
    this.queuedTasks = [];
    for (const task of dropped) {
      task.status = "cancelled";
      task.endedAt = new Date().toISOString();
      this.recentTasks = [...this.recentTasks.slice(-9), task];
      this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.roomId, task });
    }
  }

  /** Resolves when no task is running; rejects after timeoutMs (when given). */
  async waitForIdle(timeoutMs?: number): Promise<void> {
    await this.init();
    if (!this.activeTask) return;
    await new Promise<void>((resolveIdle, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              unsubscribe();
              reject(new Error("Room is busy with another task"));
            }, timeoutMs);
      const unsubscribe = this.subscribe((event) => {
        if (event.type !== "task-end" && event.type !== "task-error") return;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolveIdle();
      });
    });
  }

  // --- the turn --------------------------------------------------------------

  private async runAgentTask(task: Task, text: string, options: SendMessageOptions): Promise<void> {
    // A native command is already pinned to the active agent — it never fans out
    // through the monad.
    if (!options.nativeCommand && (await this.isMonadMessage(text, options))) {
      await this.runMonadTask(task, text, options);
      return;
    }

    const channel = options.channel === "voice" ? ("voice" as const) : undefined;
    const attachments = options.attachments?.length ? options.attachments : undefined;
    if (options.recordUserMessage !== false) {
      // A drained queue entry commits under a durably pre-reserved event id so
      // a crash between reserve and append (or append and queue-consume)
      // replays idempotently instead of dropping or doubling the message.
      const queued = options.queued;
      let userEvent: RoomEvent | undefined;
      if (queued?.eventId && (await this.room.hasEvent(queued.eventId))) {
        userEvent = undefined; // already on disk from the pre-crash run
      } else {
        let eventId = queued?.eventId;
        if (queued && !eventId) {
          eventId = newRoomEventId();
          await this.room.assignQueuedEventId(queued.taskId, eventId);
        }
        userEvent = await this.room.addUserMessage(text, task.targets, channel, attachments, eventId);
      }
      if (userEvent) this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event: userEvent });
      // Authoritative refresh right after the commit: this snapshot has the
      // queued ghost dropped AND the committed user event present, so it
      // reconciles the ghost→committed swap on the client even when this turn
      // was drained behind a settling one whose (earlier) snapshot still showed
      // the ghost. Without it the swap depends on snapshot/room-event ordering.
      void this.emitSnapshot();
    }
    // A human message ends any agent-dialogue chain and resets its hop budget.
    if (!options.fromAgentDialogue) this.agentDialogueHops = 0;
    // This room is now talking to whoever this turn addresses.
    await this.rememberActiveAgent(task.targets);

    const remaining = [...task.targets];
    for (const target of task.targets) {
      if (this.taskCancelled(task)) {
        await this.room.clearPendingTurn();
        return;
      }
      const agent = this.workspace.agents[target];
      const runtime = this.runtimes[target];
      const state = await this.room.state();
      // A NEW agent (never spoke here → no cursor) loads the whole back-transcript.
      // An EXISTING agent normally loads only events since its cursor — everything
      // earlier lives in its harness session. When that session is GONE (crash,
      // dropped handle, pruned store) the cursor is a lie: trusting it would start
      // the agent mid-conversation with silent amnesia, so replay from 0 instead.
      // Either full load is gated if large. Skipped on the resumed run
      // (cursorOverride set / bypass) and in voice calls (no modal).
      //
      // A missing session only counts as LOST while the cursor claims context
      // beyond the agent's floor: after a DELIBERATE reset (rewind/sanitize set
      // cursor == floor == the seed base) the capped cursor IS the intended
      // seed — replaying it is by design, not amnesia, so no gate fires.
      const isNewAgent = state.agentCursors[target] === undefined;
      const sessionLost =
        !isNewAgent &&
        (state.agentCursors[target] ?? 0) > (state.contextFloors?.[target] ?? 0) &&
        options.cursorOverride === undefined &&
        (runtime.hasDurableSession?.(this.roomId) ?? true) === false;
      // Durable compaction: if this agent explicitly /compacted (floor > 0) and its
      // harness session is now LOST, replay [stored summary + tail after floor]
      // instead of the full raw transcript — so the compaction survives the session
      // loss instead of silently reverting to everything-from-0. The stored summary
      // is trusted only while its floorIdx still equals the live floor (a rewind
      // that moved the floor auto-invalidates it, and clears it besides).
      const floor = state.contextFloors?.[target] ?? 0;
      const storedCompaction = sessionLost && floor > 0 ? await this.room.readCompaction(target) : undefined;
      const replaySummary = storedCompaction && storedCompaction.floorIdx === floor ? storedCompaction.summary : undefined;
      const cursor =
        options.cursorOverride ?? (replaySummary !== undefined ? floor : sessionLost ? 0 : (state.agentCursors[target] ?? 0));
      const { events: rawEvents } = await this.room.eventsFrom(cursor);
      // System events (slash-command replies) are persisted for the human UI
      // but are room chrome, not conversation — keep them out of what the agent
      // sees so /help, /recall, /compact results never pollute its context.
      // Cursor space still counts their lines, so paging stays aligned with
      // the on-disk transcript.
      const events = rawEvents.filter((event) => event.author !== "system");
      // NO AUTOMATIC TRUNCATION. A new agent or a session-lost replay ALWAYS
      // loads the full context (from cursor 0 / the agent's floor). The context
      // is never silently shrunk, windowed, or summarized behind the user's
      // back — the only thing that ever reduces context is an explicit /compact
      // the user types. (The old size-based context gate that forced a
      // last-N/compact choice on big first loads is gone by design.)
      const activeRoleName = state.activeRoles[target];
      const activeRole = activeRoleName ? await resolveAgentRole(agent, activeRoleName) : undefined;
      if (activeRoleName && !activeRole) {
        this.emit({
          type: "task-error",
          workspaceId: this.workspaceId,
          roomId: this.roomId,
          task,
          error: `Active role not found for @${agent.id}: ${activeRoleName}`,
        });
      }

      // WAL step 1: reserve the reply's event id and persist the in-flight
      // marker BEFORE streaming — an interruption leaves a resumable record.
      // The same atomic write consumes the drained queue entry (if any): the
      // message's durable custody moves queue → WAL with no gap. Idempotent
      // across the multi-target loop (only the first write finds the entry).
      const eventId = newRoomEventId();
      await this.room.markPendingTurn(
        {
          id: task.id,
          eventId,
          prompt: text,
          ...(attachments ? { attachments } : {}),
          targets: [...remaining],
          agentId: target,
          partialReply: "",
          ...(channel ? { channel } : {}),
          startedAt: new Date().toISOString(),
        },
        options.queued ? { consumeQueuedTaskId: options.queued.taskId } : undefined,
      );
      // Seed the live-turn mirror so a mid-turn (re)subscribe renders it at once.
      this.liveTurn = { eventId, taskId: task.id, agentId: target, startedAt: new Date().toISOString(), text: "", details: {} };
      let lastFlush = 0;
      let lastFlushedReply = "";

      // Auto-recall never blocks or fails a turn: the hook returns "" on any
      // miss and room-service treats "" as absent. A context-gate "compact"
      // resume overrides it with the room summary for this one turn. The
      // active-context ref lets recall drop self-matches from THIS room while
      // keeping compacted-away history reachable.
      // recallOverride (a context-gate/session-lost resume summary of THIS room's
      // own transcript) still applies in an incognito room; only the long-term
      // memory auto-recall is suppressed — nothing about this room reaches the
      // agent's context from the memory subsystem.
      // On a durable-compaction replay, the stored summary IS the pre-floor
      // context — feed it as a labelled block (the raw messages below the floor
      // stay recall-reachable), alongside any auto-recall for this turn.
      const compactionBlock =
        replaySummary !== undefined
          ? `The earlier part of this conversation was compacted. Summary of everything before the recent messages (the raw messages remain reachable via recall):\n\n${replaySummary}`
          : undefined;
      const autoRecall = options.recallOverride?.trim()
        ? options.recallOverride
        : this.incognito
          ? undefined
          : (await this.options.memory?.autoRecallBlock(target, text, {
              roomId: this.roomId,
              floorIdx: floor,
            })) || undefined;
      const recall = compactionBlock ? [compactionBlock, autoRecall].filter(Boolean).join("\n\n") : autoRecall;

      this.fireHooks("preTurn", { agentId: target, message: text.slice(0, HOOK_TEXT_CAP), ...(channel ? { channel } : {}) });

      let turn: Awaited<ReturnType<typeof runAgentTurn>>;
      try {
        turn = await runAgentTurn({
          runtime,
          input: {
            roomId: this.roomId,
            message: text,
            ...(attachments ? { attachments } : {}),
            transcript: events,
            activeRole,
            channel: options.channel,
            thinking: options.thinking,
            recall,
            ...(options.nativeCommand ? { nativeCommand: true } : {}),
          },
          isCancelled: () => this.taskCancelled(task),
          onEvent: (event) => {
            if (event.type === "model-fallback") {
              this.modelFallbacks[target] = { from: event.fromModel, to: event.toModel, reason: event.reason };
            }
            if (event.type === "context-usage") {
              // The window (maxTokens) only rides the turn-end event; keep the
              // last-known one, else fall back to the harness's a-priori window,
              // so mid-turn updates (and the first turn after a restart, when no
              // window has been learned yet) still render a live % chip instead
              // of a raw token count. The window is spec data, not a branch.
              const aprioriWindow = contextWindowFor(harnessIdFor(agent, this.workspace), agent.model?.name);
              const maxTokens = event.maxTokens ?? this.contextUsage[target]?.maxTokens ?? aprioriWindow;
              const usage = { usedTokens: event.usedTokens, ...(maxTokens ? { maxTokens } : {}) };
              this.contextUsage[target] = usage;
              // Persist durably (best-effort) so the chip survives a restart.
              void this.room
                .updateState((current) => {
                  current.contextUsage = { ...(current.contextUsage ?? {}), [target]: usage };
                })
                .catch(() => {});
            }
            this.applyLiveTurn(eventId, event);
            this.emit(this.toUiEvent(task.id, agent.id, eventId, event));
            if (event.type === "tool-end") {
              this.fireHooks("toolUse", { agentId: target, toolName: event.toolName, isError: event.isError });
            }
          },
          onProgress: async (reply, event) => {
            if (reply === lastFlushedReply) return;
            // Text deltas are throttled; any OTHER event (a tool starting, a
            // thinking block) flushes immediately — it marks a block boundary,
            // and the prose tail must not sit unpersisted through a long tool
            // run (the flush froze at "If you want something r" while tools
            // streamed for a minute — that stale flush was all a stop kept).
            const now = Date.now();
            if (event.type === "text-delta" && now - lastFlush < PARTIAL_FLUSH_MS) return;
            lastFlush = now;
            lastFlushedReply = reply;
            await this.room.flushPartialReply(reply);
          },
        });
      } catch (error) {
        // Last-resort net: runAgentTurn no longer throws for a dying stream
        // (it returns the accumulator with `error` set) — reaching here means
        // the failure fired before any event streamed. Preserve whatever the
        // flush recorded and clear the marker (never replay a terminally-failed
        // turn — poison pill).
        const pending = (await this.room.state()).pendingTurn;
        const partial = pending?.partialReply ?? "";
        this.liveTurn = undefined;
        if (partial.trim()) await this.commitReply(target, eventId, partial, {}, channel);
        else await this.room.clearPendingTurn();
        await this.captureEpisode(target, text, partial, "error", {}, channel);
        throw error;
      }

      // A turn that ran clean on the configured model retires the standing
      // fallback warning; one that fell back (re)arms it.
      if (!turn.details.modelFallback) delete this.modelFallbacks[target];

      // Cancelled, failed, or completed: ALL commit what was produced. A user
      // stop lands as a stream death (abort → turn-error → the runtime stream
      // throws), so `turn.error` with the cancel flag set IS the normal stop
      // shape — never a reason to drop the accumulator. A stop is a deliberate
      // end, not an eraser: the reply text, the tool calls, and the thinking
      // all commit exactly as streamed (NO PROGRESS EVER LOST).
      const cancelled = turn.cancelled || this.taskCancelled(task);
      const failed = turn.error !== undefined && !cancelled;
      if (turn.error !== undefined || cancelled) finalizeInterruptedTools(turn.details);
      const reply = turn.reply.trim();
      // An interrupted turn that produced tools/thinking but no prose yet still
      // commits — stopping an agent mid-tool-phase must not vanish the work the
      // user watched happen. (A CLEAN empty turn stays uncommitted as before.)
      const interruptedProgress = (cancelled || failed) && Boolean(turn.details.tools?.length || turn.details.thinking);
      // Multi-target hand-off: this target's commit (or clear) must not open a
      // window where the remaining targets' owed turns exist in memory only —
      // the SAME atomic state write that retires this target's marker installs
      // the next target's (no eventId: a boot resume reruns it via sendMessage).
      // A cancel or failure deliberately ends the whole task: no hand-off.
      const rest = remaining.slice(1);
      const nextPending: PendingTurn | undefined =
        !cancelled && !failed && rest.length > 0
          ? {
              id: task.id,
              prompt: text,
              ...(attachments ? { attachments } : {}),
              targets: rest,
              agentId: rest[0],
              partialReply: "",
              ...(channel ? { channel } : {}),
              startedAt: new Date().toISOString(),
            }
          : undefined;
      // The committed room-event now carries the reply; the live mirror is spent.
      this.liveTurn = undefined;
      if (reply || interruptedProgress) await this.commitReply(target, eventId, reply, turn.details, channel, nextPending);
      else if (nextPending) await this.room.markPendingTurn(nextPending);
      else await this.room.clearPendingTurn();

      if (failed) {
        // Genuine mid-stream failure (not a user stop): the progress is now
        // durable; surface the error so the task settles as error.
        await this.captureEpisode(target, text, reply, "error", turn.details, channel);
        throw turn.error;
      }

      if (reply || interruptedProgress) await this.captureEpisode(target, text, reply, cancelled ? "cancelled" : "complete", turn.details, channel);
      this.fireHooks("postTurn", {
        agentId: target,
        reply: reply.slice(0, HOOK_TEXT_CAP),
        outcome: cancelled ? "cancelled" : "complete",
        tools: [...new Set((turn.details.tools ?? []).map((tool) => tool.toolName))],
      });

      if (cancelled) return;
      remaining.shift();
      // Let another agent this reply @mentions pick it up (room toggle + cap).
      if (reply) await this.maybeDispatchAgentDialogue(target, reply);
    }

    if (!this.taskCancelled(task)) this.settleTask(task, "complete");
  }

  /** The ctx chip's usage figure for the snapshot. Live usage wins, but the
   * window size (maxTokens) is only learned from a clean turn-end `result`; a
   * fresh agent, a room whose turns were all steered/cancelled before a result,
   * or a post-/compact entry may have usedTokens with no window. Fall back to the
   * harness's a-priori context window so the chip renders a % instead of a raw
   * token count. Uniform across harnesses — the window is spec data, not a branch. */
  private contextFor(agent: AgentDef): { usedTokens: number; maxTokens?: number } | undefined {
    const live = this.contextUsage[agent.id];
    if (!live || live.maxTokens) return live;
    const window = contextWindowFor(harnessIdFor(agent, this.workspace), agent.model?.name);
    return window ? { usedTokens: live.usedTokens, maxTokens: window } : live;
  }

  // --- context gate ----------------------------------------------------------

  /** Hold a big first-load turn — a new agent's first seed, or an existing
   * agent replaying history because its harness session vanished. Persists the
   * decision (durable + snapshot) and DOESN'T run it. The user message is
   * already in the transcript; a later resolveContextGate replays the turn
   * with the chosen amount of context. */
  private async openContextGate(
    agent: AgentDef,
    message: string,
    estTokens: number,
    totalEvents: number,
    attachments: MessageAttachment[] | undefined,
    reason: "new-agent" | "session-lost",
  ): Promise<void> {
    const window = contextWindowFor(harnessIdFor(agent, this.workspace), agent.model?.name);
    const gate: ContextGatePending = {
      agentId: agent.id,
      message,
      estTokens,
      totalEvents,
      ...(window ? { window } : {}),
      ...(attachments?.length ? { attachments } : {}),
      reason,
      at: new Date().toISOString(),
    };
    await this.room.updateState((current) => {
      current.contextGate = gate;
    });
    this.contextGate = gate;
    await this.emitSnapshot();
  }

  /** Resolve a held gate: replay the held turn with the chosen context.
   * Affects ONLY this agent's seed — the transcript and every other agent's
   * session are untouched. */
  async resolveContextGate(choice: "full" | "last" | "compact", n?: number): Promise<void> {
    await this.init();
    const gate = this.contextGate ?? (await this.room.state()).contextGate;
    if (!gate) return;
    await this.room.updateState((current) => {
      delete current.contextGate;
    });
    this.contextGate = undefined;
    await this.emitSnapshot();

    const base: SendMessageOptions = {
      targets: [gate.agentId],
      recordUserMessage: false, // already recorded when the turn was first held
      bypassContextGate: true,
      ...(gate.attachments?.length ? { attachments: gate.attachments } : {}),
    };
    if (choice === "last") {
      const keep = Number.isInteger(n) && (n as number) > 0 ? (n as number) : CONTEXT_GATE_LAST_N;
      const start = Math.max(0, gate.totalEvents - keep);
      // Everything before the loaded tail never reaches this agent's context —
      // recall may (must) reach it (active-context floor, MEMORY-DESIGN.md §7).
      await this.setContextFloor(gate.agentId, start);
      await this.sendMessage(gate.message, { ...base, cursorOverride: start });
      return;
    }
    if (choice === "compact") {
      const summary = await this.summarizeRoom(gate.agentId, gate.totalEvents);
      // The agent gets a summary, not the raw history — the raw events below
      // the gate point stay recall-reachable.
      await this.setContextFloor(gate.agentId, gate.totalEvents);
      await this.sendMessage(gate.message, {
        ...base,
        cursorOverride: gate.totalEvents, // no raw transcript — the summary IS the context
        recallOverride: `Summary of the conversation so far (compacted for you only):\n\n${summary}`,
      });
      return;
    }
    // "full": load everything from the room's start. bypass avoids re-gating.
    await this.setContextFloor(gate.agentId, 0);
    await this.sendMessage(gate.message, { ...base, cursorOverride: 0 });
  }

  /** Persist an agent's active-context floor: the transcript line index below
   * which content is NOT in its live context (context-gate choice or /compact).
   * Recall keeps everything below the floor reachable and treats everything at
   * or above it as already-in-context (self-match exclusion). */
  private async setContextFloor(agentId: string, floorIdx: number): Promise<void> {
    await this.room.updateState((current) => {
      if (floorIdx <= 0) {
        if (current.contextFloors) delete current.contextFloors[agentId];
        return;
      }
      current.contextFloors = { ...(current.contextFloors ?? {}), [agentId]: floorIdx };
    });
  }

  /** The asking agent's active-context window in THIS room — what recall's
   * self-match exclusion needs (daemon passes it for harness recall calls). */
  async recallContext(agentId: string): Promise<ActiveContextRef> {
    await this.init();
    const state = await this.room.state();
    return { roomId: this.roomId, floorIdx: state.contextFloors?.[agentId] ?? 0 };
  }

  /** One LLM pass distilling the room (up to the gate point) into a briefing for
   * a joining agent. Degrades to a raw transcript slice if no llm is wired.
   * Surfaces the pass as a "compacting" status with a ticking elapsed — the same
   * UI the /compact command drives — so the context-gate "Compact & join" path
   * isn't a silent black box. (This is a seed-time briefing, not a harness
   * session compaction, so it shares the status but not the compact() call.) */
  private async summarizeRoom(target: string, uptoEvents: number): Promise<string> {
    const { events } = await this.room.eventsFrom(0);
    const rendered = renderRoomTranscript(events.slice(0, uptoEvents));
    // Cap the summarizer input, biased to the TAIL, so a huge room can't
    // overflow the model's context window (→ throw → garbage fallback). A
    // joining agent most needs recent context, and every fallback below now
    // returns the recent tail — never the ancient head, which was useless for
    // continuity (the "cut off mid-sentence, only the early thread" briefing).
    const input =
      rendered.length > MAX_SUMMARY_INPUT_CHARS
        ? `[…earlier history omitted for length…]\n\n${rendered.slice(-MAX_SUMMARY_INPUT_CHARS)}`
        : rendered;
    const llm = this.options.llm;
    if (!llm) return input.slice(-4000);
    // Use the default consolidation model, NOT the joining agent's model: an
    // agent on an oauth subscription (e.g. anthropic/opus via Claude) is not in
    // the pi-ai model registry and has no API key there, so forcing its model
    // makes the summary throw and silently fall back to a raw transcript slice.
    // The consolidation default is the same reliably-authed model memory
    // consolidation already uses.
    // Mark the joining agent "compacting" and seed the job size so the panel/
    // composer/statusbar show a real number and a ticking elapsed for the whole
    // (possibly long) summary pass. A single LLM call can't stream token deltas,
    // so the elapsed timer carries the progress.
    this.compactingAgents.add(target);
    this.compactProgress.set(target, { startedAt: Date.now(), contextTokens: estimateTokens(input) });
    await this.emitSnapshot();
    try {
      const summary = await llm({ system: CONTEXT_SUMMARY_SYSTEM, user: input });
      const text = summary.trim() || input.slice(-4000);
      const prev = this.compactProgress.get(target);
      if (prev) this.compactProgress.set(target, { ...prev, outputTokens: estimateTokens(text) });
      return text;
    } catch {
      return input.slice(-4000); // summarizer failure never blocks the resume
    } finally {
      this.compactingAgents.delete(target);
      this.compactProgress.delete(target);
      await this.emitSnapshot();
    }
  }

  /** WAL step 2: append the reply event (details ON it), then one atomic state
   * write clearing the marker and advancing the cursor. */
  private async commitReply(agentId: string, eventId: string, reply: string, details: EventDetails, channel: "voice" | undefined, nextPending?: PendingTurn): Promise<void> {
    // Blocks count only when they encode structure the plain reply text doesn't
    // already carry (a steer marker, a tool, a thinking span) — a prose-only
    // turn stays detail-less exactly as before, so nothing bloats.
    const hasDetails =
      details.model ||
      details.thinkingStarted ||
      details.thinking ||
      details.tools?.length ||
      details.blocks?.some((block) => block.kind !== "text");
    const event: RoomEvent = {
      id: eventId,
      timestamp: new Date().toISOString(),
      author: agentId,
      text: reply,
      ...(channel ? { channel } : {}),
      ...(hasDetails ? { details } : {}),
    };
    // commitTurn computes the cursor from the reply's own line (sweeping the
    // mid-turn steers/notes the live turn already saw) and, for a multi-target
    // turn, installs the next target's marker in the same atomic write.
    await this.room.commitTurn(event, nextPending);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
  }

  /** Episodic capture is best-effort derived data: a failure must never fail
   * the turn that produced it. */
  private async captureEpisode(
    agentId: string,
    task: string,
    reply: string,
    outcome: EpisodeCapture["outcome"],
    details: EventDetails,
    channel: "voice" | undefined,
  ): Promise<void> {
    if (!this.options.memory) return;
    // Incognito rooms leave no episodic trace: nothing from a turn here is ever
    // captured into memory (guards all captureEpisode call sites at once).
    if (this.incognito) return;
    const tools = [...new Set((details.tools ?? []).map((tool) => tool.toolName))];
    try {
      await this.options.memory.capture(agentId, {
        roomId: this.roomId,
        task,
        reply,
        outcome,
        ...(tools.length ? { tools } : {}),
        ...(channel ? { channel } : {}),
      });
    } catch {
      // Derived data; the transcript already has the full turn.
    }
  }

  async runConsolidateCommand(agentId?: string): Promise<string> {
    const target = agentId ?? (await this.roomDefaultTarget());
    if (!this.workspace.agents[target]) return `Unknown agent: ${target}`;
    if (!this.options.memory) return "Memory consolidation is not available in this workspace.";
    const result = await this.options.memory.consolidate(target, { force: true });
    if (!result.ran) return `Consolidation skipped for @${target}: ${result.reason ?? "nothing to do"}.`;
    return `Consolidated @${target}: ${result.episodesSeen} episodes reviewed → ${result.factsAdded} facts added, ${result.factsInvalidated} superseded, ${result.memoryEdits} core-memory edits${result.opsSkipped ? `, ${result.opsSkipped} ops skipped` : ""}.`;
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
  private async steerRunningTurn(target: string, text: string, task: Task): Promise<true | string> {
    const event = await this.room.addUserMessage(text, [target]);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
    const ok = (await this.runtimes[target]?.steer?.(this.roomId, text)) ?? false;
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

  /** /steer: inject guidance into the RUNNING turn (capability-gated data —
   * pi session.steer, codex turn/steer; claude declines). The guidance is
   * recorded as a user event for history, but the running harness already
   * received it, and the commit cursor advances past it — so it is never
   * replayed as fresh context. */
  async runSteerCommand(text?: string): Promise<string> {
    const guidance = text?.trim();
    if (!guidance) return "Usage: /steer <guidance for the running turn>";
    const task = this.activeTask;
    const target = task?.targets.find((candidate) => this.runtimes[candidate]);
    if (!task || !target) return "No agent turn is running — just send a normal message.";
    const runtime = this.runtimes[target];
    if (!runtime.capabilities.supportsSteer) return `@${target}'s harness does not support mid-turn steering. Cancel and resend instead.`;
    const event = await this.room.addUserMessage(guidance, [target]);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
    const ok = (await runtime.steer?.(this.roomId, guidance)) ?? false;
    // Same stream-position marker as steer-by-default (see steerRunningTurn).
    if (ok) runtime.injectEvent?.({ type: "steered", eventId: event.id });
    return ok ? `Steering @${target}'s running turn.` : `Could not steer @${target} — the turn may have just finished.`;
  }

  /** /compact: hand the agent's session to its HARNESS's own compaction
   * (pi session.compact, claude /compact, codex thread/compact/start) — gaia
   * never re-implements summarization. Uniform: capability-gated, never
   * id-branched. */
  async runCompactCommand(agent?: string): Promise<CommandReply> {
    const target = agent ?? (await this.roomDefaultTarget());
    if (!this.workspace.agents[target]) return this.unknownAgentMessage(target);
    const runtime = this.runtimes[target];
    if (!runtime.capabilities.supportsCompact || !runtime.compact) {
      return `@${target}'s harness has no native session compaction.`;
    }
    // `activeTask` here is the /compact command's own task; only a real
    // streaming agent turn should block compaction.
    if (this.activeAgentTurn) return "A turn is running — /cancel it first, or wait for it to finish.";
    // Mark the agent "compacting" and seed progress with the job size we already
    // know (its live context usage) + a start time, so the UI shows a real
    // number and a ticking elapsed for the whole (possibly long) harness pass.
    this.compactingAgents.add(target);
    const startedAt = Date.now();
    const usedTokens = this.contextUsage[target]?.usedTokens;
    this.compactProgress.set(target, { startedAt, ...(usedTokens ? { contextTokens: usedTokens } : {}) });
    this.lastCompactEmit = startedAt;
    await this.emitSnapshot();
    try {
      const { compacted, message, summary } = await runtime.compact(this.roomId, (update) => {
        const prev = this.compactProgress.get(target);
        if (!prev) return;
        this.compactProgress.set(target, { ...prev, ...update });
        const now = Date.now();
        if (now - this.lastCompactEmit < 500) return; // coalesce bursts of token deltas
        this.lastCompactEmit = now;
        void this.emitSnapshot();
      });
      // The harness just evicted this agent's raw history into a summary —
      // everything up to now is recall-reachable again (active-context floor).
      const { nextCursor } = await this.room.eventsFrom(0);
      await this.setContextFloor(target, nextCursor);
      // Durable compaction: persist the harness's own summary keyed to this floor,
      // so a later session loss reloads [summary + tail after floor] instead of the
      // full raw transcript (undoing the compaction) or a thin summary-less tail.
      // No summary (harness can't surface one) → clear any stale entry; the reload
      // then falls back to raw context rather than trusting a wrong summary.
      if (compacted && summary) await this.room.writeCompaction(target, nextCursor, summary);
      else if (compacted) await this.room.clearCompaction(target);
      // The pre-compact context number is now a lie — don't leave the ctx chip
      // sitting on the old % until the next turn. Best real post-compact figure
      // is the summary the harness streamed (outputTokens); without one, drop
      // the entry so the chip goes blank until fresh usage arrives.
      const written = this.compactProgress.get(target)?.outputTokens;
      const maxTokens = this.contextUsage[target]?.maxTokens;
      const updated = written ? { usedTokens: written, ...(maxTokens ? { maxTokens } : {}) } : undefined;
      if (updated) this.contextUsage[target] = updated;
      else delete this.contextUsage[target];
      await this.room
        .updateState((current) => {
          if (updated) current.contextUsage = { ...(current.contextUsage ?? {}), [target]: updated };
          else if (current.contextUsage) delete current.contextUsage[target];
        })
        .catch(() => {});
      const text = `@${target}: ${message}`;
      // The visible compact boundary rides on the harness's structured `compacted`
      // signal — NOT a keyword match on the message (that silently dropped the
      // marker whenever a harness phrased its result differently). A clean no-op
      // ("nothing to compact") stays an ordinary system line, no boundary.
      return compacted ? { text, kind: "compact-complete" } : text;
    } catch (error) {
      // /cancel aborted the pass on purpose: report that, not the raw harness
      // exit ("claude exited (signal SIGTERM)…" reads like a crash).
      if (this.compactCancels.has(target)) return `Compaction cancelled for @${target}.`;
      return `Compaction failed for @${target}: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.compactCancels.delete(target);
      this.compactingAgents.delete(target);
      this.compactProgress.delete(target);
      await this.emitSnapshot();
    }
  }

  /** /cancel: panic stop from any client — drops the durable queue and cancels
   * the running turn. Partial progress commits (WAL), so nothing is lost. */
  async runCancelCommand(): Promise<string> {
    const queued = this.queuedTasks.length;
    const cancelled = await this.cancelActiveTask();
    if (!cancelled && queued === 0) return "Nothing is running.";
    const parts: string[] = [];
    if (cancelled) parts.push("Cancelled the running turn (partial progress is kept)");
    if (queued > 0) parts.push(`${queued} queued message${queued === 1 ? "" : "s"} kept — running next`);
    return `${parts.join("; ")}.`;
  }

  /** /recall: user-facing search over the same index the recall tool and
   * auto-recall use — facts, episodes, and full room history. */
  async runRecallCommand(agent?: string, query?: string): Promise<string> {
    const trimmed = query?.trim();
    if (!trimmed) return "Usage: /recall [@agent] <query> — search memory and room history.";
    const target = agent ?? (await this.roomDefaultTarget());
    if (!this.workspace.agents[target]) return this.unknownAgentMessage(target);
    if (!this.options.memory) return "Memory recall is not available in this workspace.";
    const context = await this.recallContext(target);
    const deep = this.options.memory.deepSearch?.bind(this.options.memory) ?? this.options.memory.search.bind(this.options.memory);
    const { hits, degraded } = await deep(target, trimmed, { limit: RECALL_COMMAND_LIMIT, context });
    const header = degraded.length ? `(recall degraded: ${degraded.join("; ")})\n` : "";
    if (!hits.length) return `${header}No matches for "${trimmed}" in @${target}'s memory or room history.`;
    return `Recall @${target} — "${trimmed}":\n${header}${formatMemoryHits(hits)}`;
  }

  /** /rewind: room-level checkpoint rollback. Truncates the transcript after
   * the n-th-last user message, resets every cursor and harness session, and
   * lets the next turn replay the kept transcript window — the one rewind
   * mechanism that works identically for every harness (sessions cannot be
   * rewound). */
  async runRewindCommand(countRaw?: string): Promise<string> {
    const count = countRaw ? Number.parseInt(countRaw, 10) : 1;
    if (!Number.isInteger(count) || count < 1) return "Usage: /rewind [n] — undo the last n user turns and their replies.";
    const dropped = await this.room.rewindTranscript(count);
    if (!dropped) return `Nothing to rewind: this room has fewer than ${count} user message${count === 1 ? "" : "s"}.`;
    // Forgetting the rewound exchanges is the point — sessions that saw them reset.
    await this.resetAfterTruncation("reset-sessions");
    return `Rewound ${count} user turn${count === 1 ? "" : "s"} (${dropped.length} event${dropped.length === 1 ? "" : "s"} removed). Agent sessions reset; the next turn replays the kept history.`;
  }

  /** /thanks-dario: run a review now, or toggle auto-review on model fallback. */
  async runThanksDarioCommand(sub: "on" | "off" | "run"): Promise<string> {
    if (sub === "on" || sub === "off") {
      await this.room.updateState((state) => {
        if (sub === "on") state.thanksDario = true;
        else delete state.thanksDario;
      });
      await this.emitSnapshot();
      return sub === "on"
        ? "Thanks-Dario mode ON: when a provider-side safeguard reroutes this room's model, Dario reviews the transcript and proposes redactions — popup with a diff, nothing rewritten without your approval."
        : "Thanks-Dario mode OFF.";
    }
    const proposal = await this.sanitizePreview();
    const window = `${proposal.window} message${proposal.window === 1 ? "" : "s"}`;
    if (proposal.parseError) {
      return `Dario reviewed ${window} but his reply did not parse as suggestions (${proposal.parseError}). His raw notes are in the review popup.`;
    }
    if (proposal.suggestions.length === 0) {
      return `Dario reviewed ${window} and found nothing that should trip a classifier. ${proposal.summary}`.trim();
    }
    return `Dario reviewed ${window}: ${proposal.suggestions.length} suggested edit${proposal.suggestions.length === 1 ? "" : "s"} ready in the review popup. Nothing is rewritten until you approve.`;
  }

  /** Run the reviewer persona over the events a fresh session would replay
   * and persist his proposal. Read-only — apply is a separate, human-approved
   * step. The reviewer runs through the ordinary summon path (sandboxed child
   * room, any harness/provider), so there is nothing harness-specific here. */
  async sanitizePreview(): Promise<SanitizeProposal> {
    const host = this.options.summonHost;
    if (!host) throw new Error("Summons are not available in this workspace — the reviewer needs them to run.");
    if (!this.workspace.agents[SANITIZE_REVIEWER_ID]) {
      throw new Error(`No "${SANITIZE_REVIEWER_ID}" persona is loaded — restart the daemon to seed it, then retry.`);
    }
    // Review the SAME context the flagged agent replays — the whole span from
    // its context floor to the end — NOT a short tail. The classifier re-scores
    // that entire span every turn, and the drift onto the sensitive topic often
    // starts many turns back (a user question before the model ever refused), so
    // a 20-message window is blind to the real trigger. System events (Dario's
    // own status notes) are dropped: they never reach any turn's model context.
    const state = await this.room.state();
    const { events: rawAll } = await this.room.eventsFrom(0);
    const nonSystem = rawAll.filter((event) => event.author !== "system");
    if (nonSystem.length === 0) throw new Error("Nothing to review — this room's transcript is empty.");
    // Locate the turn where the classifier rerouted the model, and the flagged
    // agent whose floor bounds the replayed context. Both are event data — no
    // harness branch.
    const fallbackEvent = [...nonSystem].reverse().find((event) => "details" in event && event.details?.modelFallback);
    const flaggedAgentId = fallbackEvent && !("targets" in fallbackEvent) ? fallbackEvent.author : undefined;
    const floor = flaggedAgentId ? (state.contextFloors?.[flaggedAgentId] ?? 0) : 0;
    // From the floor forward = exactly what the agent re-reads each turn.
    const inContext = rawAll.slice(floor).filter((event) => event.author !== "system");
    // Cap to the review budget, biased to the tail (the reroute and freshest
    // re-scored content). Anything older that doesn't fit is reported loudly.
    let start = inContext.length;
    let budget = SANITIZE_REVIEW_CHAR_BUDGET;
    for (let i = inContext.length - 1; i >= 0; i--) {
      budget -= inContext[i].text.length + 48; // rough per-event header overhead
      if (budget < 0) break;
      start = i;
    }
    const events = inContext.slice(start);
    const droppedOlder = start; // in-context events too old to fit the budget
    if (droppedOlder > 0) {
      this.emit({
        type: "room-event",
        workspaceId: this.workspaceId,
        roomId: this.roomId,
        event: {
          id: `system_sanitize_scope_${Date.now().toString(36)}`,
          timestamp: new Date().toISOString(),
          author: "system",
          text: `⚠ Dario reviewed the most recent ${events.length} of ${inContext.length} in-context messages (${droppedOlder} older ones exceeded the review budget). If the reroute persists, run the review again after applying — the tail shifts back and the older span comes into scope.`,
        },
      });
    }
    const context = flaggedAgentId ? await this.buildPersonaContext(flaggedAgentId) : undefined;
    const reply = await host.summonAndWait(
      this.roomId,
      SANITIZE_REVIEWER_ID,
      buildSanitizePrompt(events, {
        ...(fallbackEvent ? { fallbackEventId: fallbackEvent.id } : {}),
        ...(fallbackEvent && "details" in fallbackEvent && fallbackEvent.details?.modelFallback
          ? { fallbackTo: fallbackEvent.details.modelFallback.to, fallbackReason: fallbackEvent.details.modelFallback.reason }
          : {}),
        ...(context ? { context } : {}),
      }),
    );
    const proposal = parseSanitizeProposal(reply, events, {
      roomId: this.roomId,
      reviewer: SANITIZE_REVIEWER_ID,
      at: new Date().toISOString(),
    });
    await writeJsonAtomic(this.sanitizeProposalPath, proposal);
    this.sanitizeStatus = { at: proposal.at, suggestions: proposal.suggestions.length };
    await this.emitSnapshot();
    return proposal;
  }

  /** Assemble the flagged agent's real persona context (SOUL + active role) so
   * the reviewer sees what the classifier actually scored — the transcript
   * alone omits it. Read-only and length-capped; a trigger found here is
   * advisory (reported in `summary`), never an applyable transcript edit. */
  private async buildPersonaContext(agentId: string): Promise<SanitizeContext | undefined> {
    const agent = this.workspace.agents[agentId];
    if (!agent) return undefined;
    const roleName = (await this.room.state()).activeRoles[agentId];
    const role = roleName ? await resolveAgentRole(agent, roleName) : undefined;
    const soul = await readOptional(agent.soulPath);
    const parts = [soul.trim(), role ? `# Active Role: ${role.name}\n\n${role.prompt.trim()}` : ""].filter(Boolean);
    const text = parts.join("\n\n---\n\n").slice(0, PERSONA_CONTEXT_CAP);
    return text ? { agentId, text } : undefined;
  }

  /** Apply approved edits: rewrite the selected events in place (originals
   * preserved append-only in redactions.jsonl), then fresh sessions + capped
   * cursors so the next turn replays the sanitized window. Every quote is
   * re-validated against the live transcript — a stale or hallucinated quote
   * is skipped, never guessed at. */
  async sanitizeApply(edits: { eventId: string; quote: string; replacement: string }[]): Promise<{ applied: number; skipped: number }> {
    if (this.activeTask) throw new Error("A turn is running — wait for it to finish (or /cancel) before rewriting context.");
    if (edits.length === 0) throw new Error("No edits selected.");
    const { events } = await this.room.eventsFrom(0);
    const texts = new Map(events.map((event) => [event.id, event.text]));
    const next = new Map<string, string>();
    let skipped = 0;
    for (const edit of edits) {
      const current = next.get(edit.eventId) ?? texts.get(edit.eventId);
      if (current === undefined || !edit.quote || !current.includes(edit.quote)) {
        skipped++;
        continue;
      }
      next.set(edit.eventId, current.replace(edit.quote, edit.replacement));
    }
    if (next.size === 0) throw new Error("None of the selected edits matched the current transcript.");
    const edited = await this.room.redactEvents(next);

    const proposal = (await readJson(this.sanitizeProposalPath)) as SanitizeProposal | null;
    if (proposal?.at) {
      proposal.appliedAt = new Date().toISOString();
      await writeJsonAtomic(this.sanitizeProposalPath, proposal);
      this.sanitizeStatus = {
        at: proposal.at,
        suggestions: Array.isArray(proposal.suggestions) ? proposal.suggestions.length : 0,
        appliedAt: proposal.appliedAt,
      };
    }
    // Sanitize rewrites the triggering sentences in place — sessions holding the
    // original text must re-read the rewrite, or the redaction is cosmetic. But
    // the context itself must NOT change: "reset-keep-context" resets the affected
    // session yet replays the WHOLE conversation (never a shrunken window). The
    // cut is the first REWRITTEN index: any session that read past it saw the
    // original text and must re-seed.
    const { events: sanitized } = await this.room.eventsFrom(0);
    const firstEdited = sanitized.findIndex((event) => next.has(event.id));
    await this.resetAfterTruncation("reset-keep-context", firstEdited >= 0 ? firstEdited : 0);
    this.emit({
      type: "room-event",
      workspaceId: this.workspaceId,
      roomId: this.roomId,
      event: {
        id: `system_sanitize_${Date.now().toString(36)}`,
        timestamp: new Date().toISOString(),
        author: "system",
        text: `✂ Rewrote ${edited.length} message${edited.length === 1 ? "" : "s"}${skipped > 0 ? ` (${skipped} skipped)` : ""} in place — context unchanged. Originals are preserved in redactions.jsonl; the next turn replays the full sanitized history.`,
      },
    });
    return { applied: edited.length, skipped };
  }

  /** The last saved proposal (popup re-open + the GET route). */
  async getSanitizeProposal(): Promise<SanitizeProposal | null> {
    const proposal = (await readJson(this.sanitizeProposalPath)) as SanitizeProposal | null;
    return proposal?.at ? proposal : null;
  }

  private get sanitizeProposalPath(): string {
    return join(workspacePaths.roomDir(this.workspace.rootDir, this.roomId), "sanitize.json");
  }

  /** Retry a reply: fork the room at the user message that produced the
   * given event and re-run it verbatim. Works on an agent reply (regenerate
   * it) or on a user message (re-send it). */
  async retryMessage(eventId: string): Promise<Task> {
    const origin = await this.forkAtUserMessage(eventId);
    return this.sendMessage(origin.text, {
      ...(origin.targets.length ? { targets: origin.targets } : {}),
      ...(origin.attachments?.length ? { attachments: origin.attachments } : {}),
    });
  }

  /** Edit a user message: fork the room at that message and re-run with the
   * new text. An explicit @mention in the edited text wins; otherwise the
   * original routing is kept. Original attachments ride along (claude.ai
   * edit semantics: the text changes, the files stay). */
  async editMessage(eventId: string, text: string): Promise<Task> {
    const origin = await this.forkAtUserMessage(eventId);
    const mentioned = hasExplicitMention(text, new Set(Object.keys(this.workspace.agents)));
    return this.sendMessage(text, {
      ...(!mentioned && origin.targets.length ? { targets: origin.targets } : {}),
      ...(origin.attachments?.length ? { attachments: origin.attachments } : {}),
    });
  }

  /** The fork-from-message primitive behind edit and retry: truncate the
   * transcript at the originating USER message (dropped events are preserved
   * in rewound.jsonl) and cap cursors that pointed past the cut. Claude.ai-style
   * "edit deletes the rest" — except nothing is actually lost. Uniform for every
   * harness: the room WAL is the fork; native session forks are never used.
   *
   * The harness session MUST reset here ("reset-keep-context"). A long-lived
   * session (e.g. claude --resume) keeps its OWN copy of the conversation, so
   * truncating only the gaia transcript leaves every rewound turn alive inside
   * the session — the model still sees the deleted resends and its own prior
   * replies, and the "edit" reads to it as one more identical message appended
   * after them. That is the refusal-loop bug: nothing before the fork actually
   * changes for the model, so it never moves off its last answer. Resetting the
   * session (then replaying the whole KEPT conversation from the floor) is what
   * makes edit/retry mean what a user expects: everything after the fork is gone
   * from the model's view too, not just from the sidebar. Context is preserved
   * in full (replay from the floor), so the regenerated reply still knows the
   * whole conversation up to the edited message — the reset only drops the tail. */
  private async forkAtUserMessage(eventId: string): Promise<{ text: string; targets: string[]; attachments?: MessageAttachment[] }> {
    if (this.activeTask) throw new Error("A turn is running — cancel it first, then edit or retry.");
    const { events } = await this.room.eventsFrom(0);
    let index = events.findIndex((event) => event.id === eventId);
    if (index < 0) throw new Error("Message not found in this room's transcript.");
    while (index >= 0 && events[index].author !== "user") index--;
    if (index < 0) throw new Error("No user message precedes that event to fork from.");
    const origin = events[index];
    await this.room.rewindToEvent(origin.id);
    await this.resetAfterTruncation("reset-keep-context");
    return {
      text: origin.text,
      targets: "targets" in origin ? origin.targets : [],
      ...("attachments" in origin && origin.attachments?.length ? { attachments: origin.attachments } : {}),
    };
  }

  /** After a transcript truncation or in-place rewrite. Agents whose cursor
   * never reached the cut are untouched either way — their session saw none of
   * the changed events, so resetting them is pure loss (this used to wipe EVERY
   * agent's session and then trip the session-lost gate on a simple retry).
   *
   * BOTH modes reset the harness session of every agent that read past the cut —
   * a long-lived session (claude --resume, codex rollout) keeps its own copy of
   * the conversation, so leaving it alive would let the removed/rewritten turns
   * survive inside it even after the gaia transcript changed. What differs is
   * whether earlier context is kept:
   *  - "reset-sessions" (rewind — forgetting IS the point): cursor AND context
   *    floor land on a recent windowed base, so the next turn replays only the
   *    kept window (deliberate amnesia, no session-lost gate).
   *  - "reset-keep-context" (edit / retry / sanitize — the tail must vanish but
   *    earlier context stays): the cursor reseeds to the agent's EXISTING floor
   *    (a /compact boundary, or 0) so the WHOLE kept conversation replays with
   *    the fork/rewrite applied — never a shrunken window. The floor is left
   *    exactly as it was. For edit/retry the dropped tail (resends + prior
   *    replies) is gone from the model's view; for sanitize the rewritten
   *    sentences replace the originals in place. Either way the reset drops only
   *    what changed, and the regenerated reply still knows everything up to the
   *    fork point.
   *
   * `cut` is the first transcript index whose content changed. Truncations
   * (edit/retry/rewind) omit it → the whole tail past `kept` is affected; sanitize
   * passes the index of the first REWRITTEN event — its events survive in place,
   * but any session that read past that point holds the original text and must be
   * treated as affected. */
  private async resetAfterTruncation(mode: "reset-sessions" | "reset-keep-context", cut?: number): Promise<void> {
    const kept = (await this.room.eventsFrom(0)).events.length;
    const affectedAbove = Math.min(cut ?? kept, kept);
    const base = Math.max(0, kept - this.workspace.config.transcriptWindow);
    const state = await this.room.state();
    for (const [id, cursor] of Object.entries(state.agentCursors)) {
      if (cursor > affectedAbove) this.runtimes[id]?.resetRoom(this.roomId);
    }
    // rewind moves the floor to a fresh window base — any durable compaction
    // summary captured at the old floor is now stale and must be dropped (its
    // floorIdx would no longer match anyway; clearing keeps the store honest).
    const forgot: string[] = [];
    await this.room.updateState((current) => {
      for (const [id, cursor] of Object.entries(current.agentCursors)) {
        if (cursor <= affectedAbove) continue;
        if (mode === "reset-sessions") {
          current.agentCursors[id] = base;
          current.contextFloors = { ...(current.contextFloors ?? {}), [id]: base };
          forgot.push(id);
        } else {
          // Keep the FULL context. Reseed to the agent's real floor so the entire
          // kept conversation replays on the fresh session — capped to `kept` so a
          // floor set past the fork (a /compact between fork point and tail) can't
          // land the cursor beyond the transcript end.
          current.agentCursors[id] = Math.min(current.contextFloors?.[id] ?? 0, kept);
        }
      }
      delete current.runtimeDetails;
    });
    for (const id of forgot) await this.room.clearCompaction(id);
    this.recentTasks = [];
    await this.emitSnapshot();
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

  /** Resume a turn a prior process left in-flight. Three cases:
   * - reply already in transcript (crash between append and ack) → finish the
   *   state write only;
   * - partial streamed → commit it as the preserved progress;
   * then re-dispatch any unfinished targets. Re-entrant: the replay re-marks a
   * fresh pendingTurn, so an interrupted resume is itself resumable. */
  private async resumePendingTurn(pending: PendingTurn): Promise<void> {
    // A monad dispatch resumes through the monad engine, never as a plain
    // agent turn: targets are omitted so isMonadMessage re-derives the routing
    // from state.monad (step results live in child rooms; the engine reruns).
    if (pending.monad) {
      await this.room.clearPendingTurn();
      await this.sendMessage(pending.prompt, { recordUserMessage: false });
      return;
    }
    const mode = await this.room.resumeMode(pending);
    if (mode === "finish-commit" && pending.eventId) {
      const state = await this.room.state();
      const cursor = state.agentCursors[pending.agentId] ?? 0;
      const { nextCursor } = await this.room.eventsFrom(cursor);
      await this.room.updateState((current) => {
        delete current.pendingTurn;
        current.agentCursors[pending.agentId] = nextCursor;
      });
    } else if (pending.partialReply.trim()) {
      // Details weren't durably captured mid-turn; preserve the text. The
      // commit clears the marker in the SAME atomic write as the cursor
      // advance — clearing it up front (the old order) opened a window where
      // a crash destroyed both the flushed partial and the owed-replay record.
      await this.commitReply(pending.agentId, pending.eventId ?? newRoomEventId(), pending.partialReply, {}, pending.channel);
    }
    // No partial and nothing committed → the marker deliberately STAYS until
    // the replay below re-marks it (markPendingTurn overwrites): a crash
    // anywhere in between re-enters this resume idempotently.

    const remaining = mode === "finish-commit" ? pending.targets.filter((t) => t !== pending.agentId) : pending.targets;
    if (remaining.length > 0) {
      // The user prompt is already on disk — replay without re-recording it.
      await this.sendMessage(pending.prompt, {
        targets: remaining,
        recordUserMessage: false,
        ...(pending.channel ? { channel: pending.channel } : {}),
        ...(pending.attachments?.length ? { attachments: pending.attachments } : {}),
      });
    }
  }

  // --- monad -----------------------------------------------------------------

  private async isMonadMessage(text: string, options: SendMessageOptions): Promise<boolean> {
    const state = await this.room.state();
    if (!state.monad || !this.options.summonHost) return false;
    if (options.targets) return false;
    return !hasExplicitMention(text, new Set(Object.keys(this.workspace.agents)));
  }

  private async monadAuthor(): Promise<string[]> {
    const state = await this.room.state();
    const monad = state.monad;
    return [monad?.coordinatorAgentId ?? monad?.slots[0]?.agentId ?? this.workspace.config.defaultAgent];
  }

  /** Runs the monad engine over a user message: each step is a real summon (a
   * visible child room); only the single final answer posts here. */
  private async runMonadTask(task: Task, text: string, options: SendMessageOptions): Promise<void> {
    try {
      const state = await this.room.state();
      const monad = state.monad;
      const summonHost = this.options.summonHost;
      if (!monad || !summonHost) {
        this.settleTask(task, "error", new Error("This room is not a monad room."));
        return;
      }

      if (options.recordUserMessage !== false) {
        const userEvent = await this.room.addUserMessage(text, task.targets);
        this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event: userEvent });
      }

      // WAL: a monad run is a turn like any other — reserve the final answer's
      // event id and persist a monad-flagged marker BEFORE the engine runs, so
      // a daemon crash mid-monad leaves a resumable record (boot re-dispatches
      // through the engine; step results already live in child rooms) instead
      // of a recorded user message that is silently never answered. The same
      // atomic write consumes the drained queue entry, as in runAgentTask.
      const [author] = await this.monadAuthor();
      const eventId = newRoomEventId();
      await this.room.markPendingTurn(
        {
          id: task.id,
          eventId,
          prompt: text,
          targets: task.targets.length > 0 ? task.targets : [author],
          agentId: author,
          partialReply: "",
          startedAt: new Date().toISOString(),
          monad: true,
        },
        options.queued ? { consumeQueuedTaskId: options.queued.taskId } : undefined,
      );

      const engine = new MonadEngine({
        config: monad,
        parentRoomId: this.roomId,
        dispatch: (agentId, stepTask) => summonHost.summonAndWait(this.roomId, agentId, stepTask),
        resolveRolePrompt: async (agentId, role) => {
          const agent = this.workspace.agents[agentId];
          if (!agent) return "";
          const resolved = await resolveAgentRole(agent, role);
          return resolved?.prompt ?? "";
        },
      });

      const result = await engine.run(text, { isCancelled: () => this.taskCancelled(task) });
      if (this.taskCancelled(task)) {
        await this.room.clearPendingTurn();
        return;
      }

      const final = result.final.trim();
      if (final) {
        // Commit through the WAL like every turn: append under the reserved id
        // and retire the marker + advance the author's cursor in one write.
        const event: RoomEvent = { id: eventId, timestamp: new Date().toISOString(), author, text: final };
        await this.room.commitTurn(event);
        this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
      } else {
        await this.room.clearPendingTurn();
      }
      this.settleTask(task, "complete");
    } catch (error) {
      // Cancelled or terminally failed: retire the marker either way — never
      // replay a poison monad run on boot.
      await this.room.clearPendingTurn().catch(() => {});
      if (this.taskCancelled(task)) return;
      this.settleTask(task, "error", error);
    }
  }

  // --- commands ----------------------------------------------------------------

  private async runCommand(task: Task, command: SlashCommand): Promise<void> {
    try {
      const handler = COMMANDS[command.type];
      const reply = handler ? await handler(this, command) : `Unknown command. Try /help.`;
      const text = typeof reply === "string" ? reply : reply.text;
      // Persist the reply so a command result (e.g. /compact) survives a reload
      // instead of only flashing on the live stream. appendEvent both writes it
      // to the transcript and emits the room-event to connected clients. Skip the
      // transcript-structural commands: they reset/truncate history themselves, so
      // a leftover confirmation would re-seed the room they just emptied.
      const event: RoomEvent = {
        id: `system_${task.id}`,
        timestamp: new Date().toISOString(),
        author: "system",
        text,
        ...(typeof reply === "string" || !reply.kind ? {} : { kind: reply.kind }),
      };
      if (!TRANSCRIPT_STRUCTURAL_COMMANDS.has(command.type)) await this.room.appendEvent(event);
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
      // /cancel settles a long command (e.g. mid-compaction) out from under us;
      // the reply above still lands, but the task must not settle twice.
      if (!this.taskCancelled(task)) this.settleTask(task, "complete");
    } catch (error) {
      if (!this.taskCancelled(task)) this.settleTask(task, "error", error);
    }
  }

  // --- harness-native commands (passthrough) ------------------------------------

  /** The agent a bare `/native-command` routes to: whoever the room is actively
   * addressing, else the workspace default. */
  private async nativeCommandTarget(): Promise<string> {
    const state = await this.room.state();
    const active = state.activeAgent;
    if (active && this.workspace.agents[active]) return active;
    return this.workspace.config.defaultAgent;
  }

  /** Does this agent accept harness-native slash-command passthrough right now? */
  private agentAllowsNativeCommands(agent: AgentDef): boolean {
    return agent.nativeCommands === true && capabilitiesFor(harnessIdFor(agent, this.workspace)).supportsNativeCommands;
  }

  /** The `/`-command palette: gaia commands + the harness-native commands
   * advertised by every agent that opted in (deduped, gaia names win). Native
   * ones are hints only — passthrough still forwards anything typed. */
  private paletteCommands(): SlashCommandDefinition[] {
    const seen = new Set(SLASH_COMMANDS.map((command) => command.name));
    const native: SlashCommandDefinition[] = [];
    for (const agent of Object.values(this.workspace.agents)) {
      if (!this.agentAllowsNativeCommands(agent)) continue;
      for (const command of nativeCommandsFor(harnessIdFor(agent, this.workspace))) {
        if (seen.has(command.name)) continue;
        seen.add(command.name);
        native.push({ name: command.name, type: "native", description: command.description, native: true });
      }
    }
    return native.length ? [...SLASH_COMMANDS, ...native] : SLASH_COMMANDS;
  }

  /** /native: toggle harness-native slash-command passthrough for an agent, or
   * list what its harness advertises. Persists to agent.json like /thinking. */
  async runNativeCommand(agentId: string | undefined, sub: "on" | "off" | "list" | undefined): Promise<string> {
    const target = agentId ?? (await this.nativeCommandTarget());
    const agent = this.workspace.agents[target];
    if (!agent) return this.unknownAgentMessage(target);
    const harnessId = harnessIdFor(agent, this.workspace);
    if (!capabilitiesFor(harnessId).supportsNativeCommands) {
      return `@${agent.id}'s harness (${harnessId}) has no native slash commands to pass through.`;
    }
    if (sub === "list" || !sub) {
      const advertised = nativeCommandsFor(harnessId);
      const state = agent.nativeCommands ? "on" : "off";
      const list = advertised.length
        ? advertised.map((command) => `  /${command.name} — ${command.description}`).join("\n")
        : "  (none advertised — any /command still passes through)";
      return `Native commands for @${agent.id}: ${state}.\nGrant the agent web/read/bash tools so a skill can act.\n${list}\n\nToggle: /native ${agent.id} on|off`;
    }
    const enabled = sub === "on";
    const configPath = agent.projectConfigPath ?? agent.configPath;
    const config = ((await readJson(configPath)) ?? {}) as Record<string, unknown>;
    if (enabled) config.nativeCommands = true;
    else delete config.nativeCommands;
    await writeJsonAtomic(configPath, config);
    agent.nativeCommands = enabled ? true : undefined;
    await this.emitSnapshot();
    await this.reloadAfterAgentConfigWrite(agent);
    return enabled
      ? `Enabled native commands for @${agent.id}. Type e.g. /deep-research <query>. (Grant web/read/bash tools for a skill to act.)`
      : `Disabled native commands for @${agent.id}.`;
  }

  async renderAgentsList(): Promise<string> {
    const state = await this.room.state();
    return Object.values(this.workspace.agents)
      .map((agent) => {
        const defaultMark = agent.id === this.workspace.config.defaultAgent ? " (default)" : "";
        const role = state.activeRoles[agent.id] ? ` [role: ${state.activeRoles[agent.id]}]` : "";
        return `${agent.icon} @${agent.id}${defaultMark}${role} - ${agent.displayName} [tools: ${agent.tools.join(", ") || "none"}]`;
      })
      .join("\n");
  }

  async renderRoles(agentId: string | undefined): Promise<string> {
    if (!agentId) return "Usage: /roles <agent>";
    const agent = this.workspace.agents[agentId];
    if (!agent) return this.unknownAgentMessage(agentId);
    const roles = await listAgentRoles(agent);
    if (roles.length === 0) return `No roles found for @${agent.id}. Add files under ${agent.rolesDir}`;
    const state = await this.room.state();
    const activeRole = state.activeRoles[agent.id];
    return roles.map((role) => `${role === activeRole ? "*" : "-"} ${role}${role === activeRole ? " (active)" : ""}`).join("\n");
  }

  async setRole(agentId: string | undefined, role: string | undefined): Promise<string> {
    if (!role) return "Usage: /role [agent] <role|none>";
    const targetId = agentId ?? this.workspace.config.defaultAgent;
    const agent = this.workspace.agents[targetId];
    if (!agent) return this.unknownAgentMessage(targetId);

    if (role === "none") {
      await this.room.updateState((state) => {
        delete state.activeRoles[agent.id];
      });
      await this.emitSnapshot();
      return `Cleared role for @${agent.id}.`;
    }

    const roles = await listAgentRoles(agent);
    if (!roles.includes(role)) {
      return `Unknown role for @${agent.id}: ${role}\nAvailable roles: ${roles.length > 0 ? roles.join(", ") : "none"}`;
    }
    await this.room.updateState((state) => {
      state.activeRoles[agent.id] = role;
    });
    await this.emitSnapshot();
    return `Set @${agent.id} role to ${role}.`;
  }

  async runThinkingCommand(agentId: string | undefined, level: string | undefined): Promise<string> {
    const target = agentId ?? this.workspace.config.defaultAgent;
    const agent = this.workspace.agents[target];
    if (!agent) return this.unknownAgentMessage(target);
    if (!level) {
      return `Usage: /thinking [agent] <${sdkThinkingLevels().join("|")}>\n@${agent.id} thinking is ${agent.thinking ?? "off"}.`;
    }
    try {
      if (this.options.setThinking) return await this.options.setThinking(agent.id, level);
      return await this.setAgentThinking(agent.id, level);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Persists an agent's thinking level to the effective agent.json (project
   * override wins). The in-place mutation updates THIS process's snapshot;
   * the settingsChanged reload is what carries it into the runner
   * subprocesses (they snapshot agent.json at spawn). */
  async setAgentThinking(agentId: string, level: string): Promise<string> {
    const levels = sdkThinkingLevels();
    if (level !== "" && !levels.includes(level)) {
      throw new Error(`Invalid thinking level: ${level}. Use one of: ${levels.join(", ")}`);
    }
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));

    const configPath = agent.projectConfigPath ?? agent.configPath;
    const config = ((await readJson(configPath)) ?? {}) as Record<string, unknown>;
    if (level === "") delete config.thinking;
    else config.thinking = level;
    await writeJsonAtomic(configPath, config);

    agent.thinking = level === "" ? undefined : (level as AgentDef["thinking"]);
    await this.emitSnapshot();
    await this.reloadAfterAgentConfigWrite(agent);
    return `Set @${agent.id} thinking to ${level || "unset"}.`;
  }

  /** After a command rewrites agent.json: rebuild the affected services so
   * live runners respawn on the NEW config. Runners are subprocesses that
   * read agent.json once at spawn — without this, /model and /thinking only
   * changed the chip, never the next turn (the bug where /model opus kept
   * running fable). The reload defers while a turn runs and harness sessions
   * resume from their on-disk stores, so the conversation continues. */
  private async reloadAfterAgentConfigWrite(agent: AgentDef): Promise<void> {
    await this.options.settingsChanged?.(agent.projectConfigPath ? "workspace" : "global");
  }

  async runModelCommand(agentId: string | undefined, spec: string | undefined): Promise<string> {
    const target = agentId ?? this.workspace.config.defaultAgent;
    const agent = this.workspace.agents[target];
    if (!agent) return this.unknownAgentMessage(target);
    const current = agent.model ? `${agent.model.provider ?? "?"}/${agent.model.name ?? "?"}` : "workspace default";
    if (!spec) {
      return `Usage: /model [agent] <provider/name> (or "none" to clear)\n@${agent.id} model is ${current}.`;
    }
    try {
      return await this.setAgentModel(agent.id, spec);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Persists an agent's model to the effective agent.json (project override
   * wins). "none"/"default"/"off" clears the override, falling back to the
   * workspace default. A bare name keeps the current provider;
   * "provider/name" sets both. The settingsChanged reload carries the change
   * into the runner subprocesses — the manual pick sticks until the next
   * /model, while a provider-side auto-reroute (fable → opus safeguard)
   * stays per-message and never rewrites this config. */
  async setAgentModel(agentId: string, spec: string): Promise<string> {
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));

    const configPath = agent.projectConfigPath ?? agent.configPath;
    const config = ((await readJson(configPath)) ?? {}) as Record<string, unknown>;

    if (["none", "default", "off", ""].includes(spec.toLowerCase())) {
      delete config.model;
      await writeJsonAtomic(configPath, config);
      agent.model = undefined;
      await this.emitSnapshot();
      await this.reloadAfterAgentConfigWrite(agent);
      return `Cleared @${agent.id} model override — using workspace default. Applies from the next turn (the session continues).`;
    }

    // A bare <name> keeps the agent's current provider, else the one its
    // HARNESS declares as data (lockedProvider / first modelProviderIds entry).
    // Never a hardcoded provider: guessing one harness's world here would
    // silently mis-provider every other harness (RULE #0).
    const slash = spec.indexOf("/");
    const harnessUi = findHarness(harnessIdFor(agent, this.workspace))?.ui;
    const defaultProvider = agent.model?.provider ?? harnessUi?.lockedProvider ?? harnessUi?.modelProviderIds?.[0];
    if (slash <= 0 && !defaultProvider) throw new Error(`Invalid model: ${spec}. Use <provider/name> — @${agent.id}'s harness declares no default provider.`);
    const model: AgentModelConfig =
      slash > 0 ? { provider: spec.slice(0, slash), name: spec.slice(slash + 1) } : { provider: defaultProvider!, name: spec };
    if (!model.name) throw new Error(`Invalid model: ${spec}. Use <name> or <provider/name>.`);

    config.model = model;
    await writeJsonAtomic(configPath, config);
    agent.model = model;
    await this.emitSnapshot();
    await this.reloadAfterAgentConfigWrite(agent);
    return `Set @${agent.id} model to ${model.provider}/${model.name}. Applies from the next turn (the session continues).`;
  }

  async runSummonCommand(agentId: string | undefined, task: string | undefined): Promise<string> {
    if (!this.options.summonHost) return "Summon system is not available.";
    if (!agentId || !task) return "Usage: /summon <agent> <task>";
    const agent = this.workspace.agents[agentId];
    if (!agent) return this.unknownAgentMessage(agentId);
    // Human-initiated: the result comes back as a note in THIS room (no agent
    // turn to trigger — the human reads it).
    const childRoomId = await this.options.summonHost.summon(this.roomId, agent.id, task, { deliver: "note" });
    return `Summoned @${agent.id} in room '${childRoomId}'. Open it from the rooms list (under this room) to watch or steer; its result will be posted back here when it finishes.`;
  }

  async runSetupCommand(command: { sub?: string; id?: string; room?: string }): Promise<string> {
    const sub = command.sub ?? "list";

    if (sub === "list") {
      const setups = await discoverSetups(this.workspace.rootDir);
      if (setups.length === 0) return "No setups found. Bundled setups live under setups/, global under ~/.gaia/setups/, project under .gaia/setups/.";
      return [
        "Available setups:",
        ...setups.map((s) => `  - ${s.id}${s.displayName && s.displayName !== s.id ? ` — ${s.displayName}` : ""} [${s.source}]${s.description ? `\n      ${s.description}` : ""}`),
      ].join("\n");
    }

    if (sub === "status") {
      const monad = (await this.room.state()).monad;
      if (!monad) return "This room is not a monad room. Activate a setup with /setup activate <id>.";
      const pool = monad.slots.map((slot) => `${slot.agentId}${slot.defaultRole ? `(${slot.defaultRole})` : ""}`).join(" · ");
      return `Monad active — policy: ${monad.policy}, maxTurns: ${monad.maxTurns}, coordinator: @${monad.coordinatorAgentId ?? monad.slots[0]?.agentId}\nPool: ${pool}`;
    }

    if (sub === "off") {
      const cleared = await deactivateMonad(this.workspace, this.roomId);
      this.room.invalidate();
      await this.emitSnapshot();
      return cleared ? "Cleared the monad from this room. Plain messages now go to the default agent." : "This room had no active monad.";
    }

    if (sub === "activate") {
      if (!command.id) return "Usage: /setup activate <id> [room]";
      if (!this.options.summonHost) return "Setups need the summon system, which is unavailable here.";
      const targetRoom = command.room ?? this.roomId;
      try {
        const result = await activateSetup(this.workspace, command.id, targetRoom);
        if (targetRoom === this.roomId) {
          this.room.invalidate();
          await this.emitSnapshot();
        }
        const pool = result.monad.slots.map((slot) => `@${slot.agentId}`).join(" · ");
        return `Activated setup '${result.setupId}' into room '${targetRoom}' (policy: ${result.monad.policy}, pool: ${pool}). Send a message to run the monad; each step appears as a child room.`;
      } catch (error) {
        return `Setup activation failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    return "Usage: /setup list | activate <id> [room] | status | off";
  }

  /** /clear: wipe transcript, reset cursors + legacy details, drop every
   * harness session for this room. Role assignments are configuration — kept. */
  async runClearCommand(): Promise<string> {
    for (const runtime of Object.values(this.runtimes)) runtime.resetRoom(this.roomId);
    await this.room.clearTranscript();
    await this.room.updateState((state) => {
      state.agentCursors = {};
      delete state.runtimeDetails;
    });
    this.recentTasks = [];
    await this.emitSnapshot();
    return "Cleared room history and reset all agent sessions.";
  }

  /** /fork: branch into a sibling room. Transcript copies verbatim; cursors
   * RESET so the branch's first turn replays the whole transcript — the one
   * context-rebuild mechanism that works for every harness (sessions cannot
   * be branched). */
  async runForkCommand(): Promise<string> {
    const target = this.nextForkId(this.roomId);
    const dstDir = workspacePaths.roomDir(this.workspace.rootDir, target);
    await mkdir(dstDir, { recursive: true });
    try {
      await copyFile(this.room.transcriptPath, join(dstDir, "transcript.jsonl"));
    } catch {
      // Never-written transcript — the branch starts empty.
    }
    const state = await this.room.state();
    await writeJsonAtomic(workspacePaths.roomState(this.workspace.rootDir, target), normalizeRoomState({ activeRoles: { ...state.activeRoles } }));
    await this.emitSnapshot();
    return `Forked this room to '${target}'. Select it from the rooms list to continue the branch.`;
  }

  private nextForkId(base: string): string {
    const exists = (id: string): boolean => existsSync(workspacePaths.roomDir(this.workspace.rootDir, id));
    let candidate = `${base}-fork`;
    let n = 2;
    while (exists(candidate)) candidate = `${base}-fork-${n++}`;
    return candidate;
  }

  // --- snapshot ---------------------------------------------------------------

  /** One committed transcript event by id (read-aloud and similar lookups). */
  async eventById(eventId: string): Promise<RoomEvent | undefined> {
    await this.init();
    const { events } = await this.room.eventsFrom(0);
    return events.find((event) => event.id === eventId);
  }

  /** Page backwards through committed history: the `limit` events immediately
   * before `beforeId` (or the transcript tail when it's absent/unknown). Backs
   * the transcript's "load older" — the snapshot only carries the tail window. */
  async eventsBefore(beforeId: string | undefined, limit: number): Promise<{ events: RoomEvent[]; hasMore: boolean }> {
    await this.init();
    const { events } = await this.room.eventsFrom(0);
    const found = beforeId ? events.findIndex((event) => event.id === beforeId) : -1;
    const end = found >= 0 ? found : events.length;
    const start = Math.max(0, end - Math.max(1, limit));
    return { events: events.slice(start, end), hasMore: start > 0 };
  }

  async getSnapshot(): Promise<Snapshot> {
    await this.init();
    const all = (await this.room.eventsFrom(0)).events;
    const events = all.slice(-this.workspace.config.transcriptWindow);
    const state = await this.room.state();
    return {
      workspace: {
        id: this.workspaceId,
        rootDir: this.workspace.rootDir,
        configPath: this.workspace.configPath,
        defaultAgent: this.workspace.config.defaultAgent,
      },
      room: {
        id: this.roomId,
        statePath: this.room.statePath,
        events,
        eventTotal: all.length,
        ...(state.thanksDario ? { thanksDario: true } : {}),
        ...(state.activeAgent && this.workspace.agents[state.activeAgent] ? { activeAgent: state.activeAgent } : {}),
        ...(state.agentDialogue ? { agentDialogue: true } : {}),
        ...(this.incognito ? { incognito: true } : {}),
        ...(this.sanitizeStatus ? { sanitize: this.sanitizeStatus } : {}),
        ...(this.contextGate ? { contextGate: this.contextGate } : {}),
        ...(this.liveTurn ? { liveTurn: this.liveTurn } : {}),
      },
      rooms: await this.listRooms(),
      commands: this.paletteCommands(),
      agents: await Promise.all(
        Object.values(this.workspace.agents).map(async (agent) => ({
          id: agent.id,
          displayName: agent.displayName,
          icon: agent.icon,
          modelLabel: this.runtimes[agent.id]?.modelLabel ?? "unknown",
          configuredModel: configuredModelLabel(agent.model, "default"),
          ...(this.modelFallbacks[agent.id] ? { modelFallback: this.modelFallbacks[agent.id] } : {}),
          ...(this.contextFor(agent) ? { context: this.contextFor(agent) } : {}),
          tools: agent.tools,
          voice: agent.voice,
          thinking: agent.thinking,
          activeRole: state.activeRoles[agent.id],
          roles: await listAgentRoles(agent),
          status: (this.compactingAgents.has(agent.id)
            ? "compacting"
            : this.activeTask?.targets.includes(agent.id)
              ? "running"
              : "idle") as AgentStatus["status"],
          ...(this.compactProgress.has(agent.id) ? { compact: this.compactProgress.get(agent.id) } : {}),
          isDefault: agent.id === this.workspace.config.defaultAgent,
        })),
      ),
      tasks: [...this.recentTasks, ...(this.activeTask ? [this.activeTask] : []), ...this.queuedTasks],
      thinkingLevels: sdkThinkingLevels(),
      // Degradation is loud (§10): the composer shows these like the
      // model-fallback warning. Best-effort — health can never break a snapshot.
      ...(await this.memoryChips()),
    };
  }

  private async memoryChips(): Promise<{ memoryChips?: string[] }> {
    try {
      const chips = (await this.options.memory?.healthChips?.()) ?? [];
      return chips.length ? { memoryChips: chips } : {};
    } catch {
      return {};
    }
  }

  async listRooms(): Promise<Snapshot["rooms"]> {
    const roomsDir = workspacePaths.roomsDir(this.workspace.rootDir);
    const fallback = [{ id: this.roomId, path: join(roomsDir, this.roomId), isCurrent: true }];
    if (!existsSync(roomsDir)) return fallback;
    const entries = await readdir(roomsDir, { withFileTypes: true });
    const running = new Set(this.options.summonHost?.runningChildren().map((child) => child.roomId) ?? []);
    const rooms = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const state = normalizeRoomState(await readJson(workspacePaths.roomState(this.workspace.rootDir, entry.name)));
          // Rooms are chats: order by last transcript write, like a chat list.
          // The importer stamps original chat dates onto imported transcripts,
          // so archives sit at their historical position until touched again.
          const activity = await stat(workspacePaths.transcript(this.workspace.rootDir, entry.name)).then(
            (info) => info.mtimeMs,
            () => 0,
          );
          return {
            activity,
            summary: {
              id: entry.name,
              path: join(roomsDir, entry.name),
              isCurrent: entry.name === this.roomId,
              ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}),
              // Running = a turn is mid-flight: the durable WAL marker (covers
              // every room, not only summons), a live summon, or — for THIS
              // service's own room — its in-memory turn (the marker is written a
              // tick later, so this closes the start-of-turn gap).
              ...(state.pendingTurn || running.has(entry.name) || (entry.name === this.roomId && this.activeAgentTurn) ? { running: true } : {}),
              ...(state.title ? { title: state.title } : {}),
              ...(state.imported ? { imported: state.imported } : {}),
              ...(state.incognito ? { incognito: true } : {}),
              ...(activity ? { lastActivity: activity } : {}),
            },
          };
        }),
    );
    rooms.sort((a, b) => b.activity - a.activity || a.summary.id.localeCompare(b.summary.id));
    return rooms.length > 0 ? rooms.map((room) => room.summary) : fallback;
  }

  /** The most recent reply text from an agent in this room (summon results). */
  async latestReplyFrom(agentId: string): Promise<string> {
    await this.init();
    const events = await this.room.recentEvents(this.workspace.config.transcriptWindow);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.author === agentId && "text" in event) return event.text;
    }
    return "";
  }

  // --- attachments -------------------------------------------------------------

  /** Persist a pasted file into this room's files/ dir (backs the upload
   * route). The daemon issues the on-disk id; `name` stays the original
   * client-side filename for display and prompts. */
  async storeAttachment(name: string, data: Buffer, mime?: string): Promise<MessageAttachment & { id: string }> {
    const safe = sanitizeAttachmentName(name);
    const id = `${newId("f")}-${safe}`;
    const dir = workspacePaths.roomFilesDir(this.workspace.rootDir, this.roomId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, id);
    await writeFile(path, data);
    return { id, name: name.trim() || safe, mime: mime?.trim() || attachmentMime(safe), size: data.byteLength, path };
  }

  /** Re-resolve client-sent attachment refs against this room's files dir.
   * Only the server-issued id is trusted for path math (basename'd, must
   * exist inside the dir); name/mime are display strings from the upload
   * response. Throws on an unknown id so a bad send fails loudly. */
  async resolveAttachments(refs: { id: string; name?: string; mime?: string }[]): Promise<MessageAttachment[]> {
    const dir = workspacePaths.roomFilesDir(this.workspace.rootDir, this.roomId);
    const attachments: MessageAttachment[] = [];
    for (const ref of refs) {
      const id = basename(ref.id.trim());
      if (!id || id.startsWith(".")) throw new Error(`Invalid attachment id: ${ref.id}`);
      const path = join(dir, id);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`Unknown attachment: ${id} — upload it first.`);
      attachments.push({
        name: ref.name?.trim() || id,
        mime: ref.mime?.trim() || attachmentMime(id),
        size: info.size,
        path,
      });
    }
    return attachments;
  }

  /** Absolute path of a stored attachment by id, for the serve route. */
  attachmentPath(id: string): string {
    return join(workspacePaths.roomFilesDir(this.workspace.rootDir, this.roomId), basename(id));
  }

  /** Memory write for a harness subprocess (the `gaia mem` CLI). The daemon is
   * the single writer; caps and secret filter match the in-process path. */
  async mutateAgentMemory(
    agentId: string,
    file: string,
    action: MemoryAction,
    options: { content?: string; oldText?: string },
  ): Promise<MemoryMutationResult> {
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));
    return this.options.memoryStore.mutate(agent.memoryDir, file, action, options);
  }

  /** Atomic batch memory write (§5): validated against the FINAL budget,
   * committed under one write — same guarded path as single ops. */
  async mutateAgentMemoryBatch(
    agentId: string,
    file: string,
    operations: Array<{ action: MemoryAction; content?: string; oldText?: string }>,
  ): Promise<MemoryMutationResult> {
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));
    return this.options.memoryStore.mutateBatch(agent.memoryDir, file, operations);
  }

  // --- internals ---------------------------------------------------------------

  private createTask(text: string, targets: string[]): Task {
    return { id: newId("task"), roomId: this.roomId, text, targets, status: "running", startedAt: new Date().toISOString() };
  }

  private settleTask(task: Task, status: "complete" | "error" | "cancelled", error?: unknown): void {
    task.status = status;
    task.endedAt = new Date().toISOString();
    if (error !== undefined) task.error = error instanceof Error ? error.message : String(error);
    this.recentTasks = [...this.recentTasks.slice(-9), task];
    if (this.activeTask?.id === task.id) this.activeTask = undefined;
    if (this.activeAgentTurn?.id === task.id) this.activeAgentTurn = undefined;
    if (status === "error") {
      this.fireHooks("error", { taskId: task.id, agentIds: task.targets, error: (task.error ?? "").slice(0, HOOK_TEXT_CAP) });
      this.emit({ type: "task-error", workspaceId: this.workspaceId, roomId: this.roomId, task, error: task.error ?? "" });
    } else {
      this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.roomId, task });
    }
    void this.emitRoomsChanged();
    // Emit the settle snapshot BEFORE draining the next queued turn. SSE is a
    // single ordered stream and the client REPLACES its snapshot wholesale, so a
    // settle snapshot that got built before the drain commits the queued
    // message's user event must still be sent FIRST — otherwise a stale copy
    // lands after that room-event and blanks the just-committed bubble for the
    // whole next turn (the "queued message vanished after /compact" bug). The
    // drained turn then emits its own authoritative snapshot post-commit
    // (runAgentTask), which drops the ghost and keeps the committed bubble.
    void this.emitSnapshot()
      .catch(() => {})
      .finally(() => {
        void this.drain();
      });
  }

  private taskCancelled(task: Task): boolean {
    return task.status === "cancelled";
  }

  /** Observer hooks (config.json `hooks`), fire-and-forget: run at the room
   * layer, so they behave identically for every harness. Never awaited on the
   * turn path — a hook can neither block nor fail a turn. */
  private fireHooks(event: HookEvent, payload: Record<string, unknown>): void {
    const hooks = this.workspace.config.hooks?.[event];
    if (!hooks?.length) return;
    void runHooks(hooks, event, { roomId: this.roomId, ...payload }, {
      cwd: this.workspace.rootDir,
      log: (message) => console.warn(`[gaia] ${message}`),
    });
  }

  /** Fold one streamed AgentEvent into the live-turn mirror. Delegates to the
   * SAME `applyEventToDetails` folder that builds the committed event's details
   * (turns.ts) — one shared implementation, so the mid-turn snapshot mirror, the
   * live client stream, and the final committed event agree by construction
   * (text + thinking + tools + ordered blocks). Guarded on eventId so a stray
   * event from a prior target can't bleed in. */
  private applyLiveTurn(eventId: string, event: AgentEvent): void {
    const live = this.liveTurn;
    if (!live || live.eventId !== eventId) return;
    if (event.type === "text-delta") live.text += event.delta;
    applyEventToDetails(live.details, event);
  }

  private toUiEvent(taskId: string, agentId: string, eventId: string, event: AgentEvent): UiEvent {
    const scope = { workspaceId: this.workspaceId, roomId: this.roomId, taskId, agentId, eventId };
    switch (event.type) {
      case "model-info":
        return { ...scope, type: "model-info", provider: event.provider, modelId: event.modelId, subscription: event.subscription };
      case "model-fallback":
        return { ...scope, type: "model-fallback", fromModel: event.fromModel, toModel: event.toModel, reason: event.reason };
      case "context-usage":
        // The onEvent handler has already stored the resolved window (turn-end
        // value, last-known, or a-priori fallback); ride it out so the live chip
        // renders a % even before the harness reports the window at turn-end.
        return { ...scope, type: "context-usage", usedTokens: event.usedTokens, maxTokens: event.maxTokens ?? this.contextUsage[agentId]?.maxTokens };
      case "text-delta":
        return { ...scope, type: "text-delta", delta: event.delta };
      case "thinking-start":
        return { ...scope, type: "thinking-start" };
      case "thinking-delta":
        return { ...scope, type: "thinking-delta", delta: event.delta };
      case "thinking-end":
        return { ...scope, type: "thinking-end", content: event.content };
      case "tool-start":
        return { ...scope, type: "tool-start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args };
      case "tool-update":
        return { ...scope, type: "tool-update", toolName: event.toolName, toolCallId: event.toolCallId, partialResult: event.partialResult };
      case "tool-end":
        return { ...scope, type: "tool-end", toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError };
      case "steered":
        return { ...scope, type: "steered", steerEventId: event.eventId };
    }
  }

  private async emitSnapshot(): Promise<void> {
    this.emit({ type: "snapshot", workspaceId: this.workspaceId, roomId: this.roomId, snapshot: await this.getSnapshot() });
  }

  private emit(event: UiEvent): void {
    this.bus.emit(event);
  }

  /** Broadcast the workspace's room list to EVERY client in the workspace (no
   * roomId scope), so a sidebar updates a room's running dot / unread badge even
   * when that room isn't the one being viewed — the per-room SSE only carries
   * the open room's own events. Best-effort chrome; never breaks a turn. */
  private async emitRoomsChanged(): Promise<void> {
    try {
      this.emit({ type: "rooms", workspaceId: this.workspaceId, rooms: await this.listRooms() });
    } catch {
      // A rooms refresh is decorative; a failed disk read must not surface.
    }
  }

  private unknownAgentMessage(agentId: string): string {
    return `Unknown agent: @${agentId}\nAvailable agents: ${Object.keys(this.workspace.agents)
      .map((id) => `@${id}`)
      .join(", ")}`;
  }
}
