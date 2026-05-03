const state = {
  app: null,
  snapshot: null,
  workspaceFiles: [],
  globalFiles: [],
  selectedWorkspaceFileId: null,
  selectedGlobalFileId: null,
  workspaceFile: null,
  globalFile: null,
  workspaceRaw: false,
  globalRaw: false,
  settingsOpen: false,
  eventSource: null,
  error: "",
  composerText: "",
  completionIndex: 0,
  completionHidden: false,
  expandedActivities: new Set(),
};

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "value") node.value = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}

function setError(error) {
  state.error = error instanceof Error ? error.message : String(error ?? "");
  render();
}

function isOpenModifier(event) {
  return event.metaKey || event.ctrlKey;
}

function isEditableElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  const tag = element.tagName.toLowerCase();
  return tag === "textarea" || tag === "input" || tag === "select" || element.isContentEditable;
}

function shouldRouteKeyToComposer(event) {
  if (!state.snapshot || state.settingsOpen) return false;
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (isEditableElement(event.target)) return false;
  if (event.key.length === 1) return true;
  return ["Enter", "Backspace", "Delete"].includes(event.key);
}

function isWebTarget(target) {
  return /^https?:\/\//i.test(target) || /^www\./i.test(target);
}

function normalizeWebTarget(target) {
  return /^www\./i.test(target) ? `https://${target}` : target;
}

function looksOpenableTarget(target) {
  return (
    isWebTarget(target) ||
    target.startsWith("/") ||
    target.startsWith("~/") ||
    target.startsWith("./") ||
    target.startsWith("../") ||
    target.startsWith("file://") ||
    target.includes("/") ||
    /\.[a-z0-9]{1,8}(?::\d+(?::\d+)?)?$/i.test(target)
  );
}

function trimTarget(raw) {
  let target = raw;
  while (/[.,;:!?)]$/.test(target) && !/:\d+$/.test(target)) target = target.slice(0, -1);
  return target;
}

function findLinkedSegments(text) {
  const segments = [];
  const pattern =
    /(`[^`\n]+`|https?:\/\/[^\s<>"')\]}]+|www\.[^\s<>"')\]}]+|(?:~|\.{1,2}|\/)[^\s<>"')\]}]+|(?:[A-Za-z0-9_.-]+\/)+[^\s<>"')\]}]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?)/gi;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const raw = match[0];
    const wrapped = raw.startsWith("`") && raw.endsWith("`");
    const inner = wrapped ? raw.slice(1, -1) : raw;
    const target = trimTarget(inner);
    const suffixLength = inner.length - target.length;
    const tokenText = wrapped ? `\`${target}\`` : target;
    const prefixText = text.slice(cursor, index);
    if (prefixText) segments.push({ text: prefixText });
    if (target && looksOpenableTarget(target)) {
      segments.push({ text: tokenText, target });
      if (suffixLength > 0) segments.push({ text: inner.slice(-suffixLength) });
    } else {
      segments.push({ text: raw });
    }
    cursor = index + raw.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

async function openLinkedTarget(target) {
  try {
    if (isWebTarget(target)) {
      window.open(normalizeWebTarget(target), "_blank", "noopener");
      return;
    }
    await api("/api/open-target", {
      method: "POST",
      body: JSON.stringify({ target, workspaceId: state.snapshot?.workspace.id }),
    });
  } catch (error) {
    setError(error);
  }
}

function LinkedText(text, attrs = {}) {
  if (attrs.target) {
    return h(
      "span",
      { class: ["linkified-text", attrs.class].filter(Boolean).join(" ") },
      h(
        "span",
        {
          class: "link-token",
          "data-target": attrs.target,
          title: attrs.target,
          onclick: (event) => {
            if (!isOpenModifier(event)) return;
            event.preventDefault();
            event.stopPropagation();
            void openLinkedTarget(attrs.target);
          },
        },
        String(text ?? ""),
      ),
    );
  }

  return h(
    "span",
    { class: ["linkified-text", attrs.class].filter(Boolean).join(" ") },
    findLinkedSegments(String(text ?? "")).map((segment) => {
      if (!segment.target) return segment.text;
      return h(
        "span",
        {
          class: "link-token",
          "data-target": segment.target,
          title: segment.target,
          onclick: (event) => {
            if (!isOpenModifier(event)) return;
            event.preventDefault();
            event.stopPropagation();
            void openLinkedTarget(segment.target);
          },
        },
        segment.text,
      );
    }),
  );
}

function PathText(path) {
  return LinkedText(path, { target: path });
}

function installOpenModifierTracking() {
  const update = (active) => document.body.classList.toggle("open-link-mode", active);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Meta" || event.key === "Control") update(true);
  });
  window.addEventListener("keyup", (event) => {
    if (event.key === "Meta" || event.key === "Control") update(event.metaKey || event.ctrlKey);
  });
  window.addEventListener("blur", () => update(false));
}

