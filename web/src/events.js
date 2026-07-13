// SSE consumption. v2 streaming deltas carry `eventId` — the transcript event
// id the reply will commit under — so runtime details are keyed directly by
// event id in state.streams. No author+text snapshot-merge heuristic exists:
// the final room-event with the same id simply replaces the stream entry.
import { api } from "./api.js";
import { refreshAttention } from "./attention.js";
import { openEventChannel } from "./eventchannel.js";
import { maybeAutoDario, syncDarioFromSnapshot } from "./dario.js";
import { forwardNativePetProgress, syncNativePets } from "./pet.js";
import { markDirty, setError } from "./render.js";
import { state, syncReadMarks } from "./state.js";
import { isStallNotice, syncOlderFromSnapshot } from "./transcript.js";
import { applyVoiceStatus, voiceTurnCommitted } from "./voice.js";

/** @typedef {import("./types.js").UiEvent} UiEvent */
/** @typedef {import("./types.js").StreamEntry} StreamEntry */
/** @typedef {import("./types.js").ToolDetail} ToolDetail */
/** @typedef {import("./types.js").EventDetails} EventDetails */
/** @typedef {import("./types.js").Snapshot} Snapshot */
/**
 * @template {UiEvent["type"]} T
 * @typedef {import("./types.js").Ev<T>} Ev
 */

/** @type {string | undefined} */
let knownBootId;
let lastEventAt = Date.now();
let lastWatchdogReconnectAt = 0;
let connectionStale = false;
/** @type {number | undefined} */
let heartbeatTimer;
/** @type {number | undefined} */
let livenessWatchdog;

/**
 * Open the room event channel. A watchdog-triggered replacement asks the
 * ready handler to reseed from a fresh snapshot, because its missed events
 * cannot be replayed.
 * @param {boolean} [resyncOnReady]
 */
