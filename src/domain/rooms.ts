// RoomHandle — the single writer for one room's transcript.jsonl + state.json,
// and the home of the durability protocol. Nothing else in the system writes
// these files.
//
// The WAL protocol ("no progress ever lost", made true by construction):
//   1. enqueue(): a message that can't run yet is persisted in state.queue —
//      a crash re-drains it on boot. No in-memory-only queues.
//   2. markPendingTurn(): before streaming, the reply's transcript event id is
//      RESERVED and persisted with the prompt. Partial replies flush in.
//   3. commitTurn(): append the agent event (carrying the reserved id AND its
//      runtime details) to the transcript, THEN one atomic state write that
//      clears pendingTurn and advances the author's cursor.
//   4. resume: a pendingTurn on a fresh read means interruption. If its
//      eventId already exists in the transcript, the crash landed between
//      append and state write — finish the state write (finishCommit). If not,
//      re-run the turn from partialReply. Idempotent either way.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BackgroundTask, ContextGatePending, EventDetails, MessageAttachment, MessageBlock, MonadConfig, PendingTurn, QueuedMessage, RoomEvent, RoomEventKind, RoomState, SummonDelivery, ToolDetail } from "../core/types.js";
import { appendJsonl, ensureDir, readJson, readJsonlFrom, writeJsonAtomic, writeText, writeTextAtomic } from "../core/store.js";
import { workspacePaths } from "../core/paths.js";
import { newId } from "../core/ids.js";

export function newRoomEventId(): string {
  return newId("evt");
}

/** Rooms created by the "new room" UI get an opaque `chat-<slug>` id (see
 * newAutoRoomId in web/src/actions.js) and take their display title from their
 * first human message — so a room is never named by hand, the way a Claude Code
 * or Codex session titles itself from its opening prompt. This prefix is the
 * one signal that scopes that auto-title behaviour to freshly created rooms and
 * leaves existing / imported / hand-named rooms untouched. */
export const AUTO_ROOM_PREFIX = "chat-";

export function isAutoRoomId(roomId: string): boolean {
  return roomId.startsWith(AUTO_ROOM_PREFIX);
}

export type RoomTitleSource = "auto" | "model" | "manual";

export const ROOM_TITLE_MAX = 48;

/** Normalize a user/model-proposed room title: one line, no wrapping quotes or
 * terminal sentence punctuation, capped for sidebar/tab use. Empty means
 * unusable. */
export function normalizeRoomTitle(text: string): string {
  let title = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  title = title
    .replace(/^```(?:\w+)?\s*/, "")
    .replace(/```$/, "")
    .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;:,]+$/g, "")
    .trim();
  if (!title) return "";
  return title.length > ROOM_TITLE_MAX ? `${title.slice(0, ROOM_TITLE_MAX - 1).trimEnd()}…` : title;
}

/** A one-line fallback display title distilled from a room's first message:
 * strip leading @mentions, collapse whitespace, cap. Empty (→ leave the room
 * untitled) when the message carries no usable text. */
export function deriveRoomTitle(text: string): string {
  return normalizeRoomTitle(text.replace(/^(?:@[A-Za-z0-9_-]+\s+)+/, ""));
}

// --- state normalization (accepts every v1 shape) ---------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim().length > 0));
}

function cursorRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]) && e[1] >= 0)
      .map(([k, v]) => [k, Math.floor(v)]),
  );
}

/** Per-agent context accounting persisted in state.json. A malformed entry is
 * dropped (never bricks the room); an entry needs a finite usedTokens, and a
 * finite positive maxTokens is carried when present. */
