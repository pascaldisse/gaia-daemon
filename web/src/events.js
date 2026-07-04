// SSE consumption. v2 streaming deltas carry `eventId` — the transcript event
// id the reply will commit under — so runtime details are keyed directly by
// event id in state.streams. No author+text snapshot-merge heuristic exists:
// the final room-event with the same id simply replaces the stream entry.
import { api } from "./api.js";
import { maybeAutoDario, syncDarioFromSnapshot } from "./dario.js";
import { markDirty, setError } from "./render.js";
import { loadSelectedGlobalFile, loadSelectedWorkspaceFile } from "./settings.js";
import { state } from "./state.js";
import { syncOlderFromSnapshot } from "./transcript.js";
import { applyVoiceStatus, voiceTurnCommitted } from "./voice.js";

/** @typedef {import("./types.js").UiEvent} UiEvent */
/** @typedef {import("./types.js").StreamEntry} StreamEntry */
/** @typedef {import("./types.js").ToolDetail} ToolDetail */
/**
 * @template {UiEvent["type"]} T
 * @typedef {import("./types.js").Ev<T>} Ev
 */

export function connectEvents() {
  const snapshot = state.snapshot;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  if (!snapshot) return;

  const params = new URLSearchParams({ workspaceId: snapshot.workspace.id, roomId: snapshot.room.id });
  const source = new EventSource(`/api/events?${params}`);
  state.eventSource = source;

  // The server greets every (re)connection with "ready". EventSource
  // reconnects on its own after a drop, but events broadcast while we were
  // gone are lost — so a ready that isn't the first one resyncs with a
  // fresh snapshot.
  let connectedBefore = false;
  source.addEventListener("ready", () => {
    if (connectedBefore) void resyncSnapshot(snapshot.workspace.id);
    connectedBefore = true;
  });

  source.addEventListener("snapshot", (event) => {
    const payload = /** @type {Ev<"snapshot">} */ (JSON.parse(event.data));
    state.snapshot = payload.snapshot;
    pruneStreams();
    syncDarioFromSnapshot();
    syncOlderFromSnapshot();
    markDirty();
  });

  source.addEventListener("room-event", (event) => {
    const payload = /** @type {Ev<"room-event">} */ (JSON.parse(event.data));
    if (!state.snapshot) return;
    // The commit carries its runtime details on the event itself; the stream
    // entry for the same id (if any) is now redundant.
    state.streams.delete(payload.event.id);
    const events = state.snapshot.room.events;
    const index = events.findIndex((candidate) => candidate.id === payload.event.id);
    if (index === -1) events.push(payload.event);
    else events[index] = payload.event;
    if (payload.event.author === "user" && payload.event.channel === "voice") voiceTurnCommitted();
    maybeAutoDario(payload.event);
    markDirty("transcript", "panel", "status", "tabs", "sidebar");
  });

  source.addEventListener("voice-status", (event) => {
    applyVoiceStatus(/** @type {Ev<"voice-status">} */ (JSON.parse(event.data)));
  });

  source.addEventListener("model-info", (event) => {
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

  source.addEventListener("context-usage", (event) => {
    const payload = /** @type {Ev<"context-usage">} */ (JSON.parse(event.data));
    const agent = (state.snapshot?.agents ?? []).find((candidate) => candidate.id === payload.agentId);
    if (!agent) return;
    agent.context = { usedTokens: payload.usedTokens, ...(payload.maxTokens ? { maxTokens: payload.maxTokens } : {}) };
    markDirty("composer");
  });

  source.addEventListener("model-fallback", (event) => {
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

  source.addEventListener("text-delta", (event) => {
    const payload = /** @type {Ev<"text-delta">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    stream.text += payload.delta;
    stream.version += 1;
    markDirty("transcript");
  });

  source.addEventListener("thinking-start", (event) => {
    const payload = /** @type {Ev<"thinking-start">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    stream.details.thinkingStarted = true;
    stream.version += 1;
    markDirty("transcript");
  });

  source.addEventListener("thinking-delta", (event) => {
    const payload = /** @type {Ev<"thinking-delta">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    stream.details.thinkingStarted = true;
    stream.details.thinking = `${stream.details.thinking ?? ""}${payload.delta}`;
    stream.version += 1;
    markDirty("transcript");
  });

  source.addEventListener("thinking-end", (event) => {
    const payload = /** @type {Ev<"thinking-end">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    stream.details.thinkingStarted = true;
    if (payload.content && !stream.details.thinking) stream.details.thinking = payload.content;
    stream.version += 1;
    markDirty("transcript");
  });

  source.addEventListener("tool-start", (event) => {
    const payload = /** @type {Ev<"tool-start">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    stream.details.tools = [...(stream.details.tools ?? []), toolDetail(payload, "running")];
    stream.version += 1;
    markDirty("transcript");
  });

  source.addEventListener("tool-update", (event) => {
    const payload = /** @type {Ev<"tool-update">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    const tool = findTool(stream, payload.toolCallId, payload.toolName);
    if (tool) tool.partialResult = payload.partialResult;
    stream.version += 1;
    markDirty("transcript");
  });

  source.addEventListener("tool-end", (event) => {
    const payload = /** @type {Ev<"tool-end">} */ (JSON.parse(event.data));
    const stream = streamFor(payload);
    if (!stream) return;
    const tool = findTool(stream, payload.toolCallId, payload.toolName);
    if (tool) {
      tool.status = payload.isError ? "error" : "complete";
      tool.result = payload.result;
    } else {
      stream.details.tools = [...(stream.details.tools ?? []), toolDetail(payload, payload.isError ? "error" : "complete")];
    }
    stream.version += 1;
    markDirty("transcript");
  });

  source.addEventListener("task-start", (event) => {
    const payload = /** @type {Ev<"task-start">} */ (JSON.parse(event.data));
    upsertTask(payload.task);
    markDirty("panel", "status", "composer", "tabs", "sidebar");
  });

  source.addEventListener("task-end", (event) => {
    const payload = /** @type {Ev<"task-end">} */ (JSON.parse(event.data));
    upsertTask(payload.task);
    markDirty("panel", "status", "composer", "tabs", "sidebar");
  });

  source.addEventListener("task-error", (event) => {
    const payload = /** @type {Ev<"task-error">} */ (JSON.parse(event.data));
    upsertTask(payload.task);
    // Drop the empty streaming placeholder the failed turn left behind;
    // partial replies stay visible (frozen) until the next snapshot.
    for (const [id, stream] of state.streams) {
      if (stream.taskId === payload.task?.id && !stream.text) state.streams.delete(id);
    }
    const who = payload.task?.targets?.length ? ` (@${payload.task.targets.join(", @")})` : "";
    setError(`Turn failed${who}: ${payload.error || "unknown error"}`);
    markDirty("transcript", "panel", "composer", "tabs", "sidebar");
  });

  source.addEventListener("settings-saved", (event) => {
    const payload = /** @type {Ev<"settings-saved">} */ (JSON.parse(event.data));
    void refreshSavedFile(payload.fileId);
  });
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
    state.snapshot = body.snapshot;
    state.voice = body.voice ?? null;
    pruneStreams();
    syncOlderFromSnapshot();
    markDirty();
  } catch {
    // Server unreachable again — the next successful reconnect retries.
  }
}

/**
 * A save (this tab or another) invalidates the cached content of that file;
 * refetch before re-rendering so the editor never rebuilds from a stale copy.
 * @param {string} fileId
 */
async function refreshSavedFile(fileId) {
  try {
    if (state.workspaceFile?.id === fileId) await loadSelectedWorkspaceFile();
    if (state.globalFile?.id === fileId) await loadSelectedGlobalFile();
  } catch {
    // Keep the cached copy if the refetch fails.
  }
  markDirty("settings");
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
      text: "",
      details: {},
      version: 0,
    };
    state.streams.set(scope.eventId, entry);
  }
  return entry;
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

/** @param {import("./types.js").Task|undefined} task */
function upsertTask(task) {
  if (!state.snapshot || !task || task.roomId !== state.snapshot.room.id) return;
  const tasks = state.snapshot.tasks;
  const index = tasks.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) tasks.push(task);
  else tasks[index] = task;
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
}
