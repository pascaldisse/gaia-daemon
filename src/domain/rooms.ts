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
import type { EventDetails, MessageAttachment, MonadConfig, PendingTurn, QueuedMessage, RoomEvent, RoomState, ToolDetail } from "../core/types.js";
import { appendJsonl, ensureDir, readJson, readJsonlFrom, writeJsonAtomic, writeText } from "../core/store.js";
import { workspacePaths } from "../core/paths.js";
import { newId } from "../core/ids.js";

export function newRoomEventId(): string {
  return newId("evt");
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

export function eventDetailsFrom(value: unknown): EventDetails | undefined {
  if (!isRecord(value)) return undefined;
  const tools = Array.isArray(value.tools) ? value.tools.map(toolDetail).filter((t): t is NonNullable<typeof t> => Boolean(t)) : undefined;
  const details: EventDetails = {
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    ...(value.thinkingStarted === true ? { thinkingStarted: true } : {}),
    ...(typeof value.thinking === "string" && value.thinking.length > 0 ? { thinking: value.thinking } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
  return details.model || details.thinkingStarted || details.thinking || details.tools?.length ? details : undefined;
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
      queuedAt: typeof raw.queuedAt === "string" ? raw.queuedAt : "",
    });
  }
  return queue.length > 0 ? queue : undefined;
}

export function normalizeRoomState(value: unknown): RoomState {
  if (!isRecord(value)) return { activeRoles: {}, agentCursors: {} };
  const runtimeDetails = isRecord(value.runtimeDetails)
    ? Object.fromEntries(
        Object.entries(value.runtimeDetails)
          .map(([k, v]) => [k, eventDetailsFrom(v)] as const)
          .filter((e): e is [string, EventDetails] => Boolean(e[1])),
      )
    : undefined;
  const monad = monadFrom(value.monad);
  const pendingTurn = pendingTurnFrom(value.pendingTurn);
  const queue = queueFrom(value.queue);
  return {
    activeRoles: stringRecord(value.activeRoles),
    agentCursors: cursorRecord(value.agentCursors),
    ...(runtimeDetails && Object.keys(runtimeDetails).length > 0 ? { runtimeDetails } : {}),
    ...(typeof value.parentRoomId === "string" && value.parentRoomId.trim() ? { parentRoomId: value.parentRoomId } : {}),
    ...(typeof value.title === "string" && value.title.trim() ? { title: value.title } : {}),
    ...(typeof value.imported === "string" && value.imported.trim() ? { imported: value.imported } : {}),
    ...(monad ? { monad } : {}),
    ...(pendingTurn ? { pendingTurn } : {}),
    ...(queue ? { queue } : {}),
    ...(value.thanksDario === true ? { thanksDario: true } : {}),
  };
}

// --- transcript parsing ------------------------------------------------------

function roomEventFrom(raw: unknown, index: number): RoomEvent | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.timestamp !== "string" || typeof raw.author !== "string" || typeof raw.text !== "string") return undefined;
  // Pre-id transcript lines get a deterministic line-based id.
  const id = typeof raw.id === "string" && raw.id ? raw.id : `legacy_${index}`;
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
  return { ...base, author: raw.author, ...(details ? { details } : {}) };
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

  async addUserMessage(text: string, targets: string[], channel?: string, attachments?: MessageAttachment[]): Promise<RoomEvent> {
    const event: RoomEvent = {
      id: newRoomEventId(),
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
    const rewoundPath = join(workspacePaths.roomDir(this.workspaceRoot, this.roomId), "rewound.jsonl");
    for (const event of dropped) await appendJsonl(rewoundPath, event);
    await writeText(this.transcriptPath, kept.map((event) => JSON.stringify(event)).join("\n") + (kept.length ? "\n" : ""));
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
    const redactionsPath = join(workspacePaths.roomDir(this.workspaceRoot, this.roomId), "redactions.jsonl");
    for (const event of events) {
      const text = edits.get(event.id);
      if (text === undefined || text === event.text) continue;
      await appendJsonl(redactionsPath, event);
      edited.add(event.id);
    }
    if (edited.size === 0) return [];
    const next = events.map((event) => (edited.has(event.id) ? { ...event, text: edits.get(event.id)!, redacted: true } : event));
    await writeText(this.transcriptPath, next.map((event) => JSON.stringify(event)).join("\n") + "\n");
    return [...edited];
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

  async dequeue(): Promise<QueuedMessage | undefined> {
    let head: QueuedMessage | undefined;
    await this.updateState((state) => {
      head = state.queue?.[0];
      if (state.queue && state.queue.length > 1) state.queue = state.queue.slice(1);
      else delete state.queue;
    });
    return head;
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

  async markPendingTurn(turn: PendingTurn): Promise<void> {
    await this.updateState((state) => {
      state.pendingTurn = turn;
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
   * the event), then ONE atomic state write that clears the pending marker and
   * advances the author's cursor to `cursorAfter`.
   */
  async commitTurn(event: RoomEvent, cursorAfter: number): Promise<void> {
    if (!(await this.hasEvent(event.id))) await this.appendEvent(event);
    await this.updateState((state) => {
      delete state.pendingTurn;
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