function installComposerRouting() {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "c" && activeTask()) {
        event.preventDefault();
        void cancelActiveTask();
        return;
      }

      if (!shouldRouteKeyToComposer(event)) return;
      event.preventDefault();

      if (event.key === "Enter") {
        if (event.shiftKey) state.composerText += "\n";
        else if (state.composerText.trim()) {
          const text = state.composerText;
          state.composerText = "";
          state.completionIndex = 0;
          state.completionHidden = false;
          renderComposerOnly({ focus: true });
          void sendMessage(text);
          return;
        }
      } else if (event.key === "Backspace") {
        state.composerText = state.composerText.slice(0, -1);
      } else if (event.key === "Delete") {
        // Nothing to delete when the implicit cursor is at the end of the composer.
      } else if (event.key.length === 1) {
        state.composerText += event.key;
        state.completionHidden = false;
      }

      renderComposerOnly({ focus: true });
    },
    true,
  );
}

async function loadApp(currentWorkspaceId) {
  try {
    const body = await api("/api/app");
    state.app = body;
    state.snapshot = body.snapshot ?? null;
    state.workspaceFiles = body.workspaceFiles ?? [];
    state.globalFiles = body.globalFiles ?? [];
    if (currentWorkspaceId && body.currentWorkspaceId !== currentWorkspaceId) await loadWorkspace(currentWorkspaceId);
    connectEvents();
    await loadInitialFiles();
    setError("");
  } catch (error) {
    setError(error);
  }
}

async function loadWorkspace(workspaceId) {
  const body = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/snapshot`);
  state.snapshot = body.snapshot;
  state.workspaceFiles = body.workspaceFiles ?? [];
  state.selectedWorkspaceFileId = state.workspaceFiles[0]?.id ?? null;
  state.workspaceFile = null;
  connectEvents();
  await loadSelectedWorkspaceFile();
  render();
}

async function addWorkspace() {
  const path = window.prompt("Workspace path");
  if (!path) return;
  try {
    const body = await api("/api/workspaces", { method: "POST", body: JSON.stringify({ path }) });
    state.app = body;
    state.snapshot = body.snapshot ?? null;
    state.workspaceFiles = body.workspaceFiles ?? [];
    state.globalFiles = body.globalFiles ?? state.globalFiles;
    connectEvents();
    await loadInitialFiles();
    setError("");
  } catch (error) {
    setError(error);
  }
}

async function sendMessage(text) {
  const snapshot = state.snapshot;
  if (!snapshot || !text.trim()) return;
  try {
    await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    setError(error);
  }
}

async function cancelActiveTask() {
  const snapshot = state.snapshot;
  if (!snapshot || !activeTask(snapshot)) return;
  try {
    await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    setError(error);
  }
}

function activeTask(snapshot = state.snapshot) {
  return (snapshot?.tasks ?? []).find((task) => task.status === "running") ?? null;
}

function connectEvents() {
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
      return candidate.author === event.author && normalizeMessageText(candidate.text) === normalizeMessageText(event.text);
    });
    if (index === -1) return event;

    used.add(index);
    const previous = enriched[index];
    return {
      ...event,
      _tools: previous._tools,
      _thinkingStarted: previous._thinkingStarted,
      _thinking: previous._thinking,
    };
  });
}

function hasRuntimeMessageDetails(event) {
  return Boolean(event?._thinkingStarted || event?._thinking || event?._tools?.length);
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

async function loadInitialFiles() {
  state.selectedWorkspaceFileId = state.selectedWorkspaceFileId ?? state.workspaceFiles[0]?.id ?? null;
  state.selectedGlobalFileId = state.selectedGlobalFileId ?? state.globalFiles[0]?.id ?? null;
  await Promise.all([loadSelectedWorkspaceFile(), loadSelectedGlobalFile()]);
}

async function loadSelectedWorkspaceFile() {
  if (!state.selectedWorkspaceFileId || !state.snapshot) return;
  const params = new URLSearchParams({ workspaceId: state.snapshot.workspace.id });
  state.workspaceFile = (await api(`/api/files/${encodeURIComponent(state.selectedWorkspaceFileId)}?${params}`)).file;
}

async function loadSelectedGlobalFile() {
  if (!state.selectedGlobalFileId) return;
  state.globalFile = (await api(`/api/files/${encodeURIComponent(state.selectedGlobalFileId)}`)).file;
}

async function saveFile(file, content) {
  if (!file) return;
  const params = file.scope === "workspace" && state.snapshot ? `?${new URLSearchParams({ workspaceId: state.snapshot.workspace.id })}` : "";
  const body = await api(`/api/files/${encodeURIComponent(file.id)}${params}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
  if (file.scope === "workspace") state.workspaceFile = body.file;
  else state.globalFile = body.file;
  render();
}