function contextUsageFrom(value: unknown): Record<string, { usedTokens: number; maxTokens?: number }> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, { usedTokens: number; maxTokens?: number }> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.usedTokens !== "number" || !Number.isFinite(raw.usedTokens) || raw.usedTokens < 0) continue;
    const usedTokens = Math.floor(raw.usedTokens);
    const hasMax = typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0;
    out[id] = { usedTokens, ...(hasMax ? { maxTokens: Math.floor(raw.maxTokens as number) } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A held context-gate decision persisted in state.json. Needs an agent id and
 * message; malformed → absent (never blocks the room from opening). */
function backgroundTasksFrom(value: unknown): BackgroundTask[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tasks: BackgroundTask[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (typeof raw.taskId !== "string" || !raw.taskId.trim()) continue;
    if (typeof raw.toolName !== "string" || !raw.toolName.trim()) continue;
    if (typeof raw.agentId !== "string" || !raw.agentId.trim()) continue;
    if (typeof raw.roomId !== "string" || !raw.roomId.trim()) continue;
    if (typeof raw.startedAt !== "string" || !Number.isFinite(Date.parse(raw.startedAt))) continue;
    tasks.push({
      taskId: raw.taskId,
      toolName: raw.toolName,
      ...(typeof raw.command === "string" ? { command: raw.command } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.outputPath === "string" && raw.outputPath ? { outputPath: raw.outputPath } : {}),
      startedAt: raw.startedAt,
      agentId: raw.agentId,
      roomId: raw.roomId,
    });
  }
  const capped = tasks.slice(-20);
  return capped.length > 0 ? capped : undefined;
}

function contextGateFrom(value: unknown): ContextGatePending | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.agentId !== "string" || !value.agentId.trim()) return undefined;
  if (typeof value.message !== "string") return undefined;
  const estTokens = typeof value.estTokens === "number" && value.estTokens >= 0 ? Math.floor(value.estTokens) : 0;
  const totalEvents = typeof value.totalEvents === "number" && value.totalEvents >= 0 ? Math.floor(value.totalEvents) : 0;
  const window = typeof value.window === "number" && value.window > 0 ? Math.floor(value.window) : undefined;
  const attachments = attachmentsFrom(value.attachments);
  const reason = value.reason === "session-lost" || value.reason === "new-agent" ? value.reason : undefined;
  const at = typeof value.at === "string" ? value.at : "";
  return {
    agentId: value.agentId,
    message: value.message,
    estTokens,
    totalEvents,
    ...(window ? { window } : {}),
    ...(attachments ? { attachments } : {}),
    ...(reason ? { reason } : {}),
    at,
  };
}

function toolDetail(value: unknown): ToolDetail | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.toolName !== "string") return undefined;
  const status = value.status === "running" || value.status === "error" ? value.status : "complete";
  return {
    id: value.id,
    toolName: value.toolName,
    status,
    ...(value.args !== undefined ? { args: value.args } : {}),
    ...(value.partialResult !== undefined ? { partialResult: value.partialResult } : {}),
    ...(value.result !== undefined ? { result: value.result } : {}),
  };
}

