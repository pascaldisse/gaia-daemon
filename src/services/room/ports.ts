import type {
  AgentDef,
  AgentEvent,
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
  RoomGoal,
  RoomEvent,
  RoomEventKind,
  SanitizeProposal,
  SanitizeStatus,
  Task,
  UiEvent,
  Workspace,
} from "../../core/types.js";
import type { RoomHandle } from "../../domain/rooms.js";
import type { RenderCap } from "../../domain/render-cap.js";
import type { AgentRuntime } from "../../harness/spec.js";
import type { CommandPlugin, PluginContext, PluginResult } from "../plugins.js";
import type { HookEvent } from "../hooks.js";
import type { EpisodeCapture } from "../memory-service.js";
import type { RoomServiceOptions, SendMessageOptions } from "../room-service.js";
import type { SanitizeContext } from "../sanitize.js";
import type { ResumeEpoch } from "../resume-epoch.js";
import type { SummonResultDelivery } from "../summons.js";

/** Dependencies reached by context-gate persistence and resume. */
export interface RoomContextGatePort {
  readonly room: RoomHandle;
  readonly roomId: string;
  readonly workspace: Workspace;
  readonly options: RoomServiceOptions;
  contextGate: ContextGatePending | undefined;
  readonly compactingAgents: Set<string>;
  readonly compactProgress: Map<string, CompactProgress>;
  init(): Promise<void>;
  emitSnapshot(): Promise<void>;
  sendMessage(text: string, options?: SendMessageOptions): Promise<Task>;
}

/** Dependencies reached by the durable turn executor. */
export interface RoomTurnLoopPort {
  readonly room: RoomHandle;
  readonly roomId: string;
  readonly workspace: Workspace;
  readonly workspaceId: string;
  readonly runtimes: Record<string, AgentRuntime>;
  readonly options: RoomServiceOptions;
  readonly incognito: boolean;
  readonly dietPolicyStore: { effective(roomId: string): Promise<{ preset: boolean }> };
  agentDialogueHops: number;
  liveTurn: LiveTurn | undefined;
  readonly startedPetTargets: Set<string>;
  readonly modelFallbacks: Record<string, ModelFallback>;
  readonly contextUsage: Record<string, { usedTokens: number; maxTokens?: number }>;
  emit(event: UiEvent): void;
  emitSnapshot(): Promise<void>;
  isMonadMessage(text: string, options: SendMessageOptions): Promise<boolean>;
  runMonadTask(task: Task, text: string, options: SendMessageOptions): Promise<void>;
  maybeAutoTitle(text: string): Promise<void>;
  rememberActiveAgent(targets: string[]): Promise<void>;
  taskCancelled(task: Task): boolean;
  isConversationEnded(agentId: string): Promise<boolean>;
  petTargetKey(taskId: string, agentId: string): string;
  emitPetProgress(task: Task, agentId: string, status: PetProgressStatus, toolName?: string): void;
  pluginTurnStart(state: Awaited<ReturnType<RoomHandle["state"]>>): Promise<void>;
  pluginPrompt(state: Awaited<ReturnType<RoomHandle["state"]>>, agentId: string): Promise<string | undefined>;
  pluginRenderCap(state: Awaited<ReturnType<RoomHandle["state"]>>): Promise<RenderCap | undefined>;
  fireWatchdogSteer(target: string, runtime: AgentRuntime, message: string): Promise<void>;
scheduleAutoCompact(target: string): Promise<void>;
runPendingAutoCompact(target: string): Promise<void>;
  recordBackgroundTask(agentId: string, event: Extract<AgentEvent, { type: "background-task" }>): Promise<void>;
  applyLiveTurn(eventId: string, event: AgentEvent): void;
  toUiEvent(taskId: string, agentId: string, eventId: string, event: AgentEvent): UiEvent | undefined;
  fireHooks(type: HookEvent, event: Record<string, unknown>): void;
  commitReply(agentId: string, eventId: string, reply: string, details: EventDetails, channel: "voice" | undefined, nextPending?: PendingTurn, renderCap?: RenderCap): Promise<void>;
  appendTurnFailure(agentId: string, error: unknown): Promise<void>;
  appendTurnRetry(attempt: number, retries: number): Promise<void>;
  appendTurnStopped(agentId: string): Promise<void>;
  maybeRequeueStall(targets: string[], agentId: string, text: string, error: unknown, partialReply: string, channel: "voice" | undefined, attachments: MessageAttachment[] | undefined, options: SendMessageOptions): Promise<boolean>;
  maybeRequeueAuth(targets: string[], agentId: string, text: string, error: unknown, partialReply: string, channel: "voice" | undefined, attachments: MessageAttachment[] | undefined, options: SendMessageOptions): Promise<boolean>;
  captureEpisode(agentId: string, task: string, reply: string, outcome: EpisodeCapture["outcome"], details: EventDetails, channel: "voice" | undefined): Promise<void>;
  settlePetTarget(task: Task, target: string, status: "done" | "failed"): void;
  maybeDispatchAgentDialogue(author: string, reply: string): Promise<void>;
  maybeContinueGoal(author: string, reply: string, goalStartedAt: string): Promise<void>;
  settleTask(task: Task, status: "complete" | "error" | "cancelled", error?: unknown): void;
}