function App() {
  return h(
    "div",
    { class: "shell" },
    Sidebar(),
    h("main", { class: "main" }, Topbar(), h("div", { class: "main-stack" }, state.error ? h("div", { class: "error", text: state.error }) : null, Transcript()), Composer()),
    h("aside", { class: "right" }, RoomPanel(), WorkspacePanel()),
    state.settingsOpen ? SettingsModal() : null,
  );
}

function Sidebar() {
  const workspaces = state.app?.workspaces ?? [];
  const current = state.snapshot?.workspace.id;
  return h(
    "nav",
    { class: "sidebar" },
    h("div", { class: "brand" }, h("span", { text: "GAIA" }), h("small", { text: "local room" })),
    h("div", { class: "nav-title", text: "workspaces" }),
    h(
      "div",
      { class: "workspace-list" },
      workspaces.map((workspace) =>
        h(
          "button",
          {
            class: `nav-item ${workspace.id === current ? "active" : ""} ${workspace.isInitialized ? "" : "muted"}`,
            onclick: () => (workspace.isInitialized ? loadWorkspace(workspace.id) : setError(`Missing .gaia workspace: ${workspace.path}`)),
          },
          h("span", { text: workspace.name }),
          h("small", {}, PathText(workspace.path)),
        ),
      ),
    ),
    h("button", { class: "nav-action", onclick: addWorkspace, text: "+ add workspace" }),
    h("div", { class: "nav-title", text: "rooms" }),
    (state.snapshot?.rooms ?? [{ id: "no room", path: "select a workspace", isCurrent: true }]).map((room) =>
      h("button", { class: `nav-item ${room.isCurrent ? "active" : ""}` }, h("span", { text: room.id }), h("small", {}, PathText(room.path))),
    ),
    h("div", { class: "spacer" }),
    h("button", { class: "nav-action", onclick: () => ((state.settingsOpen = true), render()), text: "global settings" }),
  );
}

function Topbar() {
  const snapshot = state.snapshot;
  return h(
    "header",
    { class: "topbar" },
    h(
      "div",
      {},
      h("strong", {}, snapshot ? PathText(snapshot.workspace.rootDir) : LinkedText("No workspace selected")),
      h("small", {}, snapshot ? PathText(snapshot.workspace.configPath) : LinkedText("Add an initialized workspace to begin.")),
    ),
    h("div", { class: "status", text: snapshot ? `room:${snapshot.room.id} default:@${snapshot.workspace.defaultAgent}` : "idle" }),
  );
}

function Transcript() {
  const events = state.snapshot?.room.events ?? [];
  return h(
    "section",
    { class: "transcript", id: "transcript" },
    events.length === 0 ? h("div", { class: "empty", text: "no messages" }) : events.map(Message),
  );
}