function messageBlocks(value: unknown): MessageBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks: MessageBlock[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (raw.kind === "tool" || raw.kind === "steer") {
      if (typeof raw.id === "string" && raw.id.length > 0) blocks.push({ kind: raw.kind, id: raw.id });
    } else if (raw.kind === "text" || raw.kind === "thinking") {
      // Drop empty text/thinking spans — they carry nothing to render and only
      // arise transiently while streaming.
      if (typeof raw.text === "string" && raw.text.length > 0) blocks.push({ kind: raw.kind, text: raw.text });
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

export function eventDetailsFrom(value: unknown): EventDetails | undefined {
  if (!isRecord(value)) return undefined;
  const tools = Array.isArray(value.tools) ? value.tools.map(toolDetail).filter((t): t is NonNullable<typeof t> => Boolean(t)) : undefined;
  const blocks = messageBlocks(value.blocks);
  const summonResult = summonResultFrom(value.summonResult);
  const details: EventDetails = {
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    ...(value.thinkingStarted === true ? { thinkingStarted: true } : {}),
    ...(typeof value.thinking === "string" && value.thinking.length > 0 ? { thinking: value.thinking } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(blocks ? { blocks } : {}),
    ...(summonResult ? { summonResult } : {}),
  };
  return details.model || details.thinkingStarted || details.thinking || details.tools?.length || details.blocks?.length || details.summonResult
    ? details
    : undefined;
}

/** A summon worker's result provenance, reconstructed from disk (see
 * SummonResultMeta). Requires a childRoomId; failed defaults to false. */
function summonResultFrom(value: unknown): EventDetails["summonResult"] {
  if (!isRecord(value) || typeof value.childRoomId !== "string" || !value.childRoomId) return undefined;
  return { childRoomId: value.childRoomId, failed: value.failed === true };
}

function attachmentsFrom(value: unknown): MessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments: MessageAttachment[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.path !== "string" || !raw.path.trim()) continue;
    attachments.push({
      name: raw.name,
      mime: typeof raw.mime === "string" && raw.mime ? raw.mime : "application/octet-stream",
      size: typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size >= 0 ? Math.floor(raw.size) : 0,
      path: raw.path,
    });
  }
  return attachments.length > 0 ? attachments : undefined;
}

// A bad persisted block must never brick a room — it degrades to absent.
function monadFrom(value: unknown): MonadConfig | undefined {
  if (!isRecord(value) || typeof value.policy !== "string" || !value.policy.trim() || !Array.isArray(value.slots)) return undefined;
  const slots = [] as MonadConfig["slots"];
  for (const raw of value.slots) {
    if (!isRecord(raw) || typeof raw.agentId !== "string" || !raw.agentId.trim()) continue;
    slots.push({
      index: typeof raw.index === "number" && Number.isFinite(raw.index) ? Math.floor(raw.index) : slots.length,
      agentId: raw.agentId,
      ...(typeof raw.label === "string" && raw.label.trim() ? { label: raw.label } : {}),
      ...(typeof raw.defaultRole === "string" && raw.defaultRole.trim() ? { defaultRole: raw.defaultRole } : {}),
    });
  }
  if (slots.length === 0) return undefined;
  const terminate =
    isRecord(value.terminate) && value.terminate.on === "verifier-accept" && typeof value.terminate.acceptToken === "string"
      ? { on: "verifier-accept" as const, acceptToken: value.terminate.acceptToken }
      : undefined;
  const rolePrompts = isRecord(value.rolePrompts)
    ? Object.fromEntries(Object.entries(value.rolePrompts).filter((e): e is [string, string] => typeof e[1] === "string"))
    : undefined;
  return {
    policy: value.policy,
    ...(value.policyConfig !== undefined ? { policyConfig: value.policyConfig } : {}),
    slots,
    roles: Array.isArray(value.roles) ? value.roles.filter((r): r is string => typeof r === "string" && r.trim().length > 0) : [],
    maxTurns: typeof value.maxTurns === "number" && Number.isFinite(value.maxTurns) && value.maxTurns > 0 ? Math.floor(value.maxTurns) : 5,
    ...(typeof value.coordinatorAgentId === "string" && value.coordinatorAgentId.trim() ? { coordinatorAgentId: value.coordinatorAgentId } : {}),
    ...(terminate ? { terminate } : {}),
    ...(rolePrompts && Object.keys(rolePrompts).length > 0 ? { rolePrompts } : {}),
  };
}

function pendingTurnFrom(value: unknown): PendingTurn | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.prompt !== "string" || typeof value.agentId !== "string") return undefined;
  const targets = Array.isArray(value.targets) ? value.targets.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [];
  if (targets.length === 0) return undefined;
  const attachments = attachmentsFrom(value.attachments);
  return {
    id: value.id,
    ...(typeof value.eventId === "string" && value.eventId ? { eventId: value.eventId } : {}),
    prompt: value.prompt,
    ...(attachments ? { attachments } : {}),
    targets,
    agentId: value.agentId,
    partialReply: typeof value.partialReply === "string" ? value.partialReply : "",
    ...(value.channel === "voice" ? { channel: "voice" as const } : {}),
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
  };
}