export function connectEvents(resyncOnReady = false) {
  const snapshot = state.snapshot;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  if (!snapshot) return;
  syncLiveTimers();

  const params = new URLSearchParams({ workspaceId: snapshot.workspace.id, roomId: snapshot.room.id });
  const source = openEventChannel(`/api/events?${params}`);
  state.eventSource = source;

  /** @param {string} type @param {(event: { data: string }) => void} handler */
  const listen = (type, handler) =>
    source.addEventListener(type, (event) => {
      lastEventAt = Date.now();
      if (connectionStale) {
        connectionStale = false;
        state.eventConnectionStale = false;
        markDirty("transcript");
      }
      handler(event);
    });

  // The server greets every (re)connection with "ready". EventSource
  // reconnects on its own after a drop, but events broadcast while we were
  // gone are lost — so a ready that isn't the first one resyncs with a
  // fresh snapshot.
  let connectedBefore = false;
  listen("ready", (event) => {
    const payload = JSON.parse(event.data);
    const bootId = payload && typeof payload === "object" && typeof payload.bootId === "string" ? payload.bootId : undefined;
    if (bootId) {
      if (knownBootId && knownBootId !== bootId) {
        window.location.reload();
        return;
      }
      knownBootId = bootId;
    }
    if (connectedBefore || resyncOnReady) void resyncSnapshot(snapshot.workspace.id);
    connectedBefore = true;
  });

  // Named server keepalive: EventSource does not expose comment-only pings.
  listen("ping", () => {});

  listen("snapshot", (event) => {
    const payload = /** @type {Ev<"snapshot">} */ (JSON.parse(event.data));
    void (async () => {
      await adoptSnapshotKeepingRoom(payload.snapshot);
      syncDarioFromSnapshot();
    })();
  });

  // A room somewhere started/finished a turn or advanced its activity. The
  // daemon broadcasts this for EVERY workspace (not just the open one), so cache
  // it per workspace to keep the sidebar's workspace-level running/unread dots
  // live even for workspaces we're not viewing. When it's the open workspace,
  // also refresh the room list that drives the rooms tree + tab strip.
  listen("rooms", (event) => {
    const payload = /** @type {Ev<"rooms">} */ (JSON.parse(event.data));
    state.workspaceRooms[payload.workspaceId] = payload.rooms;
    if (state.snapshot && state.snapshot.workspace.id === payload.workspaceId) {
      // `isCurrent` in the payload is relative to the EMITTING room's service,
      // not this client's open room — recompute it against the room we're viewing.
      const currentId = state.snapshot.room.id;
      state.snapshot.rooms = payload.rooms.map((room) => ({ ...room, isCurrent: room.id === currentId }));
    }
    syncReadMarks();
    refreshAttention();
    // "composer" too: the running banner counts THIS room's live summons from
    // snapshot.rooms — without it the banner kept showing dead summons until
    // some unrelated event happened to repaint the composer.
    markDirty("sidebar", "tabs", "composer");
  });

  // Native pet events are globally delivered by the daemon, independent of
  // this tab's selected room. The shell receives the complete workspace binding
  // snapshot plus every room+agent progress event; browsers/iOS render nothing.
  listen("pet-bindings", (event) => {
    const payload = /** @type {Ev<"pet-bindings">} */ (JSON.parse(event.data));
    void syncNativePets(payload.workspaceId, payload.bindings);
  });

  listen("pet-progress", (event) => {
    const payload = /** @type {Ev<"pet-progress">} */ (JSON.parse(event.data));
    void forwardNativePetProgress(payload);
  });

  listen("room-event", (event) => {
    const payload = /** @type {Ev<"room-event">} */ (JSON.parse(event.data));
    if (!state.snapshot) return;
    // The commit carries its runtime details on the event itself; the stream
    // entry for the same id (if any) is now redundant.
    state.streams.delete(payload.event.id);
    syncLiveTimers();
    const events = state.snapshot.room.events;
    const index = events.findIndex((candidate) => candidate.id === payload.event.id);
    if (index === -1) events.push(payload.event);
    else events[index] = payload.event;
    // Stall notices never render in the transcript (messageViews filters them);
    // surface live ones through the app's existing dismissible error banner AND
    // paint the running turn's own bubble as "reconnecting", so a frozen-looking
    // stream reads as a retry-in-progress instead of a dead turn.
    if (isStallNotice(payload.event)) {
      setError(payload.event.text);
      markStreamsStalled(payload.event.text);
    }
    if (payload.event.author === "user" && payload.event.channel === "voice") voiceTurnCommitted();
    maybeAutoDario(payload.event);
    markDirty("transcript", "panel", "status", "tabs", "sidebar");
  });

  listen("voice-status", (event) => {
    applyVoiceStatus(/** @type {Ev<"voice-status">} */ (JSON.parse(event.data)));
  });

  listen("model-info", (event) => {
    const payload = /** @type {Ev<"model-info">} */ (JSON.parse(event.data));
    // Keep the composer's model chip live: the label the snapshot carried may
    // predate this turn's actual model (e.g. a fallback mid-turn).
    const agent = (state.snapshot?.agents ?? []).find((candidate) => candidate.id === payload.agentId);
    if (agent) {
      agent.modelLabel = `${payload.provider}/${payload.modelId}${payload.subscription ? " (oauth)" : ""}`;
      markDirty("composer");
    }
    const stream = streamFor(payload);
    if (!stream) return;
    stream.details.model = `${payload.provider}/${payload.modelId}${payload.subscription ? " (oauth)" : ""}`;
    stream.version += 1;
    markDirty("transcript");
  });

  listen("context-usage", (event) => {
    const payload = /** @type {Ev<"context-usage">} */ (JSON.parse(event.data));
    const agent = (state.snapshot?.agents ?? []).find((candidate) => candidate.id === payload.agentId);
    if (!agent) return;
    // Mid-turn events carry only usedTokens; the window rides the turn-end event.
    // Keep the last-known maxTokens so the ctx % chip stays live during the turn.
    const maxTokens = payload.maxTokens ?? agent.context?.maxTokens;
    agent.context = { usedTokens: payload.usedTokens, ...(maxTokens ? { maxTokens } : {}) };
    markDirty("composer");
  });

  // Daemon-global: one subscription account's usage limits refreshed (or
  // cleared). Not tied to the open room, so it's applied regardless of workspace.
  listen("usage-limits", (event) => {
    const payload = /** @type {Ev<"usage-limits">} */ (JSON.parse(event.data));
    if (payload.usage) state.usage[payload.account] = payload.usage;
    else delete state.usage[payload.account];
    markDirty("status", "usage");
  });

  listen("model-fallback", (event) => {
    const payload = /** @type {Ev<"model-fallback">} */ (JSON.parse(event.data));
    const fallback = { from: payload.fromModel, to: payload.toModel, reason: payload.reason };
    const agent = (state.snapshot?.agents ?? []).find((candidate) => candidate.id === payload.agentId);
    if (agent) {
      agent.modelFallback = fallback;
      markDirty("composer");
    }
    const stream = streamFor(payload);
    if (!stream) return;
    stream.details.modelFallback = fallback;
    stream.version += 1;
    markDirty("transcript");
  });

  listen("text-delta", (event) => {
    const payload = /** @type {Ev<"text-delta">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    stream.text += payload.delta;
    appendSpanBlock(stream.details, "text", payload.delta);
    stream.version += 1;
    markDirty("transcript");
  });

  listen("thinking-start", (event) => {
    const payload = /** @type {Ev<"thinking-start">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    stream.details.thinkingStarted = true;
    stream.version += 1;
    markDirty("transcript");
  });

  listen("thinking-delta", (event) => {
    const payload = /** @type {Ev<"thinking-delta">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    stream.details.thinkingStarted = true;
    stream.details.thinking = `${stream.details.thinking ?? ""}${payload.delta}`;
    appendSpanBlock(stream.details, "thinking", payload.delta);
    stream.version += 1;
    markDirty("transcript");
  });

  listen("thinking-end", (event) => {
    const payload = /** @type {Ev<"thinking-end">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    stream.details.thinkingStarted = true;
    if (payload.content && !stream.details.thinking) stream.details.thinking = payload.content;
    if (payload.content) fillThinkingBlock(stream.details, payload.content);
    stream.version += 1;
    markDirty("transcript");
  });

  listen("tool-start", (event) => {
    const payload = /** @type {Ev<"tool-start">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    const tool = toolDetail(payload, "running");
    stream.details.tools = [...(stream.details.tools ?? []), tool];
    pushRefBlock(stream.details, "tool", tool.id);
    stream.version += 1;
    markDirty("transcript");
  });

  listen("tool-update", (event) => {
    const payload = /** @type {Ev<"tool-update">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    const tool = findTool(stream, payload.toolCallId, payload.toolName);
    if (tool) tool.partialResult = payload.partialResult;
    stream.version += 1;
    markDirty("transcript");
  });

  listen("tool-end", (event) => {
    const payload = /** @type {Ev<"tool-end">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    const tool = findTool(stream, payload.toolCallId, payload.toolName);
    if (tool) {
      tool.status = payload.isError ? "error" : "complete";
      tool.result = payload.result;
    } else {
      const created = toolDetail(payload, payload.isError ? "error" : "complete");
      stream.details.tools = [...(stream.details.tools ?? []), created];
      pushRefBlock(stream.details, "tool", created.id);
    }
    stream.version += 1;
    markDirty("transcript");
  });

  listen("steered", (event) => {
    const payload = /** @type {Ev<"steered">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    pushRefBlock(stream.details, "steer", payload.steerEventId);
    stream.version += 1;
    markDirty("transcript");
  });

  listen("task-start", (event) => {
    const payload = /** @type {Ev<"task-start">} */ (JSON.parse(event.data));
    upsertTask(payload.task);
    markDirty("panel", "status", "composer", "tabs", "sidebar");
  });

  listen("task-end", (event) => {
    const payload = /** @type {Ev<"task-end">} */ (JSON.parse(event.data));
    upsertTask(payload.task);
    markDirty("panel", "status", "composer", "tabs", "sidebar");
    // Defense in depth: the turn's own final "room-event" (or a "steered"
    // fold-in delta it depended on) can be lost on an open-but-lossy
    // transport without the socket ever closing — the reconnect-triggered
    // resync in the "ready" handler never fires then. task-end is a separate,
    // independently-delivered broadcast: if it says the task is done but a
    // stream for that task is still sitting uncommitted, the client missed a
    // frame. Resync once instead of leaving a permanently fossilized
    // streaming bubble / unsuppressed steer.
    if (state.snapshot) {
      const committed = new Set(state.snapshot.room.events.map((e) => e.id));
      const orphaned = [...state.streams.values()].some(
        (stream) => stream.taskId === payload.task.id && !committed.has(stream.id),
      );
      if (orphaned) void resyncSnapshot(state.snapshot.workspace.id);
    }
  });

  listen("task-error", (event) => {
    const payload = /** @type {Ev<"task-error">} */ (JSON.parse(event.data));
    upsertTask(payload.task);
    // Drop the empty streaming placeholder the failed turn left behind;
    // partial replies stay visible (frozen) until the next snapshot.
    for (const [id, stream] of state.streams) {
      if (stream.taskId === payload.task?.id && !stream.text) state.streams.delete(id);
    }
    syncLiveTimers();
    const who = payload.task?.targets?.length ? ` (@${payload.task.targets.join(", @")})` : "";
    setError(`Turn failed${who}: ${payload.error || "unknown error"}`);
    markDirty("transcript", "panel", "composer", "tabs", "sidebar");
  });

}