function Message(event) {
  const isUser = event.author === "user";
  const isAgent = !isUser && event.author !== "system";
  const label = isUser ? `user -> ${(event.targets ?? []).map((target) => `@${target}`).join(", ")}` : `@${event.author}`;
  const text = isUser ? stripLeadingRouteMentions(event.text, event.targets ?? []) : event.text;
  const showThinking = event._thinkingStarted || event._thinking;
  return h(
    "article",
    { class: `message ${isUser ? "user" : "agent"} ${event.author === "system" ? "system" : ""}` },
    h("div", { class: "message-meta" }, h("span", { text: label }), h("time", { text: formatTime(event.timestamp) })),
    showThinking
      ? ActivityDetails(
          { id: `thinking:${event._streamTaskId ?? event.timestamp}:${event.author}`, className: "thinking", status: event._streamTaskId ? "running" : "complete", icon: "💭", title: "thinking" },
          h("pre", {}, event._thinking ? LinkedText(event._thinking) : ""),
        )
      : null,
    event._tools?.length ? ToolActivityList(event._tools) : null,
    text.trim() ? (isAgent || event.author === "system" ? MarkdownMessage(text) : h("pre", {}, LinkedText(text))) : null,
  );
}

function MarkdownMessage(text) {
  const root = h("div", { class: "markdown-message" });
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let block = [];
  let code = null;

  const flushBlock = () => {
    while (block.length > 0 && block[0].trim() === "") block.shift();
    while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
    if (block.length === 0) return;
    renderMarkdownBlock(root, block);
    block = [];
  };

  for (const line of lines) {
    const fence = line.match(/^```([a-z0-9_-]*)\s*$/i);
    if (fence) {
      if (code) {
        root.append(CodeBlock(code.lang, code.lines.join("\n")));
        code = null;
      } else {
        flushBlock();
        code = { lang: fence[1] ?? "", lines: [] };
      }
      continue;
    }
    if (code) code.lines.push(line);
    else if (line.trim() === "") flushBlock();
    else block.push(line);
  }

  if (code) root.append(CodeBlock(code.lang, code.lines.join("\n")));
  flushBlock();
  return root;
}

function renderMarkdownBlock(root, lines) {
  if (lines.length === 1) {
    const heading = lines[0].match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      root.append(h(`h${Math.min(6, heading[1].length)}`, {}, InlineMarkdown(heading[2])));
      return;
    }
  }

  if (lines.every((line) => /^[-*]\s+/.test(line))) {
    root.append(h("ul", {}, lines.map((line) => h("li", {}, InlineMarkdown(line.replace(/^[-*]\s+/, ""))))));
    return;
  }

  if (lines.every((line) => /^\d+\.\s+/.test(line))) {
    root.append(h("ol", {}, lines.map((line) => h("li", {}, InlineMarkdown(line.replace(/^\d+\.\s+/, ""))))));
    return;
  }

  if (lines.every((line) => /^>\s?/.test(line))) {
    root.append(h("blockquote", {}, InlineMarkdown(lines.map((line) => line.replace(/^>\s?/, "")).join("\n"))));
    return;
  }

  root.append(h("p", {}, InlineMarkdown(lines.join("\n"))));
}

function InlineMarkdown(text) {
  const nodes = [];
  const pattern = /`([^`\n]+)`/g;
  let cursor = 0;
  for (const match of String(text ?? "").matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(LinkedText(text.slice(cursor, index)));
    nodes.push(h("code", {}, LinkedText(match[1])));
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(LinkedText(text.slice(cursor)));
  return nodes;
}

function CodeBlock(lang, code) {
  return h(
    "div",
    { class: "code-block" },
    lang ? h("div", { class: "code-lang", text: lang }) : null,
    h("pre", {}, h("code", {}, LinkedText(code))),
  );
}

function ToolActivityList(tools) {
  return h(
    "div",
    { class: "tool-activity" },
    tools.map((tool) => {
      const presentation = toolPresentation(tool);
      return ActivityDetails(
        { id: `tool:${tool.id}`, className: "tool-call", status: tool.status, icon: presentation.icon, title: presentation.title, extra: presentation.extra },
        ToolPayload("call", { id: tool.id, name: tool.toolName, status: tool.status }),
        ToolPayload("args", tool.args),
        ToolPayload("partial", tool.partialResult),
        ToolPayload("result", tool.result),
      );
    }),
  );
}

function ActivityDetails(options, ...children) {
  const statusText = activityStatusText(options.status);
  const id = options.id ?? `${options.className ?? "activity"}:${options.title ?? ""}:${options.extra ?? ""}`;
  return h(
    "details",
    {
      class: `activity-details ${options.className ?? ""} ${options.status ?? "complete"}`,
      "data-activity-id": id,
      open: state.expandedActivities.has(id),
      ontoggle: (event) => {
        if (event.currentTarget.open) state.expandedActivities.add(id);
        else state.expandedActivities.delete(id);
      },
    },
    h(
      "summary",
      {},
      h("span", { class: "activity-icon", "aria-hidden": "true", text: options.icon ?? "" }),
      h("strong", { class: "activity-title", text: options.title ?? "" }),
      h("small", { class: "activity-extra", text: options.extra ?? "" }),
      h("span", { class: "activity-result", title: statusText, "aria-label": statusText, text: activityResultText(options.status) }),
    ),
    children,
  );
}

function ToolPayload(label, value) {
  if (value === undefined || value === null) return null;
  return h("div", { class: "tool-payload" }, h("span", { text: label }), h("pre", {}, LinkedText(formatPayload(value))));
}

function activityStatusText(status) {
  if (status === "running") return "running";
  if (status === "error") return "error";
  return "complete";
}

function activityResultText(status) {
  if (status === "running") return "";
  if (status === "error") return "x";
  return "✓";
}

function toolPresentation(tool) {
  return {
    icon: "🛠️",
    title: tool.toolName,
    extra: toolSummaryText(tool),
  };
}

function toolSummaryText(tool) {
  const candidates = [
    ...toolSubjectCandidates(tool.args),
    ...toolSubjectCandidates(tool.partialResult),
    ...toolSubjectCandidates(tool.result),
  ];
  return candidates[0]?.summary ?? "";
}

function toolSubjectCandidates(value, path = [], depth = 0) {
  if (value === undefined || value === null || depth > 3) return [];
  if (typeof value === "string") {
    const summary = compactOneLine(value);
    return summary ? [{ score: path.length ? subjectScore(path.at(-1)) : 0, summary }] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const key = path.at(-1);
    const summary = key ? `${key}: ${String(value)}` : String(value);
    return [{ score: subjectScore(key), summary }];
  }
  if (Array.isArray(value)) {
    return value.slice(0, 4).flatMap((item, index) => toolSubjectCandidates(item, [...path, String(index)], depth + 1));
  }
  if (typeof value !== "object") return [];

  return Object.entries(value)
    .flatMap(([key, nested]) => {
      const nextPath = [...path, key];
      const label = compactKey(key);
      if (typeof nested === "string") {
        const body = compactOneLine(nested);
        if (!body) return [];
        return [{ score: subjectScore(key), summary: subjectScore(key) >= 80 ? body : `${label}: ${body}` }];
      }
      if (typeof nested === "number" || typeof nested === "boolean") {
        return [{ score: subjectScore(key), summary: `${label}: ${String(nested)}` }];
      }
      return toolSubjectCandidates(nested, nextPath, depth + 1);
    })
    .sort((left, right) => right.score - left.score);
}

function subjectScore(key) {
  const normalized = String(key ?? "").toLowerCase();
  if (["path", "filepath", "file", "filename", "url", "uri", "href", "target"].includes(normalized)) return 100;
  if (["command", "cmd", "query", "pattern", "repo", "repository", "cwd", "name", "id"].includes(normalized)) return 80;
  if (normalized.includes("path") || normalized.includes("file") || normalized.includes("url")) return 90;
  return 10;
}

function compactKey(key) {
  return String(key ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function compactOneLine(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function formatPayload(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stripLeadingRouteMentions(text, targets) {
  let remaining = String(text ?? "").trimStart();
  const targetSet = new Set(targets ?? []);

  while (true) {
    const match = remaining.match(/^@([a-z0-9_-]+)\b[,\s]*/i);
    if (!match) break;
    const target = match[1];
    if (targetSet.size > 0 && !targetSet.has(target)) break;
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return remaining;
}

function composerTargetStatus(snapshot, text) {
  if (!snapshot) return "no room";
  if (text.trimStart().startsWith("/")) return "command mode";

  const knownAgents = new Set((snapshot.agents ?? []).map((agent) => agent.id));
  const targets = [];
  for (const match of text.matchAll(/@([a-z0-9_-]+)/gi)) {
    const id = match[1];
    if (!knownAgents.has(id) || targets.includes(id)) continue;
    targets.push(id);
  }

  if (targets.length === 0) targets.push(snapshot.workspace.defaultAgent);
  return `talking to ${targets.map((target) => `@${target}`).join(", ")}`;
}

function Composer() {
  const snapshot = state.snapshot;
  const runningTask = activeTask(snapshot);
  const completion = completionFor(state.composerText);
  const textarea = h("textarea", {
    rows: "1",
    class: "command-input",
    placeholder: snapshot ? "message @agent or /command" : "select a workspace",
    disabled: !snapshot,
    value: state.composerText,
    oninput: () => {
      state.composerText = textarea.value;
      state.completionHidden = false;
      resizeComposer(textarea);
      renderComposerOnly({ focus: true, selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd });
    },
    onpaste: () => requestAnimationFrame(() => resizeComposer(textarea)),
    onkeydown: (event) => {
      if (completion && !state.completionHidden && ["ArrowDown", "ArrowUp", "Tab", "Escape", "Enter"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "ArrowDown") state.completionIndex = (state.completionIndex + 1) % Math.max(1, completion.options.length);
        else if (event.key === "ArrowUp") state.completionIndex = (state.completionIndex - 1 + Math.max(1, completion.options.length)) % Math.max(1, completion.options.length);
        else if (event.key === "Escape") state.completionHidden = true;
        else if (completion.options.length > 0) applyCompletion(completion, completion.options[state.completionIndex] ?? completion.options[0]);
        renderComposerOnly({ focus: true });
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (runningTask) return;
        const text = state.composerText;
        state.composerText = "";
        state.completionIndex = 0;
        state.completionHidden = false;
        renderComposerOnly();
        void sendMessage(text);
      }
    },
  });
  requestAnimationFrame(() => resizeComposer(textarea));
  return h(
    "form",
    {
      class: "composer",
      onsubmit: (event) => {
        event.preventDefault();
        if (runningTask) {
          void cancelActiveTask();
          return;
        }
        const text = state.composerText;
        state.composerText = "";
        state.completionIndex = 0;
        state.completionHidden = false;
        renderComposerOnly();
        void sendMessage(text);
      },
    },
    completion && !state.completionHidden ? Autocomplete(completion) : null,
    textarea,
    h(
      "div",
      { class: "composer-row" },
      h("div", { class: "target-status", text: composerTargetStatus(snapshot, state.composerText) }),
      h("button", { class: runningTask ? "send-button cancel" : "send-button", disabled: !snapshot, title: runningTask ? "stop agents" : "send", text: runningTask ? "x" : ">" }),
    ),
  );
}

function completionFor(text) {
  if (!state.snapshot) return null;
  const slash = text.match(/^\/([^\s]*)$/);
  if (slash) {
    const query = slash[1].toLowerCase();
    const options = (state.snapshot.commands ?? [])
      .filter((command) => command.name.toLowerCase().startsWith(query))
      .map((command) => ({ label: command.name, value: `/${command.name}`, description: command.description, suffix: command.name === "role" || command.name === "roles" ? " " : "" }));
    state.completionIndex = Math.min(state.completionIndex, Math.max(0, options.length - 1));
    return { kind: "/", start: 0, query, options };
  }

  const mention = text.match(/(^|\s)@([a-z0-9_-]*)$/i);
  if (!mention || mention.index === undefined) return null;
  const separator = mention[1];
  const query = mention[2].toLowerCase();
  const start = mention.index + separator.length;
  const options = (state.snapshot.agents ?? [])
    .filter((agent) => agent.id.toLowerCase().startsWith(query))
    .map((agent) => ({ label: agent.id, value: `@${agent.id}`, description: [agent.isDefault ? "default" : "", agent.activeRole ? `role:${agent.activeRole}` : "", agent.modelLabel].filter(Boolean).join(" / "), suffix: " " }));
  state.completionIndex = Math.min(state.completionIndex, Math.max(0, options.length - 1));
  return { kind: "@", start, query, options };
}

function applyCompletion(completion, option) {
  if (!option) return;
  state.composerText = `${state.composerText.slice(0, completion.start)}${option.value}${option.suffix ?? ""}`;
  state.completionIndex = 0;
  state.completionHidden = true;
}

function Autocomplete(completion) {
  const options = completion.options.slice(0, 8);
  return h(
    "div",
    { class: "autocomplete" },
    options.length === 0
      ? h("div", { class: "completion-row empty", text: `${completion.kind}${completion.query}  no matches` })
      : options.map((option, index) =>
          h(
            "button",
            {
              type: "button",
              class: `completion-row ${index === state.completionIndex ? "active" : ""}`,
              onmousedown: (event) => event.preventDefault(),
              onclick: () => {
                applyCompletion(completion, option);
                renderComposerOnly({ focus: true });
              },
            },
            h("span", { text: option.value }),
            h("small", { text: option.description }),
          ),
        ),
  );
}

function RoomPanel() {
  const snapshot = state.snapshot;
  const agents = snapshot?.agents ?? [];
  const tasks = snapshot?.tasks ?? [];
  return h(
    "section",
    { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", { text: "Room" }), h("small", {}, snapshot?.room.statePath ? PathText(snapshot.room.statePath) : LinkedText("no room"))),
    h("h3", { text: "agents" }),
    h(
      "div",
      { class: "agent-list" },
      agents.map((agent) =>
        h(
          "div",
          { class: "agent-row" },
          h("span", { class: `dot ${agent.status}` }),
          h("strong", { text: `${agent.icon} @${agent.id}` }),
          h("small", { text: [agent.isDefault ? "default" : "", agent.activeRole ? `role:${agent.activeRole}` : "", agent.modelLabel].filter(Boolean).join(" / ") }),
        ),
      ),
    ),
    h("h3", { text: "tasks" }),
    h(
      "div",
      { class: "task-list" },
      tasks.length === 0
        ? h("div", { class: "empty", text: "no tasks" })
        : tasks.slice(-5).map((task) => h("div", { class: `task ${task.status}` }, h("span", { text: task.status }), h("small", { text: task.text }))),
    ),
  );
}

function WorkspacePanel() {
  return h(
    "section",
    { class: "panel workspace-panel" },
    h("div", { class: "panel-head" }, h("h2", { text: "Workspace" }), h("small", {}, state.snapshot?.workspace.rootDir ? PathText(state.snapshot.workspace.rootDir) : LinkedText("none"))),
    FileSelector(state.workspaceFiles, state.selectedWorkspaceFileId, async (id) => {
      state.selectedWorkspaceFileId = id;
      await loadSelectedWorkspaceFile();
      render();
    }),
    FileSettingsEditor({
      file: state.workspaceFile,
      raw: state.workspaceRaw,
      setRaw: (value) => {
        state.workspaceRaw = value;
        render();
      },
    }),
  );
}

function SettingsModal() {
  return h(
    "div",
    { class: "modal-backdrop" },
    h(
      "section",
      { class: "modal" },
      h("div", { class: "panel-head" }, h("h2", { text: "Global Settings" }), h("button", { onclick: () => ((state.settingsOpen = false), render()), text: "x" })),
      FileSelector(state.globalFiles, state.selectedGlobalFileId, async (id) => {
        state.selectedGlobalFileId = id;
        await loadSelectedGlobalFile();
        render();
      }),
      FileSettingsEditor({
        file: state.globalFile,
        raw: state.globalRaw,
        setRaw: (value) => {
          state.globalRaw = value;
          render();
        },
      }),
    ),
  );
}

function FileSelector(files, selectedId, onSelect) {
  return h(
    "div",
    { class: "file-tabs" },
    files.length === 0
      ? h("span", { class: "empty", text: "no editable files" })
      : files.map((file) =>
          h("button", { class: file.id === selectedId ? "active" : "", onclick: () => onSelect(file.id) }, h("span", { text: file.label }), h("small", {}, PathText(file.path))),
        ),
  );
}

function FileSettingsEditor({ file, raw, setRaw }) {
  if (!file) return h("div", { class: "empty", text: "select a file" });
  const editor = h("div", { class: "settings-editor" });
  const rawText = h("textarea", { class: "raw-editor", value: file.content });
  const view = file.kind === "json" ? JsonSettingsView(file.content) : MarkdownSettingsView(file.content);
  editor.append(
    h(
      "div",
      { class: "file-toolbar" },
      h("code", {}, PathText(file.path)),
      h("button", { onclick: () => setRaw(!raw), text: raw ? "view" : "raw" }),
      h("button", { onclick: () => saveFile(file, raw ? rawText.value : serializeSettings(view, file.kind)), text: "save" }),
    ),
    raw ? rawText : view,
  );
  return editor;
}

function JsonSettingsView(content) {
  const root = h("div", { class: "settings-view", "data-kind": "json" });
  let parsed = {};
  try {
    parsed = JSON.parse(content || "{}");
  } catch {
    return h("textarea", { class: "raw-editor", value: content });
  }
  for (const [key, value] of Object.entries(parsed)) {
    root.append(
      h(
        "label",
        { class: "setting-row" },
        h("span", { text: key }),
        h("input", { "data-json-key": key, value: typeof value === "object" ? JSON.stringify(value) : String(value ?? "") }),
      ),
    );
  }
  return root;
}

function MarkdownSettingsView(content) {
  const root = h("div", { class: "settings-view", "data-kind": "markdown" });
  const lines = content.split("\n");
  let block = [];
  const flushBlock = () => {
    while (block.length > 0 && block[0].trim() === "") block.shift();
    while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
    const value = block.join("\n");
    if (value.trim()) {
      root.append(h("textarea", { class: "text-setting", rows: String(Math.max(3, Math.min(12, value.split("\n").length + 1))), "data-md": "text", value }));
    }
    block = [];
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushBlock();
      root.append(h("div", { class: "setting-heading", "data-md": "heading", "data-level": heading[1].length, text: heading[2] }));
      continue;
    }
    block.push(line);
  }

  flushBlock();
  return root;
}

function serializeSettings(view, kind) {
  if (kind === "json") {
    const next = {};
    for (const input of view.querySelectorAll("[data-json-key]")) {
      const value = input.value;
      try {
        next[input.dataset.jsonKey] = JSON.parse(value);
      } catch {
        next[input.dataset.jsonKey] = value;
      }
    }
    return `${JSON.stringify(next, null, 2)}\n`;
  }

  const lines = [];
  for (const node of view.children) {
    if (node.dataset.md === "heading") lines.push(`${"#".repeat(Number(node.dataset.level ?? 1))} ${node.textContent}`);
    else if (node.dataset.md === "text") lines.push(node.value);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderTranscriptOnly() {
  const target = document.querySelector("#transcript");
  if (!target) {
    render();
    return;
  }
  target.replaceWith(Transcript());
  document.querySelector("#transcript")?.scrollTo({ top: 100000 });
}

function resizeComposer(textarea) {
  textarea.style.height = "0px";
  textarea.style.height = `${Math.min(180, Math.max(34, textarea.scrollHeight))}px`;
}

function focusComposer(selectionStart, selectionEnd) {
  const textarea = document.querySelector(".command-input");
  if (!textarea || textarea.disabled) return;
  textarea.focus();
  const start = selectionStart ?? state.composerText.length;
  const end = selectionEnd ?? start;
  textarea.setSelectionRange(start, end);
  resizeComposer(textarea);
}

function focusComposerFromBackground(event) {
  if (state.settingsOpen) return;
  if (isEditableElement(event.target)) return;
  if (event.target instanceof HTMLElement && event.target.closest("button")) return;
  focusComposer();
}

function renderComposerOnly(options = {}) {
  const target = document.querySelector(".composer");
  if (!target) {
    render();
    return;
  }
  const wasComposerFocus = document.activeElement === target.querySelector(".command-input");
  target.replaceWith(Composer());
  if (options.focus || wasComposerFocus) focusComposer(options.selectionStart, options.selectionEnd);
}

function render() {
  const root = document.querySelector("#app");
  const shouldKeepComposerFocus = document.activeElement === document.querySelector(".command-input") || document.activeElement === document.body;
  root.replaceChildren(App());
  document.querySelector("#transcript")?.scrollTo({ top: 100000 });
  if (shouldKeepComposerFocus && !state.settingsOpen) focusComposer();
}

installOpenModifierTracking();
installComposerRouting();
window.addEventListener("pointerdown", focusComposerFromBackground);
void loadApp();