function queueFrom(value: unknown): QueuedMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const queue: QueuedMessage[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.taskId !== "string" || typeof raw.text !== "string") continue;
    const targets = Array.isArray(raw.targets) ? raw.targets.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [];
    const attachments = attachmentsFrom(raw.attachments);
    queue.push({
      taskId: raw.taskId,
      text: raw.text,
      targets,
      ...(raw.channel === "voice" ? { channel: "voice" as const } : {}),
      ...(attachments ? { attachments } : {}),
      ...(raw.fromAgentDialogue === true ? { fromAgentDialogue: true } : {}),
      ...(raw.nativeCommand === true ? { nativeCommand: true } : {}),
      ...(raw.stallRetried === true ? { stallRetried: true } : {}),
      ...(typeof raw.authRetries === "number" ? { authRetries: raw.authRetries } : {}),
      ...(typeof raw.notBefore === "string" ? { notBefore: raw.notBefore } : {}),
      queuedAt: typeof raw.queuedAt === "string" ? raw.queuedAt : "",
    });
  }
  return queue.length > 0 ? queue : undefined;
}

/** A summon child room's pending result delivery (see SummonDelivery). A
 * malformed record is dropped — the room still opens; only the callback is
 * forfeited (and the coordinator logs recovery misses loudly). */
function summonDeliveryFrom(value: unknown): SummonDelivery | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.agentId !== "string" || !value.agentId.trim()) return undefined;
  const deliver = value.deliver === "turn" ? "turn" : value.deliver === "note" ? "note" : undefined;
  if (!deliver) return undefined;
  return {
    agentId: value.agentId,
    deliver,
    ...(typeof value.callerAgentId === "string" && value.callerAgentId.trim() ? { callerAgentId: value.callerAgentId } : {}),
    status: value.status === "delivered" ? "delivered" : "running",
    launchedAt: typeof value.launchedAt === "string" ? value.launchedAt : new Date().toISOString(),
  };
}