/** @returns {StreamEntry[]} */
function liveStreams() {
  const tasks = state.snapshot?.tasks ?? [];
  return [...state.streams.values()].filter((stream) => {
    const task = tasks.find((candidate) => candidate.id === stream.taskId);
    // A delta can race the task list update; absent means conservatively live.
    return !task || task.status === "running";
  });
}

/** Start liveness timers only while an in-flight reply is rendered. */
function syncLiveTimers() {
  if (liveStreams().length) {
    heartbeatTimer ??= window.setInterval(() => {
      const streams = liveStreams();
      if (!streams.length) return syncLiveTimers();
      for (const stream of streams) stream.version += 1;
      markDirty("transcript");
    }, 1000);
    livenessWatchdog ??= window.setInterval(() => {
      if (!liveStreams().length || Date.now() - lastEventAt <= 45_000) return;
      // Keep the warning visible until a real event lands, and rate-limit
      // replacement attempts while the daemon itself remains unreachable.
      connectionStale = true;
      state.eventConnectionStale = true;
      markDirty("transcript");
      if (Date.now() - lastWatchdogReconnectAt < 45_000) return;
      lastWatchdogReconnectAt = Date.now();
      connectEvents(true);
    }, 10_000);
    return;
  }
  if (heartbeatTimer !== undefined) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (livenessWatchdog !== undefined) {
    window.clearInterval(livenessWatchdog);
    livenessWatchdog = undefined;
  }
}