/** Dependencies reached by turn result persistence and retry handling. */
export interface RoomTurnResultsPort extends RoomTurnLoopPort, RoomContextGatePort {
  readonly queuedTasks: Task[];
  createTask(text: string, targets: string[]): Task;
  withRenderCapNotes(events: import("../../core/types.js").RoomEvent[]): import("../../core/types.js").RoomEvent[];
}

/** Dependencies reached by transcript forks, retries, and session resets. */
export interface RoomForkPort {
  readonly room: RoomHandle;
  readonly roomId: string;
  readonly workspace: Workspace;
  readonly runtimes: Record<string, AgentRuntime>;
  readonly activeTask: Task | undefined;
  recentTasks: Task[];
  sendMessage(text: string, options?: SendMessageOptions): Promise<Task>;
  emitSnapshot(): Promise<void>;
}

/** Dependencies reached by room command mixin methods. */
export interface RoomCommandsFacadePort {
  readonly room: RoomHandle;
  readonly roomId: string;
  readonly workspace: Workspace;
  readonly workspaceId: string;
  readonly runtimes: Record<string, AgentRuntime>;
  readonly options: RoomServiceOptions;
  readonly activeTask: Task | undefined;
  readonly activeAgentTurn: Task | undefined;
  readonly compactingAgents: Set<string>;
  readonly compactProgress: Map<string, CompactProgress>;
  lastCompactEmit: number;
  readonly compactCancels: Set<string>;
  readonly queuedTasks: Task[];
  readonly contextUsage: Record<string, { usedTokens: number; maxTokens?: number }>;
  commandPlugins(): Promise<Map<string, CommandPlugin>>;
  init(): Promise<void>;
  emit(event: UiEvent): void;
  emitSnapshot(): Promise<void>;
  distinctPlugins(): Promise<CommandPlugin[]>;
  pluginContext(plugin: CommandPlugin, state: Awaited<ReturnType<RoomHandle["state"]>>, command?: string): PluginContext;
  runPlugin(plugin: CommandPlugin, args: string[], command?: string): Promise<PluginResult>;
  roomDefaultTarget(): Promise<string>;
  unknownAgentMessage(agentId: string): string;
  finishCompactCommand(target: string, result: CompactResult): Promise<string | { text: string; kind?: RoomEventKind; author?: string }>;
  setContextFloor(agentId: string, floorIdx: number): Promise<void>;
  cancelActiveTask(): Promise<Task | undefined>;
  recallContext(agentId: string): Promise<{ roomId: string; floorIdx: number }>;
  resetAfterTruncation(mode: "reset-sessions" | "reset-keep-context", cut?: number, forkOrigin?: { id: string; userOrdinal: number }): Promise<void>;
  enqueueGoalTurn(goal: RoomGoal, continuing: boolean, kick?: boolean): Promise<void>;
  updateGoal(mutate: (current: RoomGoal) => RoomGoal | undefined): Promise<void>;
  emitSystemNote(text: string): void;
  sanitizePreview(): Promise<SanitizeProposal>;
}

/** Dependencies reached by summon lifecycle (deliver/mark/wait) and agent-dialogue
 * hand-off delivery. Split from room-service.ts (Pascal 2026-09-03 A6d). */
export interface RoomSummonLifecyclePort {
  readonly room: RoomHandle;
  readonly roomId: string;
  readonly workspaceId: string;
  readonly workspace: Workspace;
  readonly runtimes: Record<string, AgentRuntime>;
  readonly activeTask: Task | undefined;
  readonly activeAgentTurn: Task | undefined;
  readonly queuedTasks: Task[];
  agentDialogueHops: number;
  init(): Promise<void>;
  emit(event: UiEvent): void;
  emitSnapshot(): Promise<void>;
  emitSystemNote(text: string): void;
  emitRoomsChanged(): Promise<void>;
  drain(onDecided?: () => void): Promise<void>;
  waitForIdle(timeoutMs?: number): Promise<void>;
  createTask(text: string, targets: string[]): Task;
  postAgentNote(agentId: string, text: string, details?: EventDetails): Promise<void>;
}

