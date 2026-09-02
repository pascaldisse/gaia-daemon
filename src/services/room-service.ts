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

import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { attachmentMime, sanitizeAttachmentName } from "../core/attachments.js";
import { Bus } from "../core/bus.js";
import { newId } from "../core/ids.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import { globalPaths, workspacePaths } from "../core/paths.js";
import { sleep } from "../core/retry.js";
import { GOAL_COMPLETE_SIGNAL } from "../core/types.js";
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
  RoomGoal,
  Snapshot,
  Task,
  UiEvent,
  Workspace,
} from "../core/types.js";
import { DEFAULTS, DEFAULT_CONTEXT_WARN_TOKENS } from "../core/config.js";
import { displayEventText, type RenderCap } from "../domain/render-cap.js";
import { estimateTokens } from "../core/tokens.js";
import type { ResumeEpoch } from "./resume-epoch.js";
import { deriveRoomTitle, isAutoRoomId, newRoomEventId, normalizeRoomState, normalizeRoomTitle, RoomHandle } from "../domain/rooms.js";
import { DEFAULT_PET_NAME, listWorkspacePetBindings, loadPet } from "../domain/pets.js";
import { resolveRoomWorkDir } from "../domain/worktree.js";
import { effectiveAgentTools, resolveAgentRole } from "../domain/roles.js";
import type { MemoryStore, MemoryAction, MemoryMutationResult } from "../domain/memory.js";
import { formatMemoryHits, type ActiveContextRef, type MemorySearchHit } from "../domain/workspace-index.js";
import type { AgentRuntime, HarnessHost } from "../harness/spec.js";
import { capabilitiesFor, contextWindowFor, findHarness, harnessIdFor, usageAccountFor } from "../harness/spec.js";
import { readOptional, renderAttachmentLines, renderRoomTranscript } from "../harness/prompt.js";
import { readUserNameSetting } from "./user-name.js";
import { HELP_TEXT, hasExplicitMention, mentionedAgents, parseCommand, planMentionRoute, type SlashCommand } from "./commands.js";
import { loadCommandPlugins, pluginStateKey, type CommandPlugin, type PluginContext, type PluginPanel, type PluginResult } from "./plugins.js";
import { SANITIZE_REVIEWER_ID, buildSanitizePrompt, parseSanitizeProposal, type SanitizeContext } from "./sanitize.js";
import { applyEventToDetails, finalizeInterruptedTools, runAgentTurn } from "./turns.js";
import { ContextPolicyStore } from "./context-policy-store.js";
import { DEFAULT_CONTEXT_DIET_POLICY } from "../domain/context-diet.js";
import type { EpisodeCapture } from "./memory-service.js";
import { formatDreamProposal } from "./consolidate.js";
import type { ConsolidateLlm, ConsolidateResult } from "./consolidate.js";
import { allowSummonForTurn, effectiveTrust, type SummonHost, type SummonResultDelivery } from "./summons.js";
import { HOOK_TEXT_CAP, runHooks, type HookEvent } from "./hooks.js";
import { MonadEngine } from "./monad.js";
import { activateSetup, deactivateMonad, discoverSetups } from "./setups.js";
import { createAgentRuntime } from "../harness/host.js";
import { configuredModelLabel } from "../harness/model-label.js";
import { resolveSandboxPolicy } from "../harness/sandbox/spec.js";
import { sttEngineIds } from "./transcribe.js";
import * as contextGate from "./room/context-gate.js";
import { RoomFork } from "./room/fork.js";
import { RoomTurnLoop } from "./room/turn-loop.js";
import { installRoomAgentCommands, RoomAgentCommandsMixin } from "./room/agent-commands.js";
import { RoomQueue } from "./room/queue.js";
import { installRoomCommands, RoomCommandsMixin } from "./room/commands-facade.js";
import { installRoomSanitize, RoomSanitizeMixin } from "./room/sanitize-facade.js";
import { installRoomUi, RoomUiMixin } from "./room/ui.js";
import { installRoomSnapshot, RoomSnapshotMixin } from "./room/snapshot.js";
export { readAmbientWatchdog, scanRoomActivity } from "./room/snapshot.js";
import { readVoiceSettings } from "./voice.js";
import { BackgroundTasks } from "./room/background-tasks.js";

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