export function normalizeRoomState(value: unknown): RoomState {
  if (!isRecord(value)) return { activeRoles: {}, agentCursors: {}, thinkingOverrides: {} };
  const runtimeDetails = isRecord(value.runtimeDetails)
    ? Object.fromEntries(
        Object.entries(value.runtimeDetails)
          .map(([k, v]) => [k, eventDetailsFrom(v)] as const)
          .filter((e): e is [string, EventDetails] => Boolean(e[1])),
      )
    : undefined;
  const monad = monadFrom(value.monad);
  const summon = summonDeliveryFrom(value.summon);
  const pendingTurn = pendingTurnFrom(value.pendingTurn);
  const queue = queueFrom(value.queue);
  const contextUsage = contextUsageFrom(value.contextUsage);
  const backgroundTasks = backgroundTasksFrom(value.backgroundTasks);
  const contextGate = contextGateFrom(value.contextGate);
  const contextFloors = cursorRecord(value.contextFloors);
  return {
    activeRoles: stringRecord(value.activeRoles),
    thinkingOverrides: stringRecord(value.thinkingOverrides),
    agentCursors: cursorRecord(value.agentCursors),
    ...(Object.keys(contextFloors).length > 0 ? { contextFloors } : {}),
    ...(runtimeDetails && Object.keys(runtimeDetails).length > 0 ? { runtimeDetails } : {}),
    ...(typeof value.parentRoomId === "string" && value.parentRoomId.trim() ? { parentRoomId: value.parentRoomId } : {}),
    ...(summon ? { summon } : {}),
    ...(value.summonUntrusted === true ? { summonUntrusted: true } : {}),
    ...(typeof value.workDir === "string" && value.workDir.trim() ? { workDir: value.workDir } : {}),
    ...(typeof value.title === "string" && value.title.trim() ? { title: value.title } : {}),
    ...(value.titleSource === "auto" || value.titleSource === "model" || value.titleSource === "manual" ? { titleSource: value.titleSource } : {}),
    ...(value.favorite === true ? { favorite: true } : {}),
    ...(typeof value.imported === "string" && value.imported.trim() ? { imported: value.imported } : {}),
    ...(monad ? { monad } : {}),
    ...(pendingTurn ? { pendingTurn } : {}),
    ...(queue ? { queue } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(backgroundTasks ? { backgroundTasks } : {}),
    ...(contextGate ? { contextGate } : {}),
    ...(value.thanksDario === true ? { thanksDario: true } : {}),
    ...(typeof value.activeAgent === "string" && value.activeAgent.trim() ? { activeAgent: value.activeAgent } : {}),
    ...(value.agentDialogue === true ? { agentDialogue: true } : {}),
    ...(value.incognito === true ? { incognito: true } : {}),
  };
}

// --- transcript parsing ------------------------------------------------------

function roomEventFrom(raw: unknown, index: number): RoomEvent | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.timestamp !== "string" || typeof raw.author !== "string" || typeof raw.text !== "string") return undefined;
  // Pre-id transcript lines get a deterministic line-based id.
  const id = typeof raw.id === "string" && raw.id ? raw.id : `legacy_${index}`;
  const kind: RoomEventKind | undefined = raw.kind === "compact-complete" ? "compact-complete" : undefined;
  const base = {
    id,
    timestamp: raw.timestamp,
    text: raw.text,
    ...(typeof raw.channel === "string" && raw.channel ? { channel: raw.channel } : {}),
    ...(raw.redacted === true ? { redacted: true } : {}),
  };
  if (raw.author === "user") {
    const targets = Array.isArray(raw.targets) ? raw.targets.filter((t): t is string => typeof t === "string") : [];
    const attachments = attachmentsFrom(raw.attachments);
    return { ...base, author: "user", targets, ...(attachments ? { attachments } : {}) };
  }
  const details = eventDetailsFrom(raw.details);
  return { ...base, author: raw.author, ...(kind ? { kind } : {}), ...(details ? { details } : {}) };
}

// --- the handle --------------------------------------------------------------

export interface RoomPage {
  events: RoomEvent[];
  nextCursor: number;
}

export class RoomHandle {
  /** Serializes every state write; the single-writer rule enforced in code
   * instead of by discipline. */
  private chain: Promise<unknown> = Promise.resolve();
  private stateCache: RoomState | undefined;

  private constructor(
    readonly workspaceRoot: string,
    readonly roomId: string,
  ) {}

  static async open(workspaceRoot: string, roomId: string): Promise<RoomHandle> {
    const handle = new RoomHandle(workspaceRoot, roomId);
    await ensureDir(workspacePaths.roomDir(workspaceRoot, roomId));
    if (!existsSync(handle.statePath)) await writeJsonAtomic(handle.statePath, normalizeRoomState(undefined));
    return handle;
  }

  get transcriptPath(): string {
    return workspacePaths.transcript(this.workspaceRoot, this.roomId);
  }

  get statePath(): string {
    return workspacePaths.roomState(this.workspaceRoot, this.roomId);
  }

  async state(): Promise<RoomState> {
    if (!this.stateCache) this.stateCache = normalizeRoomState(await readJson(this.statePath));
    return this.stateCache;
  }