/**
 * Missed events are unrecoverable after an SSE drop; a fresh snapshot is the
 * resync. Only applied if the user hasn't switched workspace in the meantime.
 * @param {string} workspaceId
 */
async function resyncSnapshot(workspaceId) {
  try {
    const body = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/snapshot`);
    if (state.snapshot?.workspace.id !== workspaceId) return;
    state.voice = body.voice ?? null;
    await adoptSnapshotKeepingRoom(body.snapshot);
  } catch {
    // Server unreachable again — the next successful reconnect retries.
  }
}

/**
 * Server snapshots are advisory about WHICH room is open — the client's room
 * choice is sticky and only changes by user action or room deletion.
 *
 * If a fresh snapshot points at a different room than the one currently open,
 * and that open room still exists in the fresh snapshot's room list, re-fetch
 * the open room's own snapshot (the same endpoint `selectRoom` in actions.js
 * uses) and adopt that instead, so a server-pushed or resynced snapshot never
 * yanks the user out of the room they're looking at. Falls back to the passed
 * snapshot if that re-fetch fails.
 * @param {Snapshot} snapshot
 */
async function adoptSnapshotKeepingRoom(snapshot) {
  const wantedRoomId = state.snapshot?.room?.id;
  if (wantedRoomId && snapshot.room.id !== wantedRoomId && snapshot.rooms.some((room) => room.id === wantedRoomId)) {
    try {
      const body = await api(
        `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(wantedRoomId)}/select`,
        { method: "POST", body: JSON.stringify({}) },
      );
      snapshot = body.snapshot;
    } catch {
      // Re-fetch failed — fall back to adopting the snapshot as pushed.
    }
  }
  state.snapshot = snapshot;
  pruneStreams();
  seedLiveTurn();
  syncReadMarks();
  refreshAttention();
  syncOlderFromSnapshot();
  markDirty();
}

/**
 * Find or start the stream entry for a delta, keyed by its eventId.
 * @param {{ roomId: string, eventId: string, taskId: string, agentId: string }} scope
 * @returns {StreamEntry|null}
 */
function streamFor(scope) {
  if (!state.snapshot || scope.roomId !== state.snapshot.room.id) return null;
  let entry = state.streams.get(scope.eventId);
  if (!entry) {
    entry = {
      id: scope.eventId,
      taskId: scope.taskId,
      author: scope.agentId,
      startedAt: new Date().toISOString(),
      lastDeltaAt: Date.now(),
      text: "",
      details: {},
      version: 0,
    };
    state.streams.set(scope.eventId, entry);
  } else if (entry.stalled) {
    // Real output resumed → the upstream stall is over. The delta handler that
    // called us bumps version + markDirty("transcript"), so clearing the flag
    // here drops the "reconnecting…" pill in the very same repaint.
    entry.stalled = false;
  }
  // Every turn-scoped SSE payload is activity, including tool and thinking
  // deltas that do not append visible prose.
  entry.lastDeltaAt = Date.now();
  syncLiveTimers();
  return entry;
}

/**
 * A live upstream-stall notice arrived: mark the running turn's stream as
 * reconnecting so its bubble shows the retry state instead of freezing. The
 * notice names the stalled agent ("… (@agent) …"); mark that agent's live
 * stream, or every live stream when the name can't be parsed (a room runs one
 * turn at a time). Cleared automatically on the next delta (see streamFor).
 * @param {string} text
 */
function markStreamsStalled(text) {
  const match = /upstream stall \(@([a-z0-9_-]+)\)/i.exec(text);
  const agent = match?.[1];
  let touched = false;
  for (const stream of state.streams.values()) {
    if (agent && stream.author !== agent) continue;
    if (stream.stalled) continue;
    stream.stalled = true;
    stream.version += 1;
    touched = true;
  }
  if (touched) markDirty("transcript");
}

/**
 * @param {{ toolName: string, toolCallId?: string, args?: unknown, partialResult?: unknown, result?: unknown, taskId: string }} payload
 * @param {"running"|"complete"|"error"} status
 * @returns {ToolDetail}
 */
function toolDetail(payload, status) {
  return {
    id: payload.toolCallId ?? `${payload.taskId}:${payload.toolName}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    toolName: payload.toolName,
    status,
    args: payload.args,
    partialResult: payload.partialResult,
    result: payload.result,
  };
}

