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
    state.snapshot = payload.snapshot;
    render();
  });
  source.addEventListener("room-event", (event) => {
    const payload = JSON.parse(event.data);
    if (!state.snapshot) return;
    state.snapshot.room.events = [...state.snapshot.room.events, payload.event];
    render();
  });
  source.addEventListener("text-delta", (event) => {
    const payload = JSON.parse(event.data);
    if (!state.snapshot) return;
    const events = state.snapshot.room.events;
    let last = events[events.length - 1];
    if (!last || last.author !== payload.agentId || last._streamTaskId !== payload.taskId) {
      last = { timestamp: new Date().toISOString(), author: payload.agentId, text: "", _streamTaskId: payload.taskId };
      events.push(last);
    }
    last.text += payload.delta;
    renderTranscriptOnly();
  });
  for (const name of ["task-start", "task-end", "task-error", "tool-start", "tool-end", "settings-saved"]) {
    source.addEventListener(name, () => render());
  }
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
          h("small", { text: workspace.path }),
        ),
      ),
    ),
    h("button", { class: "nav-action", onclick: addWorkspace, text: "+ add workspace" }),
    h("div", { class: "nav-title", text: "rooms" }),
    (state.snapshot?.rooms ?? [{ id: "no room", path: "select a workspace", isCurrent: true }]).map((room) =>
      h("button", { class: `nav-item ${room.isCurrent ? "active" : ""}` }, h("span", { text: room.id }), h("small", { text: room.path })),
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
    h("div", {}, h("strong", { text: snapshot ? snapshot.workspace.rootDir : "No workspace selected" }), h("small", { text: snapshot ? snapshot.workspace.configPath : "Add an initialized workspace to begin." })),
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
  const label = isUser ? `user -> ${(event.targets ?? []).map((target) => `@${target}`).join(", ")}` : `@${event.author}`;
  return h(
    "article",
    { class: `message ${isUser ? "user" : "agent"}` },
    h("div", { class: "message-meta" }, h("span", { text: label }), h("time", { text: formatTime(event.timestamp) })),
    h("pre", { text: event.text }),
  );
}

function Composer() {
  const snapshot = state.snapshot;
  const textarea = h("textarea", {
    rows: "3",
    placeholder: snapshot ? "message @agent or /command" : "select a workspace",
    disabled: !snapshot,
    onkeydown: (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        const text = textarea.value;
        textarea.value = "";
        void sendMessage(text);
      }
    },
  });
  return h(
    "form",
    {
      class: "composer",
      onsubmit: (event) => {
        event.preventDefault();
        const text = textarea.value;
        textarea.value = "";
        void sendMessage(text);
      },
    },
    textarea,
    h(
      "div",
      { class: "composer-row" },
      h("div", { class: "hints" }, (snapshot?.commands ?? []).map((command) => h("span", { text: `/${command.name}` }))),
      h("button", { disabled: !snapshot, text: "send" }),
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
    h("div", { class: "panel-head" }, h("h2", { text: "Room" }), h("small", { text: snapshot?.room.statePath ?? "no room" })),
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
    h("div", { class: "panel-head" }, h("h2", { text: "Workspace" }), h("small", { text: state.snapshot?.workspace.rootDir ?? "none" })),
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
          h("button", { class: file.id === selectedId ? "active" : "", onclick: () => onSelect(file.id) }, h("span", { text: file.label }), h("small", { text: file.path })),
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
      h("code", { text: file.path }),
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

function render() {
  const root = document.querySelector("#app");
  root.replaceChildren(App());
  document.querySelector("#transcript")?.scrollTo({ top: 100000 });
}

void loadApp();