  /** Apply `mutate` to the current state and persist atomically. All writes
   * funnel through here, serialized. */
  async updateState(mutate: (state: RoomState) => void): Promise<RoomState> {
    const run = async (): Promise<RoomState> => {
      const state = await this.state();
      mutate(state);
      await writeJsonAtomic(this.statePath, state);
      return state;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Drop the in-memory cache so the next read hits disk (used by tests and
   * by anything that must observe a foreign write — there should be none). */
  invalidate(): void {
    this.stateCache = undefined;
  }

  // --- transcript ------------------------------------------------------------

  async appendEvent(event: RoomEvent): Promise<void> {
    await appendJsonl(this.transcriptPath, event);
  }

  /** `id` pre-assigns the event id — the queue→transcript hand-off reserves it
   * durably on the QueuedMessage first, so a crash-replayed append is
   * idempotent (see QueuedMessage.eventId). */
  async addUserMessage(text: string, targets: string[], channel?: string, attachments?: MessageAttachment[], id?: string): Promise<RoomEvent> {
    const event: RoomEvent = {
      id: id ?? newRoomEventId(),
      timestamp: new Date().toISOString(),
      author: "user",
      targets,
      text,
      ...(channel ? { channel } : {}),
      ...(attachments?.length ? { attachments } : {}),
    };
    await this.appendEvent(event);
    return event;
  }

  /** Wipe the transcript (backs /clear). State is the caller's to reset. */
  async clearTranscript(): Promise<void> {
    await writeText(this.transcriptPath, "");
  }

  /** Rewind: drop the last `userTurns` user messages and every event after
   * them (backs /rewind — the room-level checkpoint that works for every
   * harness). Returns the dropped events, or undefined when the room has
   * fewer user messages. Cursors/sessions are the caller's to reset; the
   * per-room recall index rebuilds itself on shrink. */
  async rewindTranscript(userTurns: number): Promise<RoomEvent[] | undefined> {
    const { events } = await this.eventsFrom(0);
    let cut = -1;
    let seen = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].author !== "user") continue;
      seen++;
      if (seen >= userTurns) {
        cut = i;
        break;
      }
    }
    if (cut < 0) return undefined;
    return this.truncateAt(events, cut);
  }

  /** Rewind to a specific event: drop it and everything after (backs message
   * edit and reply retry — the fork-from-here primitive). Returns the dropped
   * events, or undefined when the id is not in the transcript. */
  async rewindToEvent(eventId: string): Promise<RoomEvent[] | undefined> {
    const { events } = await this.eventsFrom(0);
    const cut = events.findIndex((event) => event.id === eventId);
    if (cut < 0) return undefined;
    return this.truncateAt(events, cut);
  }

  /** All transcript truncation funnels through here. Dropped events are
   * preserved append-only in rewound.jsonl beside the transcript — a rewind
   * discards them from the conversation, never from disk. */
  private async truncateAt(events: RoomEvent[], cut: number): Promise<RoomEvent[]> {
    const kept = events.slice(0, cut);
    const dropped = events.slice(cut);
    const rewoundPath = workspacePaths.roomRewound(this.workspaceRoot, this.roomId);
    for (const event of dropped) await appendJsonl(rewoundPath, event);
    // Atomic: the kept head has no other copy — a torn rewrite would be
    // permanent loss of committed history.
    await writeTextAtomic(this.transcriptPath, kept.map((event) => JSON.stringify(event)).join("\n") + (kept.length ? "\n" : ""));
    return dropped;
  }

  /** Rewrite the text of specific events in place (backs the thanks-dario
   * context sanitize). Each edited event's ORIGINAL line is appended to
   * redactions.jsonl beside the transcript BEFORE the rewrite — a redaction
   * changes what replays into prompts, never what exists on disk. The line
   * count is unchanged, so every existing cursor stays valid. Returns the
   * ids actually edited (unknown ids and no-op texts are ignored). */
  async redactEvents(edits: Map<string, string>): Promise<string[]> {
    const { events } = await this.eventsFrom(0);
    const edited = new Set<string>();
    const redactionsPath = workspacePaths.roomRedactions(this.workspaceRoot, this.roomId);
    for (const event of events) {
      const text = edits.get(event.id);
      if (text === undefined || text === event.text) continue;
      await appendJsonl(redactionsPath, event);
      edited.add(event.id);
    }
    if (edited.size === 0) return [];
    const next = events.map((event) => (edited.has(event.id) ? { ...event, text: edits.get(event.id)!, redacted: true } : event));
    // Atomic: every unedited event exists only on this line — a torn rewrite
    // would destroy committed history far beyond the redaction.
    await writeTextAtomic(this.transcriptPath, next.map((event) => JSON.stringify(event)).join("\n") + "\n");
    return [...edited];
  }

  // --- durable compaction summaries -------------------------------------------
  // Keyed by agentId → { floorIdx, summary }: the harness's own summary of the
  // history below the agent's context floor. On a session-loss replay the daemon
  // feeds [summary + tail after floorIdx] instead of raw-from-0 or a thin tail,
  // so an explicit /compact survives every reset. Valid only while floorIdx still
  // equals the live floor (a moved floor auto-invalidates it). compaction.json
  // lives beside the transcript — derived state, never part of the WAL.

  private compactionPath(): string {
    return workspacePaths.roomCompaction(this.workspaceRoot, this.roomId);
  }

  private async readCompactionMap(): Promise<Record<string, { floorIdx: number; summary: string }>> {
    return ((await readJson(this.compactionPath())) as Record<string, { floorIdx: number; summary: string }> | undefined) ?? {};
  }

  /** The stored summary for an agent, or undefined if none. Callers must still
   * check floorIdx against the live floor before trusting it. */
  async readCompaction(agentId: string): Promise<{ floorIdx: number; summary: string } | undefined> {
    const entry = (await this.readCompactionMap())[agentId];
    return entry && typeof entry.summary === "string" && typeof entry.floorIdx === "number" ? entry : undefined;
  }

  async writeCompaction(agentId: string, floorIdx: number, summary: string): Promise<void> {
    const all = await this.readCompactionMap();
    all[agentId] = { floorIdx, summary };
    await writeJsonAtomic(this.compactionPath(), all);
  }

  async clearCompaction(agentId: string): Promise<void> {
    const all = await this.readCompactionMap();
    if (!(agentId in all)) return;
    delete all[agentId];
    await writeJsonAtomic(this.compactionPath(), all);
  }

  async eventsFrom(cursor: number): Promise<RoomPage> {
    const page = await readJsonlFrom<RoomEvent>(this.transcriptPath, cursor, roomEventFrom);
    // Merge legacy v1 side-table details onto agent events that lack them.
    const state = await this.state();
    const legacy = state.runtimeDetails;
    const events = legacy
      ? page.items.map((event) => {
          // The union is not discriminated by author (agent authors are plain
          // strings), so narrow via the property instead.
          if (event.author === "user" || ("details" in event && event.details)) return event;
          const details = legacy[event.id];
          return details ? { ...event, details } : event;
        })
      : page.items;
    return { events, nextCursor: page.nextCursor };
  }

  async recentEvents(limit: number): Promise<RoomEvent[]> {
    const { events } = await this.eventsFrom(0);
    return events.slice(-limit);
  }

  async hasEvent(eventId: string): Promise<boolean> {
    const { events } = await this.eventsFrom(0);
    return events.some((event) => event.id === eventId);
  }

  // --- durable queue -----------------------------------------------------------

  async enqueue(message: QueuedMessage): Promise<void> {
    await this.updateState((state) => {
      state.queue = [...(state.queue ?? []), message];
    });
  }

  /** The head of the durable queue WITHOUT removing it. The entry stays queued
   * until a successor durable record exists (the appended user event / the
   * pendingTurn marker / a command's persisted reply) and the caller then
   * consumes it via spliceQueued or markPendingTurn's consume option — the
   * two-phase hand-off that makes a crash re-drain instead of losing the
   * message (the old dequeue-first held it in memory only). */
  async peekQueue(): Promise<QueuedMessage | undefined> {
    return (await this.state()).queue?.[0];
  }

  /** Durably reserve the transcript event id a queued message will commit
   * under, BEFORE the append — so a crash between the two replays the append
   * idempotently (same id, hasEvent-guarded). No-op if the entry is gone. */
  async assignQueuedEventId(taskId: string, eventId: string): Promise<void> {
    await this.updateState((state) => {
      const entry = state.queue?.find((candidate) => candidate.taskId === taskId);
      if (entry) entry.eventId = eventId;
    });
  }

  /** Remove one entry by task id — idempotent (a multi-target turn consumes it
   * once per markPendingTurn; only the first splice finds it). */
  async spliceQueued(taskId: string): Promise<void> {
    await this.updateState((state) => {
      if (!state.queue) return;
      const next = state.queue.filter((candidate) => candidate.taskId !== taskId);
      if (next.length > 0) state.queue = next;
      else delete state.queue;
    });
  }

  async clearQueue(): Promise<QueuedMessage[]> {
    let dropped: QueuedMessage[] = [];
    await this.updateState((state) => {
      dropped = state.queue ?? [];
      delete state.queue;
    });
    return dropped;
  }

  // --- WAL turn protocol ---------------------------------------------------------

  /** `consumeQueuedTaskId` removes that queue entry in the SAME atomic state
   * write that creates the marker — the queued message's durable custody moves
   * from queue to WAL with no window where it exists in neither. */
  async markPendingTurn(turn: PendingTurn, options?: { consumeQueuedTaskId?: string }): Promise<void> {
    await this.updateState((state) => {
      state.pendingTurn = turn;
      if (options?.consumeQueuedTaskId && state.queue) {
        const next = state.queue.filter((candidate) => candidate.taskId !== options.consumeQueuedTaskId);
        if (next.length > 0) state.queue = next;
        else delete state.queue;
      }
    });
  }

  async flushPartialReply(partialReply: string): Promise<void> {
    await this.updateState((state) => {
      if (state.pendingTurn) state.pendingTurn.partialReply = partialReply;
    });
  }

  async clearPendingTurn(): Promise<void> {
    await this.updateState((state) => {
      delete state.pendingTurn;
    });
  }

  /**
   * Commit a finished turn: append the reply event (reserved id + details on
   * the event), then ONE atomic state write that clears the pending marker
   * (or swaps in `nextPending` — the multi-target hand-off, so the remaining
   * targets' owed turns never live in memory only) and advances the author's
   * cursor.
   *
   * The cursor is computed HERE, from the reply's own line: everything up to
   * and including the reply is in the author's harness session — including
   * events that landed DURING the turn (inline steers, summon notes: all
   * delivered into the live turn) — while anything appended after the reply
   * was never seen live and stays unswept. The caller-supplied pre-stream
   * `count + 1` this replaces undercounted whenever a steer landed mid-turn,
   * replaying the agent's own reply (and any later steer) as fresh context.
   */
  async commitTurn(event: RoomEvent, nextPending?: PendingTurn): Promise<void> {
    if (!(await this.hasEvent(event.id))) await this.appendEvent(event);
    // Line offsets, not parsed-array indexes: unparseable lines are skipped
    // from items but still count toward the cursor space.
    const page = await readJsonlFrom<number>(this.transcriptPath, 0, (raw, lineIndex) =>
      raw && typeof raw === "object" && (raw as { id?: unknown }).id === event.id ? lineIndex : undefined,
    );
    const cursorAfter = page.items.length > 0 ? page.items[page.items.length - 1] + 1 : page.nextCursor;
    await this.updateState((state) => {
      if (nextPending) state.pendingTurn = nextPending;
      else delete state.pendingTurn;
      state.agentCursors[event.author] = cursorAfter;
    });
  }

  /**
   * Resume decision for a pendingTurn found on boot:
   * - "finish-commit": the reply already reached the transcript; only the
   *   state write is missing. Caller finishes with commitTurn (idempotent).
   * - "rerun": stream the turn again from pendingTurn.partialReply.
   */
  async resumeMode(pending: PendingTurn): Promise<"finish-commit" | "rerun"> {
    if (pending.eventId && (await this.hasEvent(pending.eventId))) return "finish-commit";
    return "rerun";
  }
}