/**
 * @param {StreamEntry} stream
 * @param {string|undefined} toolCallId
 * @param {string} toolName
 * @returns {ToolDetail|undefined}
 */
function findTool(stream, toolCallId, toolName) {
  const tools = stream.details.tools ?? [];
  if (toolCallId) return tools.find((tool) => tool.id === toolCallId);
  return [...tools].reverse().find((tool) => tool.toolName === toolName && tool.status === "running");
}

// --- Ordered block timeline (mirrors `recordBlockEvent` in src/services/turns.ts
// and RoomService.applyLiveTurn). These build details.blocks so the live stream
// renders text/thinking/tool segments inline in the exact order they arrived,
// and hands off seamlessly to the identically-built committed event. Keep the
// three folders in lockstep. ------------------------------------------------

/**
 * Append a text/thinking span, coalescing into the current block when the kind
 * matches and opening a new one when it changes (so thinking that resumes after
 * a tool call becomes its own block).
 * @param {EventDetails} details
 * @param {"text"|"thinking"} kind
 * @param {string} delta
 */
function appendSpanBlock(details, kind, delta) {
  const blocks = (details.blocks ??= []);
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) last.text += delta;
  else blocks.push({ kind, text: delta });
}

/**
 * Thinking delivered whole (summary content, no deltas): fill the current empty
 * thinking block or open one. If deltas already built it, keep their text.
 * @param {EventDetails} details
 * @param {string} content
 */
