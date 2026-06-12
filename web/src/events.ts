import { state } from "./state.ts";
import { render, renderTranscriptOnly } from "./render.ts";

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

  source.addEventListener("snapshot", (event) => {
    const payload = JSON.parse(event.data);
    if (state.snapshot?.room?.events && payload.snapshot?.room?.events) {
      payload.snapshot.room.events = preserveRuntimeMessageDetails(state.snapshot.room.events, payload.snapshot.room.events);
    }
    state.snapshot = payload.snapshot;
    render();
  });
  source.addEventListener("room-event", (event) => {
    const payload = JSON.parse(event.data);
    if (!state.snapshot) return;
    state.snapshot.room.events = mergeRoomEvent(state.snapshot.room.events, payload.event);
    render();
  });
  source.addEventListener("model-info", (event) => {
    const payload = JSON.parse(event.data);
    if (!state.snapshot) return;
    const message = streamingMessage(payload);
    message._model = `${payload.provider}/${payload.modelId}${payload.subscription ? " (oauth)" : ""}`;
    renderTranscriptOnly();
  });
  source.addEventListener("text-delta", (event) => {
    const payload = JSON.parse(event.data);
    if (!state.snapshot) return;
    const message = streamingMessage(payload);
    message.text += payload.delta;
    renderTranscriptOnly();
  });
  source.addEventListener("thinking-start", (event) => {
    const payload = JSON.parse(event.data);
    if (!state.snapshot) return;
    const message = streamingMessage(payload);
    message._thinkingStarted = true;
    renderTranscriptOnly();
  });
  source.addEventListener("thinking-delta", (event) => {
    const payload = JSON.parse(event.data);
    if (!state.snapshot) return;
    const message = streamingMessage(payload);
    message._thinkingStarted = true;
    message._thinking = `${message._thinking ?? ""}${payload.delta}`;
    renderTranscriptOnly();
  });
  source.addEventListener("thinking-end", (event) => {
    const payload = JSON.parse(event.data);
    if (!state.snapshot) return;
    const message = streamingMessage(payload);
    message._thinkingStarted = true;
    if (payload.content && !message._thinking) message._thinking = payload.content;
    renderTranscriptOnly();
  });
  source.addEventListener("tool-start", (event) => {
    const payload = JSON.parse(event.data);
    if (!state.snapshot) return;
    const message = streamingMessage(payload);
    message._tools = [...(message._tools ?? []), toolActivity(payload, "running")];
    renderTranscriptOnly();
  });
  source.addEventListener("tool-update", (event) => {
    const payload = JSON.parse(event.data);
    if (!state.snapshot) return;
    const tool = findToolActivity(streamingMessage(payload), payload);
    if (tool) tool.partialResult = payload.partialResult;
    renderTranscriptOnly();
  });
  source.addEventListener("tool-end", (event) => {
    const payload = JSON.parse(event.data);
    if (!state.snapshot) return;
    const message = streamingMessage(payload);
    const tool = findToolActivity(message, payload);
    if (tool) {
      tool.status = payload.isError ? "error" : "complete";
      tool.result = payload.result;
    } else {
      message._tools = [...(message._tools ?? []), toolActivity(payload, payload.isError ? "error" : "complete")];
    }
    renderTranscriptOnly();
  });
  for (const name of ["task-start", "task-end", "task-error", "settings-saved"]) {
    source.addEventListener(name, () => render());
  }
}

function streamingMessage(payload) {
  const events = state.snapshot.room.events;
  let message = events.find((event) => event.author === payload.agentId && event._streamTaskId === payload.taskId);
  if (!message) {
    message = { timestamp: new Date().toISOString(), author: payload.agentId, text: "", _streamTaskId: payload.taskId, _tools: [] };
    events.push(message);
  }
  return message;
}

function mergeRoomEvent(events, event) {
  if (event.author === "user" || event.author === "system") {
    const streamingIndex = events.findIndex((candidate) => candidate._streamTaskId);
    if (streamingIndex === -1) return [...events, event];
    return [...events.slice(0, streamingIndex), event, ...events.slice(streamingIndex)];
  }
  const index = events.findIndex((candidate) => candidate.author === event.author && candidate._streamTaskId);
  if (index === -1) return [...events, event];

  const previous = events[index];
  const next = {
    ...event,
    _tools: previous._tools ?? [],
    ...(previous._model ? { _model: previous._model } : {}),
    ...(previous._thinkingStarted ? { _thinkingStarted: true } : {}),
    ...(previous._thinking ? { _thinking: previous._thinking } : {}),
  };
  return [...events.slice(0, index), next, ...events.slice(index + 1)];
}

function preserveRuntimeMessageDetails(previousEvents, nextEvents) {
  const enriched = previousEvents.filter((event) => hasRuntimeMessageDetails(event));
  if (enriched.length === 0) return nextEvents;
  const used = new Set();

  return nextEvents.map((event) => {
    if (event.author === "user") return event;
    const index = enriched.findIndex((candidate, candidateIndex) => {
      if (used.has(candidateIndex)) return false;
      if (candidate.id && event.id) return candidate.id === event.id;
      return candidate.author === event.author && normalizeMessageText(candidate.text) === normalizeMessageText(event.text);
    });
    if (index === -1) return event;

    used.add(index);
    const previous = enriched[index];
    return {
      ...event,
      _tools: previous._tools,
      _model: previous._model,
      _thinkingStarted: previous._thinkingStarted,
      _thinking: previous._thinking,
    };
  });
}

function hasRuntimeMessageDetails(event) {
  return Boolean(event?._model || event?._thinkingStarted || event?._thinking || event?._tools?.length);
}

function normalizeMessageText(text) {
  return String(text ?? "").trim();
}

function toolActivity(payload, status) {
  return {
    id: payload.toolCallId ?? `${payload.taskId}:${payload.toolName}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    toolName: payload.toolName,
    status,
    args: payload.args,
    partialResult: payload.partialResult,
    result: payload.result,
  };
}

function findToolActivity(message, payload) {
  const tools = message._tools ?? [];
  if (payload.toolCallId) return tools.find((tool) => tool.id === payload.toolCallId);
  return [...tools].reverse().find((tool) => tool.toolName === payload.toolName && tool.status === "running");
}