/** Max consecutive agent→agent hand-offs before room agent-dialogue pauses and
 * waits for a human. The toggle is the on/off; this is the runaway backstop. */
export const AGENT_DIALOGUE_MAX_HOPS = 8;

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

let reloadDaemon: (() => void | Promise<void>) | undefined;

export function configureRoomServiceReload(callback: (() => void | Promise<void>) | undefined): void {
  reloadDaemon = callback;
}

/** Read the persisted voice settings as an update document. Unlike
 * readVoiceSettings(), this rejects malformed/non-object JSON so a slash
 * command can never replace an unreadable file and silently erase secrets or
 * future fields. Missing is the one valid empty-document case. */
async function readVoiceSettingsDocument(): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(globalPaths.voiceSettings(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("voice.json is malformed; fix it before switching engines");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("voice.json must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

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
  private readonly bus = new Bus<UiEvent>();
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
  private contextGate: ContextGatePending | undefined;
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
  /** Local command-plugin extensions from ~/.gaia/plugins/*.mjs (see
   * services/plugins.ts) — loaded once per RoomService and cached. */
  readonly pluginsPromise: Promise<Map<string, CommandPlugin>> = loadCommandPlugins();

  /** Immutable: this room is invisible to long-term memory. See RoomState.incognito. */
  readonly incognito: boolean;
  /** Context-diet policy store (09-MEMORY-CONTEXT): workspace default + this
   * room's override, file-backed under .gaia/ — backs `/diet` and the
   * `diet`/`tool_result_fetch` gaia-tool verbs. Default OFF (IRON). */
  readonly dietPolicyStore: ContextPolicyStore;
  private readonly backgroundTasks: BackgroundTasks;

  constructor(readonly options: RoomServiceOptions & { room: RoomHandle }) {
    this.room = options.room;
    this.incognito = options.incognito === true;
    this.dietPolicyStore = new ContextPolicyStore(options.workspace.rootDir);
    this.backgroundTasks = new BackgroundTasks({
      room: this.room,
      roomId: this.roomId,
      emitSnapshot: () => this.emitSnapshot(),
    });
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
              // Resolved at spawn (after init), when parentRoomId and the
              // inherited untrusted tier are known.
              allowSummon: () => allowSummonForTurn(agent, this.isSummonRoom, this.summonUntrusted),
              sandbox: () =>
                resolveSandboxPolicy(options.workspace.config.sandbox, agent.sandbox, this.isSummonRoom, {
                  trusted: effectiveTrust(agent, this.summonUntrusted),
                }),
              workDir: () => this.workDir,
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
  /** This room inherited the untrusted tier from its summon chain (see
   * RoomState.summonUntrusted) — feeds effectiveTrust for sandbox resolution. */
  private summonUntrusted = false;
  /** This room's isolated working directory (RoomState.workDir — its git
   * worktree under collab isolation), validated against the filesystem at
   * init. Assigned at room-service init for EVERY room — default,
   * interactive, and summon children alike — not at summon launch.
   * undefined = run at the workspace root. Feeds the runtimes' workDir thunk. */
  private workDir: string | undefined;

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

  private async initOnce(): Promise<void> {
    await Promise.all(Object.values(this.workspace.agents).map((agent) => this.options.memoryStore.init(agent.memoryDir, agent.displayName)));
    const state = await this.room.state();
    this.isSummonRoom = Boolean(state.parentRoomId);
    this.summonUntrusted = state.summonUntrusted === true;
    // This room's working directory: top-level rooms OWN a git worktree under
    // collab isolation (created here on first open); summon rooms INHERIT the
    // parent's (resolved + stamped at summon launch). A vanished dir degrades
    // to the workspace root instead of wedging every spawn on a dead cwd.
    this.workDir = await resolveRoomWorkDir(this.workspace.rootDir, this.workspace.config.collab, state, this.room.roomId);
    if (this.workDir && this.workDir !== state.workDir) {
      const dir = this.workDir;
      await this.room.updateState((s) => { s.workDir = dir; });
    }
    // Restore the per-agent context accounting so the composer's `ctx` chip is
    // present from first paint after a restart, not blank until the next turn.
    if (state.contextUsage) this.contextUsage = { ...state.contextUsage };
    // Reopen a held context-gate decision (the modal persists across a restart).
    this.contextGate = state.contextGate;

    // Surface a previously saved sanitize proposal (popup reopens after restart).
    // Only ACTIONABLE proposals are restored as pending: a review that returned
    // no output, didn't parse, or found nothing has 0 suggestions and can never
    // be applied, so it must not linger as a pending item that re-pops the popup
    // on every reload. The file stays on disk — reopening the popup manually
    // still shows Dario's raw notes.
    const savedProposal = (await readJson(this.sanitizeProposalPath)) as SanitizeProposal | null;
    if (savedProposal?.at && Array.isArray(savedProposal.suggestions) && savedProposal.suggestions.length > 0) {
      this.sanitizeStatus = {
        at: savedProposal.at,
        suggestions: savedProposal.suggestions.length,
        ...(savedProposal.appliedAt ? { appliedAt: savedProposal.appliedAt } : {}),
      };
    }

    // Interrupted turn? Resume in the background — never blocks opening.
    if (state.pendingTurn) void this.resumePendingTurn(state.pendingTurn).catch(() => {});
    // Durable queue survivors from a prior process: rebuild their task chips.
    // Voice-channel synthetics are dropped — their call is gone.
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
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          // Agent-authored hand-offs/summon callbacks aren't "user →" ghosts.
          ...(message.fromAgentDialogue ? { callback: true } : {}),
        }));
    }

    // Goal recovery: every active goal owns either an in-flight WAL marker or
    // one durable queue entry. If a process died after committing a reply but
    // before enqueueing its successor, recreate that successor on boot.
    const goal = state.goal;
    const goalPending = goal && state.pendingTurn?.goalStartedAt === goal.startedAt;
    const goalQueued = goal && queue.some((message) => message.goalStartedAt === goal.startedAt);
    if (goal?.status === "active" && !goalPending && !goalQueued) {
      await this.enqueueGoalTurn(goal, true, !state.pendingTurn);
    } else if (!state.pendingTurn && this.queuedTasks.length > 0 && !this.activeTask) {
      void this.drain();
    }
  }

  subscribe(listener: (event: UiEvent) => void): () => void {
    return this.bus.on(listener);
  }

  async dispose(): Promise<void> {
    clearTimeout(this.authRetryTimer);
    this.authRetryTimer = undefined;
    await Promise.all(Object.values(this.runtimes).map((runtime) => runtime.dispose()));
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
  async runPetCommand(command: Extract<RoomCommand, { type: "pet" }>): Promise<string> {
    if (command.action === "list") {
      const bindings = (await this.room.state()).petBindings ?? {};
      const rows = Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b));
      return rows.length > 0
        ? `Pet bindings in this room:\n${rows.map(([agentId, packageName]) => `  @${agentId} → ${packageName}`).join("\n")}`
        : "No pet bindings in this room. Pets are off by default.";
    }

    const target = command.agent ?? (await this.roomDefaultTarget());
    if (!this.workspace.agents[target]) return this.unknownAgentMessage(target);

    if (command.action === "off") {
      let removed = false;
      await this.room.updateState((state) => {
        if (!state.petBindings?.[target]) return;
        removed = true;
        delete state.petBindings[target];
        if (Object.keys(state.petBindings).length === 0) delete state.petBindings;
      });
      await this.emitPetBindings();
      return removed
        ? `Pet removed for @${target}.`
        : `No pet is bound to @${target} in this room.`;
    }

    // Bare /pet (no package) just spawns the default pet for whoever you're
    // talking to — a package name is an override, never a requirement.
    const packageName = command.package?.trim() || DEFAULT_PET_NAME;
    try {
      await (this.options.petLoader ?? loadPet)(packageName);
    } catch (error) {
      return `Invalid pet package '${packageName}': ${error instanceof Error ? error.message : String(error)}`;
    }
    await this.room.updateState((state) => {
      state.petBindings = { ...(state.petBindings ?? {}), [target]: packageName };
    });
    await this.emitPetBindings();
    return `Pet '${packageName}' bound to @${target} in this room. The transparent always-on-top pet window is available in the desktop app only.`;
  }

  private async emitPetBindings(): Promise<void> {
    this.emit({
      type: "pet-bindings",
      workspaceId: this.workspaceId,
      bindings: await listWorkspacePetBindings(this.workspaceId, this.workspace.rootDir),
    });
    await this.emitSnapshot();
  }

  /** Remember the agent a turn addressed as this room's active agent (persisted,
   * best-effort). The last target of a broadcast wins — that's who a bare next
   * message goes to. Skips unknown ids so a stale write can't wedge routing. */
  async rememberActiveAgent(targets: string[]): Promise<void> {
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
  async maybeDispatchAgentDialogue(author: string, reply: string): Promise<void> {
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
  private async enqueueAgentDialogue(targets: string[], text: string, options: { goalStartedAt?: string; kick?: boolean } = {}): Promise<void> {
    const task = this.createTask(text, targets);
    task.status = "queued";
    task.callback = true;
    await this.room.enqueue({
      taskId: task.id,
      text,
      targets,
      fromAgentDialogue: true,
      ...(options.goalStartedAt ? { goalStartedAt: options.goalStartedAt } : {}),
      queuedAt: task.startedAt,
    });
    this.queuedTasks.push(task);
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
    void this.emitSnapshot();
    if (options.kick !== false && !this.activeTask) void this.drain();
  }

  /** Queue one synthetic goal turn through the ordinary durable agent path. */
  async enqueueGoalTurn(goal: RoomGoal, continuing: boolean, kick = true): Promise<void> {
    const verb = continuing ? "Continue" : "Begin";
    await this.enqueueAgentDialogue(
      [goal.agentId],
      `${verb} the pinned room goal: "${goal.objective}". Work autonomously from the room context. When — and only when — the goal is fully achieved, write ${GOAL_COMPLETE_SIGNAL} on its own line; otherwise keep working.`,
      { goalStartedAt: goal.startedAt, kick },
    );
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

  /** Public rooms rebroadcast for the summon coordinator: a summon child
   * leaving the coordinator's running set changes the PARENT room's
   * banner/sidebar truth, but the child's own task-end broadcast raced
   * ahead of that cleanup — the coordinator calls this after dropping the
   * child so clients stop counting a dead summon. */
  async broadcastRoomsChanged(): Promise<void> {
    await this.emitRoomsChanged();
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
  /** True while a queued message or durable pending-turn marker still exists — i.e. the room
   * will run again without outside input (auth-retry requeue etc.). */
  async hasPendingWork(): Promise<boolean> {
    await this.init();
    return Boolean(this.activeTask || this.queuedTasks.length > 0 || (await this.room.state()).pendingTurn != null);
  }

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
      await sleep(250);
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

  /** Fix #1 (resume-completion tracking): mark THIS room's most recent
   * `gaia resume` durable record delivered — called by the coordinator AFTER
   * the resumed turn's result landed in the parent room. Independent of
   * `status` above (stays "delivered" from the original first-turn summon);
   * see SummonDelivery.resumeStatus. */
  async markSummonResumeDelivered(token: ResumeEpoch): Promise<void> {
    await this.init();
    await this.room.updateState((state) => {
      if (!state.summon) return;
      // Epoch-keyed and MANDATORY (RC6): a close names the exact resume it
      // finished. A later resume already overwrote resumeStartedAt — a stale
      // watcher must not clear that newer, still-running epoch. There is no
      // token-less close: an unguarded one would clear whatever is live.
      if (state.summon.resumeStartedAt !== token) return;
      state.summon.resumeStatus = "delivered";
    });
  }

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

  /** Remove ONE still-queued message from the durable queue — the ✕ on a queued
   * ghost bubble. Harness-agnostic by construction: the queue is shared room
   * plumbing (state.json.queue) and deletion touches no runtime, so it behaves
   * identically for every harness with zero harness-id branching. Durable-first
   * ordering (splice the persisted entry, then the in-memory chip) mirrors
   * clearQueued so a crash can't resurrect a deleted message. Idempotent:
   * returns the dropped task, or undefined when the entry already drained into a
   * running turn (drain() pulls the chip out of queuedTasks first) or never
   * existed — letting the caller 404 cleanly instead of racing an in-flight
   * turn. */
  async deleteQueuedMessage(taskId: string): Promise<Task | undefined> {
    await this.init();
    const task = this.queuedTasks.find((candidate) => candidate.id === taskId);
    if (!task) return undefined;
    await this.room.spliceQueued(taskId);
    this.queuedTasks = this.queuedTasks.filter((candidate) => candidate.id !== taskId);
    task.status = "cancelled";
    task.endedAt = new Date().toISOString();
    this.recentTasks = [...this.recentTasks.slice(-9), task];
    this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.roomId, task });
    return task;
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

  async runAgentTask(task: Task, text: string, options: SendMessageOptions): Promise<void> {
    return new RoomTurnLoop(this).runAgentTask(task, text, options);
  }

  private contextFor(agent: AgentDef): { usedTokens: number; maxTokens?: number } | undefined {
    return new RoomTurnLoop(this).contextFor(agent);
  }

  // --- context gate ----------------------------------------------------------

  private async openContextGate(agent: AgentDef, message: string, estTokens: number, totalEvents: number, attachments: MessageAttachment[] | undefined, reason: "new-agent" | "session-lost"): Promise<void> {
    return contextGate.openContextGate(this as any, agent, message, estTokens, totalEvents, attachments, reason);
  }

  async resolveContextGate(choice: "full" | "last" | "compact", n?: number): Promise<void> {
    return contextGate.resolveContextGate(this as any, choice, n);
  }

  async setContextFloor(agentId: string, floorIdx: number): Promise<void> {
    return contextGate.setContextFloor(this as any, agentId, floorIdx);
  }

  async recallContext(agentId: string): Promise<ActiveContextRef> {
    return contextGate.recallContext(this as any, agentId);
  }

  private async summarizeRoom(target: string, uptoEvents: number): Promise<string> {
    return contextGate.summarizeRoom(this as any, target, uptoEvents);
  }

  /** WAL step 2: append the reply event (details ON it), then one atomic state
   * write clearing the marker and advancing the cursor. */
  /** `renderCap`, when given, is a command-plugin's display-time cap resolved
   * for THIS turn (services/plugins.ts CommandPlugin.renderCap) — persisted
   * on the event verbatim alongside the agent's FULL, untruncated `reply`
   * text (root-cause fix, Pascal, 2026-08-23: the event committed/stored here
   * must never be shorter than what the agent actually said). Only the
   * LIVE-emitted copy's `text` is capped, via displayEventText — and, when
   * `renderCap.note` is set, a SEPARATE synthesized system-authored chrome
   * event is emitted right after it (see withRenderCapNotes) — matching every
   * other display surface (#getSnapshot, #eventById(display:true)) that
   * derives the same shown output from the same stored (text, renderCap)
   * pair on demand. */
  async commitReply(
    agentId: string,
    eventId: string,
    reply: string,
    details: EventDetails,
    channel: "voice" | undefined,
    nextPending?: PendingTurn,
    renderCap?: RenderCap,
  ): Promise<void> {
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
      ...(renderCap ? { renderCap } : {}),
    };
    // commitTurn computes the cursor from the reply's own line (sweeping the
    // mid-turn steers/notes the live turn already saw) and, for a multi-target
    // turn, installs the next target's marker in the same atomic write. Always
    // the FULL text — storage/memory/hooks/agent-context never see a capped
    // reply, only display surfaces do.
    await this.room.commitTurn(event, nextPending);
    for (const displayEvent of this.withRenderCapNotes([event])) {
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event: displayEvent });
    }
  }

  /** Durable failure marker: a turn that dies must leave a trace in the
   * transcript, not just the ephemeral task-error toast (which vanishes on the
   * next reload — the poisoned-gateway incident left rooms full of failed
   * turns with zero on-disk evidence). Authored by "system" so it renders as a
   * system line and stays out of every agent's context. Best-effort: marking
   * the failure must never mask the failure itself.
   *
   * `kind: "turn-failed"` is the ONLY signal the client needs to offer a resend
   * — it means the user message right before this row got NO reply at all
   * (producedOutput was false at the call site). Without it, the transcript's ⟳
   * only ever appears on an agent reply, so a reply-less failed turn had no
   * fork-based recovery and users retyped the same text into the composer,
   * which appends a brand-new user event instead of regenerating (the
   * duplicate-resend bug). retryMessage(eventId) on THIS event's id already
   * resolves correctly — forkAtUserMessage walks backward past non-user authors
   * to the user message that produced it. */
  async appendTurnFailure(agentId: string, error: unknown): Promise<void> {
    try {
      const message = error instanceof Error ? error.message : String(error);
      const event: RoomEvent = {
        id: newId("system_turnfail"),
        timestamp: new Date().toISOString(),
        author: "system",
        kind: "turn-failed",
        text: `⚠ turn failed (@${agentId}): ${message}`,
      };
      await this.room.appendEvent(event);
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
    } catch {
      // The task-error path still surfaces the original error live.
    }
  }

  /** Quiet counterpart to appendTurnFailure for user cancels that beat the
   * first token: a stop is not a failure. */
  async appendTurnStopped(agentId: string): Promise<void> {
    try {
      const event: RoomEvent = {
        id: newId("system_turnfail"),
        timestamp: new Date().toISOString(),
        author: "system",
        text: `■ turn stopped (@${agentId}) — no output yet`,
      };
      await this.room.appendEvent(event);
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
    } catch {
      // The task-error path still surfaces the original error live.
    }
  }

  /** Requeue-once after RunnerHost's hard stall deadline aborted the turn
   * (a named UpstreamStallError — src/harness/host.ts): a stalled turn that
   * produced no reply text gets exactly ONE automatic retry, through the same
   * durable queue every other queued message uses, marked `stallRetried` so a
   * SECOND stall on the retry falls through to the normal failure path
   * instead of keeping a dead upstream's retry loop alive forever. Returns
   * true when it requeued — the caller then skips its generic
   * appendTurnFailure in favor of the more specific system line this appends.
   * No-op (false) for any other error, a non-empty partial (current commit +
   * failure behavior is unchanged), or a turn that was itself a stall retry. */
  async maybeRequeueStall(
    targets: string[],
    agentId: string,
    text: string,
    error: unknown,
    partialReply: string,
    channel: "voice" | undefined,
    attachments: MessageAttachment[] | undefined,
    options: SendMessageOptions,
  ): Promise<boolean> {
    const isStall = error instanceof Error && error.name === "UpstreamStallError";
    if (!isStall || partialReply.trim() || options.queued?.stallRetried) return false;
    const event: RoomEvent = {
      id: newId("system_stallretry"),
      timestamp: new Date().toISOString(),
      author: "system",
      text: `⚠ turn aborted after upstream stall (@${agentId}) — message requeued, retrying once`,
    };
    await this.room.appendEvent(event);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
    const retryTask = this.createTask(text, targets);
    retryTask.status = "queued";
    await this.room.enqueue({
      taskId: retryTask.id,
      text,
      targets,
      ...(channel ? { channel } : {}),
      ...(attachments?.length ? { attachments } : {}),
      stallRetried: true,
      queuedAt: retryTask.startedAt,
    });
    this.queuedTasks.push(retryTask);
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task: retryTask });
    void this.emitSnapshot();
    return true;
  }

  async maybeRequeueAuth(
    targets: string[],
    agentId: string,
    text: string,
    error: unknown,
    _partialReply: string,
    channel: "voice" | undefined,
    attachments: MessageAttachment[] | undefined,
    options: SendMessageOptions,
  ): Promise<boolean> {
    const isAuth = error instanceof Error && error.name === "TransientAuthError";
    const attempt = (options.queued?.authRetries ?? 0) + 1;
    if (!isAuth || attempt > 5) return false;
    const backoff = [30_000, 60_000, 120_000, 300_000, 600_000][attempt - 1];
    const event: RoomEvent = {
      id: newId("system_authretry"),
      timestamp: new Date().toISOString(),
      author: "system",
      text: `⚠ turn failed on transient auth (@${agentId}) — requeued, retry ${attempt}/5 in ${backoff / 1000}s`,
    };
    await this.room.appendEvent(event);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
    const retryTask = this.createTask(text, targets);
    retryTask.status = "queued";
    await this.room.enqueue({
      taskId: retryTask.id,
      text,
      targets,
      ...(channel ? { channel } : {}),
      ...(attachments?.length ? { attachments } : {}),
      authRetries: attempt,
      notBefore: new Date(Date.now() + backoff).toISOString(),
      queuedAt: retryTask.startedAt,
    });
    this.queuedTasks.push(retryTask);
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task: retryTask });
    void this.emitSnapshot();
    return true;
  }

  /** Episodic capture is best-effort derived data: a failure must never fail
   * the turn that produced it. */
  async captureEpisode(
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
        ...(pending.goalStartedAt ? { goalStartedAt: pending.goalStartedAt } : {}),
      });
    }
  }

  // --- monad -----------------------------------------------------------------

  async isMonadMessage(text: string, options: SendMessageOptions): Promise<boolean> {
    const state = await this.room.state();
    if (!state.monad || !this.options.summonHost) return false;
    if (options.targets) return false;
    return !hasExplicitMention(text, new Set(Object.keys(this.workspace.agents)));
  }

  async monadAuthor(): Promise<string[]> {
    const state = await this.room.state();
    const monad = state.monad;
    return [monad?.coordinatorAgentId ?? monad?.slots[0]?.agentId ?? this.workspace.config.defaultAgent];
  }

  /** Runs the monad engine over a user message: each step is a real summon (a
   * visible child room); only the single final answer posts here. */
  async runMonadTask(task: Task, text: string, options: SendMessageOptions): Promise<void> {
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

  async runCommand(task: Task, command: RoomCommand): Promise<void> {
    try {
      const handler = COMMANDS[command.type];
      const reply = handler ? await handler(this, command) : `Unknown command. Try /help.`;
      const text = typeof reply === "string" ? reply : reply.text;
      // A command reply defaults to "system" but a rare handler may attribute
      // it to a specific agent instead — same event shape as a real agent
      // reply, just synthesized here with no LLM turn.
      const author = typeof reply === "string" ? "system" : (reply.author ?? "system");
      // Persist the reply so a command result (e.g. /compact) survives a reload
      // instead of only flashing on the live stream. appendEvent both writes it
      // to the transcript and emits the room-event to connected clients. Skip the
      // transcript-structural commands: they reset/truncate history themselves, so
      // a leftover confirmation would re-seed the room they just emptied.
      const event: RoomEvent = {
        id: `${author === "system" ? "system" : "cmd"}_${task.id}`,
        timestamp: new Date().toISOString(),
        author,
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

  async runSttCommand(engine?: string, alias?: "tts"): Promise<string> {
    const available = sttEngineIds();
    const aliasNote = alias ? " `/tts` controls voice input here; `/stt` is the canonical name." : "";
    if (engine && !available.includes(engine)) {
      return `Unknown STT engine "${engine}". Available: ${available.join(", ")}.${aliasNote}`;
    }
    try {
      const document = await readVoiceSettingsDocument();
      if (engine) {
        await writeJsonAtomic(globalPaths.voiceSettings(), { ...document, sttEngine: engine });
        return `Speech-to-text engine switched to ${engine}. Available: ${available.join(", ")}.${aliasNote}`;
      }
      const current = (await readVoiceSettings()).sttEngine;
      return `Speech-to-text engine: ${current}. Available: ${available.join(", ")}. Use /stt <engine> or /tts <engine>.${aliasNote}`;
    } catch (error) {
      return `Could not ${engine ? "switch" : "read"} the STT engine: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async runReloadCommand(): Promise<string> {
    const reload = reloadDaemon;
    if (!reload) return "Reload is unavailable in this process.";
    // Room-level provenance for the restart-attribution trail (see
    // requestReload in server/http.ts): which room's /reload ordered it.
    console.log(`[gaia] ${new Date().toISOString()} /reload command issued in room ${this.roomId} (workspace ${this.workspaceId})`);
    setTimeout(() => {
      void reload();
    }, 0);
    return "reloading daemon — in-flight turns resume after restart.";
  }

  // --- agent configuration commands: ./room/agent-commands.ts (RoomAgentCommandsMixin) ---

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
    // One composite call: wiping the transcript and resetting the cursors that
    // index it must not be observable half-done by another process.
    await this.room.clearRoom();
    this.recentTasks = [];
    await this.emitSnapshot();
    return "Cleared room history and reset all agent sessions.";
  }

  async runRefreshCommand(): Promise<string> {
    for (const runtime of Object.values(this.runtimes)) runtime.refreshContext?.(this.roomId);
    return "context refreshed — fresh soul/AGENTS.md/skills apply from each agent's next turn";
  }

  /** /fork: branch into a sibling room. Transcript copies verbatim; cursors
   * RESET so the branch's first turn replays the whole transcript — the one
   * context-rebuild mechanism that works for every harness (sessions cannot
   * be branched). */
  async runForkCommand(): Promise<string> {
    const target = this.nextForkId(this.roomId);
    const dstDir = workspacePaths.roomDir(this.workspace.rootDir, target);
    // Reserve the target directory exclusively before touching it: a stale
    // nextForkId observation must abort, never seed over another fork.
    try {
      await mkdir(dstDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return `Fork aborted: room '${target}' was reserved concurrently — nothing was copied.`;
      throw error;
    }
    // Source transcript + state share one lock snapshot; release it before
    // opening the reserved target, so reciprocal forks never dual-lock.
    const snapshot = await this.room.snapshotRoom();
    const branch = await RoomHandle.open(this.workspace.rootDir, target);
    // Exclusive create: false means a room already owns that id, so the
    // snapshot was NOT written. Never report a fork that did not happen.
    if (!(await branch.seedTranscript(snapshot.transcript)))
      return `Fork aborted: room '${target}' already has a transcript — nothing was copied.`;
    await branch.updateState((next) => {
      next.activeRoles = { ...snapshot.state.activeRoles };
      next.thinkingOverrides = { ...snapshot.state.thinkingOverrides };
    });
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

  /** One committed transcript event by id. `display: true` (read-aloud and
   * similar "what would a human see/hear" lookups) returns it through the
   * same command-plugin render cap every other display surface uses
   * (#getSnapshot, #eventsBefore, #commitReply's live emit) — default false
   * keeps the FULL stored text, for internal introspection (e.g.
   * toolResultSlice below, which needs the real content regardless of any
   * plugin-imposed cap). */
  async eventById(eventId: string, opts: { display?: boolean } = {}): Promise<RoomEvent | undefined> {
    await this.init();
    const { events } = await this.room.eventsFrom(0);
    const event = events.find((event) => event.id === eventId);
    if (!event) return undefined;
    return opts.display ? this.displayEvents([event])[0] : event;
  }

  /** Pages the ORIGINAL, uncollapsed call/args/result for a diet-collapsed own
   * tool-call stub back by (eventId, toolId) — backs `tool_result_fetch`
   * (09-MEMORY-CONTEXT). The canonical RoomEvent.details.tools entry is the
   * single durable source; nothing there is ever collapsed — only the
   * render-time renderRoomTranscript projection ever shows a stub, so this
   * always finds the full original. */
  async toolResultSlice(
    callerId: string,
    eventId: string,
    toolId: string,
    offset: number,
    limit: number,
  ): Promise<{ text: string; totalLength: number; hasMore: boolean } | undefined> {
    const event = await this.eventById(eventId);
    if (!event || "targets" in event || event.author !== callerId) return undefined; // only own agent activity is pageable
    const tool = event.details?.tools?.find((candidate) => candidate.id === toolId);
    if (!tool) return undefined;
    const full = JSON.stringify({ call: tool.toolName, args: tool.args, result: tool.result }, null, 2);
    const text = full.slice(offset, offset + limit);
    return { text, totalLength: full.length, hasMore: offset + text.length < full.length };
  }

  async recordBackgroundTask(agentId: string, event: Extract<AgentEvent, { type: "background-task" }>): Promise<void> {
    await this.backgroundTasks.record(agentId, event);
  }
  async backgroundTaskOutput(taskId: string): Promise<{ text: string; running: boolean } | undefined> {
    await this.init();
    return this.backgroundTasks.output(taskId);
  }
  async stopBackgroundTask(taskId: string): Promise<boolean> {
    await this.init();
    return this.backgroundTasks.stop(taskId);
  }


}

export interface RoomService extends RoomSnapshotMixin, RoomUiMixin, RoomCommandsMixin, RoomSanitizeMixin, RoomAgentCommandsMixin {}
installRoomSnapshot(RoomService.prototype);
installRoomUi(RoomService.prototype);
installRoomCommands(RoomService.prototype);
installRoomSanitize(RoomService.prototype);
installRoomAgentCommands(RoomService.prototype);