function fillThinkingBlock(details, content) {
  const blocks = (details.blocks ??= []);
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "thinking") {
    if (!last.text) last.text = content;
  } else {
    blocks.push({ kind: "thinking", text: content });
  }
}

/**
 * Append a reference block: `tool` points at a tools[] row, `steer` at the
 * steering user room-event (rendered inline at this stream position, its
 * standalone bubble suppressed).
 * @param {EventDetails} details
 * @param {"tool"|"steer"} kind
 * @param {string} id
 */
function pushRefBlock(details, kind, id) {
  (details.blocks ??= []).push({ kind, id });
}

/** @param {import("./types.js").Task|undefined} task */
function upsertTask(task) {
  if (!state.snapshot || !task || task.roomId !== state.snapshot.room.id) return;
  const tasks = state.snapshot.tasks;
  const index = tasks.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) tasks.push(task);
  else tasks[index] = task;
}

/**
 * Re-seed the in-flight stream buffer from a snapshot's `liveTurn`. The server
 * mirrors the running turn's accumulated view (text + thinking + tools) onto
 * every snapshot, so after a room switch — which clears `state.streams` and
 * opens a fresh SSE subscription that only carries NEW deltas — the running
 * turn renders immediately instead of a blank until it commits. Absolute and
 * monotonic: only overwrites when the snapshot carries at least as much text as
 * a live entry already holds, so a stale snapshot can't rewind live deltas.
 */
export function seedLiveTurn() {
  const snapshot = state.snapshot;
  const live = snapshot?.room?.liveTurn;
  if (!live) {
    syncLiveTimers();
    return;
  }
  // Already committed → it's in the transcript; nothing to mirror.
  if (snapshot.room.events.some((event) => event.id === live.eventId)) {
    syncLiveTimers();
    return;
  }
  const existing = state.streams.get(live.eventId);
  if (existing && existing.text.length > live.text.length) {
    syncLiveTimers();
    return;
  }
  state.streams.set(live.eventId, {
    id: live.eventId,
    taskId: live.taskId,
    author: live.agentId,
    startedAt: live.startedAt,
    lastDeltaAt: existing?.lastDeltaAt ?? Date.now(),
    text: live.text,
    details: live.details ?? {},
    version: (existing?.version ?? 0) + 1,
    // The server mirrors mid-stall state, so a client (re)subscribing during a
    // retry gap renders "reconnecting…" instead of a frozen bubble.
    ...(live.stalled ? { stalled: true } : {}),
  });
  syncLiveTimers();
  markDirty("transcript");
}

/**
 * A fresh snapshot is authoritative: drop stream entries that already
 * committed (their id is in the transcript) and entries whose task is no
 * longer live (crashed/cancelled turns that will never commit).
 */
function pruneStreams() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    state.streams.clear();
    syncLiveTimers();
    return;
  }
  const committed = new Set(snapshot.room.events.map((event) => event.id));
  for (const [id, stream] of state.streams) {
    if (committed.has(id)) {
      state.streams.delete(id);
      continue;
    }
    const task = snapshot.tasks.find((candidate) => candidate.id === stream.taskId);
    if (task && task.status !== "running" && task.status !== "queued") state.streams.delete(id);
  }
  syncLiveTimers();
}