/** Dependencies reached by sanitize review, proposal persistence, and apply. */
export interface RoomSanitizeFacadePort {
  readonly room: RoomHandle;
  readonly roomId: string;
  readonly workspace: Workspace;
  readonly workspaceId: string;
  readonly options: RoomServiceOptions;
  readonly activeTask: Task | undefined;
  sanitizeStatus: SanitizeStatus | undefined;
  emit(event: UiEvent): void;
  emitSnapshot(): Promise<void>;
  buildPersonaContext(agentId: string): Promise<SanitizeContext | undefined>;
  readonly sanitizeProposalPath: string;
  resetAfterTruncation(mode: "reset-sessions" | "reset-keep-context", cut?: number, forkOrigin?: { id: string; userOrdinal: number }): Promise<void>;
}

/** Dependencies reached by RoomService construction/open/bootstrap/disposal. */
export interface RoomLifecyclePort {
  readonly options: RoomServiceOptions & { room: RoomHandle };
  readonly room: RoomHandle;
  readonly workspace: Workspace;
  readonly incognito: boolean;
  readonly runtimes: Record<string, AgentRuntime>;
  readonly bus: { on(listener: (event: UiEvent) => void): () => void };
  isSummonRoom: boolean;
  summonUntrusted: boolean;
  workDir: string | undefined;
  contextGate: ContextGatePending | undefined;
  sanitizeStatus: SanitizeStatus | undefined;
  readonly sanitizeProposalPath: string;
  contextUsage: Record<string, { usedTokens: number; maxTokens?: number }>;
  queuedTasks: Task[];
  readonly activeTask: Task | undefined;
  authRetryTimer: ReturnType<typeof setTimeout> | undefined;
  resumePendingTurn(pending: PendingTurn): Promise<void>;
  enqueueGoalTurn(goal: RoomGoal, continuing: boolean, kick?: boolean): Promise<void>;
  drain(onDecided?: () => void): Promise<void>;
}
export interface RoomLifecycleConstructPort {
  isSummonRoom: boolean;
  summonUntrusted: boolean;
  workDir: string | undefined;
}

/** Dependencies reached by monad-room turn execution (WAL-atomic markPendingTurn →
 * engine.run → commitTurn, same shape as an agent turn). Split from room-service.ts
 * (Pascal 2026-09-03 A6g); the pendingTurn/commitTurn atomic write stays inside
 * this one method, unsplit. */
export interface RoomMonadExecutionPort {
  readonly room: RoomHandle;
  readonly roomId: string;
  readonly workspaceId: string;
  readonly workspace: Workspace;
  readonly options: RoomServiceOptions;
  emit(event: UiEvent): void;
  monadAuthor(): Promise<string[]>;
  taskCancelled(task: Task): boolean;
  settleTask(task: Task, status: "complete" | "error" | "cancelled", error?: unknown): void;
}
/** Dependencies reached by non-WAL pet/task/monad controls. */
export interface RoomTaskOperationsPort {
  readonly room: RoomHandle;
  readonly roomId: string;
  readonly workspace: Workspace;
  readonly workspaceId: string;
  readonly runtimes: Record<string, AgentRuntime>;
  readonly options: RoomServiceOptions;
  activeTask: Task | undefined;
  activeTurnUnwind: Promise<void> | undefined;
  readonly activeAgentTurn: Task | undefined;
  readonly compactingAgents: Set<string>;
  readonly compactCancels: Set<string>;
  queuedTasks: Task[];
  recentTasks: Task[];
  agentDialogueHops: number;
  init(): Promise<void>;
  emit(event: UiEvent): void;
  emitSnapshot(): Promise<void>;
  roomDefaultTarget(): Promise<string>;
  unknownAgentMessage(agentId: string): string;
  emitSystemNote(text: string): void;
  settleTask(task: Task, status: "complete" | "error" | "cancelled", error?: unknown): void;
  subscribe(listener: (event: UiEvent) => void): () => void;
}


/** Dependencies reached by room setup, maintenance, transcript inspection, and task controls. */
export interface RoomMaintenancePort {
  readonly room: RoomHandle;
  readonly roomId: string;
  readonly workspace: Workspace;
  readonly workspaceId: string;
  readonly runtimes: Record<string, AgentRuntime>;
  readonly options: RoomServiceOptions;
  recentTasks: Task[];
  readonly backgroundTasks: {
    record(agentId: string, event: Extract<AgentEvent, { type: "background-task" }>): Promise<void>;
    output(taskId: string): Promise<{ text: string; running: boolean } | undefined>;
    stop(taskId: string): Promise<boolean>;
  };
  emitSnapshot(): Promise<void>;
  init(): Promise<void>;
  eventById(eventId: string, opts?: { display?: boolean }): Promise<RoomEvent | undefined>;
  displayEvents(events: RoomEvent[]): RoomEvent[];
}
