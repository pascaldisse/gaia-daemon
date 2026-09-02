import type {
  AgentDef,
  AgentEvent,
  CompactProgress,
  CompactProgressUpdate,
  CompactResult,
  EventDetails,
  LiveTurn,
  MessageAttachment,
  ModelFallback,
  PendingTurn,
  PetProgressStatus,
  RoomGoal,
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
  recordBackgroundTask(agentId: string, event: Extract<AgentEvent, { type: "background-task" }>): Promise<void>;
  applyLiveTurn(eventId: string, event: AgentEvent): void;
  toUiEvent(taskId: string, agentId: string, eventId: string, event: AgentEvent): UiEvent | undefined;
  fireHooks(type: HookEvent, event: Record<string, unknown>): void;
  commitReply(agentId: string, eventId: string, reply: string, details: EventDetails, channel: "voice" | undefined, nextPending?: PendingTurn, renderCap?: RenderCap): Promise<void>;
  appendTurnFailure(agentId: string, error: unknown): Promise<void>;
  appendTurnStopped(agentId: string): Promise<void>;
  maybeRequeueStall(targets: string[], agentId: string, text: string, error: unknown, partialReply: string, channel: "voice" | undefined, attachments: MessageAttachment[] | undefined, options: SendMessageOptions): Promise<boolean>;
  maybeRequeueAuth(targets: string[], agentId: string, text: string, error: unknown, partialReply: string, channel: "voice" | undefined, attachments: MessageAttachment[] | undefined, options: SendMessageOptions): Promise<boolean>;
  captureEpisode(agentId: string, task: string, reply: string, outcome: EpisodeCapture["outcome"], details: EventDetails, channel: "voice" | undefined): Promise<void>;
  settlePetTarget(task: Task, target: string, status: "done" | "failed"): void;
  maybeDispatchAgentDialogue(author: string, reply: string): Promise<void>;
  maybeContinueGoal(author: string, reply: string, goalStartedAt: string): Promise<void>;
  settleTask(task: Task, status: "complete" | "error" | "cancelled", error?: unknown): void;
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
  readonly pluginsPromise: Promise<Map<string, CommandPlugin>>;
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
