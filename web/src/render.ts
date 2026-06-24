import { addRoom, addWorkspace, closeRoomTab, loadWorkspace, selectRoom, setAgentRole, setDefaultAgent } from "./actions.ts";
import { Composer, focusComposer } from "./composer.ts";
import { h } from "./dom.ts";
import { LinkedText, PathText } from "./links.ts";
import { openAgentSettings, SettingsModal, WorkspacePanel } from "./settings.ts";
import { state } from "./state.ts";
import { moveTab, visibleTabs } from "./tabs.ts";
import { applyTheme, currentThemeId, themeById, THEMES } from "./themes.ts";
import { Transcript } from "./transcript.ts";
import { toggleCall } from "./voice.ts";

export function setError(error) {
  state.error = error instanceof Error ? error.message : String(error ?? "");
  render();
}

// Layout reads like a tmux session: a window bar of room tabs up top, a
// resizable three-pane body, and a powerline status bar pinned at the bottom.
function App() {
  return h(
    "div",
    { class: "shell" },
    TabBar(),
    Body(),
    StatusBar(),
    state.themePaletteOpen ? ThemePalette() : null,
    state.settingsOpen ? SettingsModal() : null,
  );
}

function Body() {
  const cols = [];
  const kids = [];
  if (!state.sidebarCollapsed) {
    cols.push("var(--w-left)", "5px");
    kids.push(Sidebar(), ColResizer("left"));
  }
  cols.push("minmax(0,1fr)");
  kids.push(
    h(
      "main",
      { class: "main" },
      Topbar(),
      h("div", { class: "main-stack" }, state.error ? h("div", { class: "error", text: state.error }) : null, Transcript()),
      Composer(),
    ),
  );
  if (!state.rightCollapsed) {
    cols.push("5px", "var(--w-right)");
    kids.push(ColResizer("right"), h("aside", { class: "right" }, RoomPanel(), WorkspacePanel()));
  }
  return h("div", { class: "body", style: `grid-template-columns:${cols.join(" ")}` }, ...kids);
}

// The tmux window bar. Rooms are windows; the active one is highlighted, each
// carries its jump number (Alt+N), drags to reorder, and closes from the
// working set without deleting the room.
function TabBar() {
  const snapshot = state.snapshot;
  const wsId = snapshot?.workspace.id;
  const currentId = snapshot?.room?.id;
  const tabs = visibleTabs(snapshot);
  return h(
    "header",
    { class: "tabbar" },
    h("button", {
      class: "chrome-btn",
      title: state.sidebarCollapsed ? "show sessions (Ctrl+B)" : "hide sessions (Ctrl+B)",
      onclick: () => ((state.sidebarCollapsed = !state.sidebarCollapsed), render()),
      text: state.sidebarCollapsed ? "▸" : "◂",
    }),
    h("div", { class: "tab-brand" }, h("span", { class: "tab-logo", text: "◆" }), h("span", { text: "GAIA" })),
    h(
      "div",
      { class: "tab-strip" },
      tabs.map((room, index) => Tab(room, index + 1, room.id === currentId, wsId)),
      snapshot ? h("button", { class: "tab-new", title: "new room (Ctrl+T)", onclick: addRoom, text: "+" }) : null,
    ),
    h("div", { class: "tab-spacer" }),
    h("button", {
      class: "chrome-btn",
      title: state.rightCollapsed ? "show room panel (Ctrl+G)" : "hide room panel (Ctrl+G)",
      onclick: () => ((state.rightCollapsed = !state.rightCollapsed), render()),
      text: "▥",
    }),
  );
}

function Tab(room, number, isActive, wsId) {
  const isDragging = state.tabDragId === room.id;
  return h(
    "div",
    {
      class: `tab ${isActive ? "active" : ""} ${isDragging ? "dragging" : ""} ${room.running ? "running" : ""}`,
      draggable: "true",
      title: room.id,
      ondragstart: (event) => {
        state.tabDragId = room.id;
        event.dataTransfer.effectAllowed = "move";
      },
      ondragend: () => ((state.tabDragId = null), render()),
      ondragover: (event) => event.preventDefault(),
      ondrop: (event) => {
        event.preventDefault();
        if (state.tabDragId && wsId) moveTab(state.tabDragId, room.id, wsId);
        state.tabDragId = null;
        render();
      },
      onclick: () => (isActive || !wsId ? undefined : selectRoom(wsId, room.id)),
    },
    h("span", { class: "tab-num", text: String(number) }),
    room.running ? h("span", { class: "tab-dot" }) : null,
    h("span", { class: "tab-name", text: room.id }),
    h("button", {
      class: "tab-close",
      title: "close tab (room is kept)",
      onclick: (event) => (event.stopPropagation(), void closeRoomTab(room.id)),
      text: "×",
    }),
  );
}

// Drag handle between panes. Resizing rewrites the width CSS var on :root and
// persists it, so panes stay where the user put them across reloads.
function ColResizer(side) {
  return h("div", { class: "col-resizer", title: "drag to resize", onpointerdown: (event) => startResize(event, side) });
}

function startResize(event, side) {
  event.preventDefault();
  const root = document.documentElement;
  const varName = side === "left" ? "--w-left" : "--w-right";
  const startX = event.clientX;
  const start = parseInt(getComputedStyle(root).getPropertyValue(varName), 10) || (side === "left" ? 260 : 340);
  const onMove = (move) => {
    const delta = side === "left" ? move.clientX - startX : startX - move.clientX;
    const next = Math.max(160, Math.min(560, start + delta));
    root.style.setProperty(varName, `${next}px`);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.classList.remove("resizing");
    try {
      localStorage.setItem(
        "gaia.cols",
        JSON.stringify({ left: root.style.getPropertyValue("--w-left"), right: root.style.getPropertyValue("--w-right") }),
      );
    } catch {
      // storage disabled — widths just won't persist.
    }
  };
  document.body.classList.add("resizing");
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function Sidebar() {
  const workspaces = state.workspaces;
  const current = state.snapshot?.workspace.id;
  return h(
    "nav",
    { class: "sidebar" },
    h("div", { class: "nav-title", text: "workspaces" }),
    h(
      "div",
      { class: "workspace-list" },
      workspaces.map((workspace) =>
        h(
          "button",
          {
            class: `nav-item ${workspace.id === current ? "active" : ""} ${workspace.isInitialized ? "" : "muted"}`,
            title: workspace.path,
            onclick: () => (workspace.isInitialized ? loadWorkspace(workspace.id) : setError(`Missing .gaia workspace: ${workspace.path}`)),
          },
          h("span", { text: workspace.name }),
          h("small", {}, PathText(workspace.path)),
        ),
      ),
    ),
    h("button", { class: "nav-action", onclick: addWorkspace, text: "+ add workspace" }),
    h("div", { class: "nav-title", text: "rooms" }),
    RoomTree(),
    state.snapshot ? h("button", { class: "nav-action", onclick: addRoom, text: "+ add room" }) : null,
    h("div", { class: "spacer" }),
    h("button", { class: "nav-action", onclick: () => ((state.settingsOpen = true), render()), text: "global settings" }),
  );
}

// The rooms list is a recursive tree: a summon's child room nests under its
// parent (via room.parentRoomId) and is collapsed by default behind a twisty.
// Nesting is unbounded — grandchildren summon their own children.
function RoomTree() {
  const rooms = state.snapshot?.rooms ?? [{ id: "no room", path: "select a workspace", isCurrent: true }];
  const ids = new Set(rooms.map((room) => room.id));
  const childrenOf = new Map();
  for (const room of rooms) {
    // Treat a child whose parent isn't present as top-level, so nothing is lost.
    const parent = room.parentRoomId && ids.has(room.parentRoomId) ? room.parentRoomId : null;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(room);
  }
  return h("div", { class: "room-tree" }, (childrenOf.get(null) ?? []).map((room) => RoomNode(room, childrenOf, 0)));
}

function RoomNode(room, childrenOf, depth) {
  const kids = childrenOf.get(room.id) ?? [];
  const expanded = state.expandedRooms.has(room.id);
  const toggle = (event) => {
    event.stopPropagation();
    if (expanded) state.expandedRooms.delete(room.id);
    else state.expandedRooms.add(room.id);
    render();
  };
  return h(
    "div",
    { class: "room-node" },
    h(
      "div",
      { class: `room-row ${room.isCurrent ? "active" : ""}`, style: depth ? `padding-left:${depth * 14}px` : null },
      kids.length > 0
        ? h("button", { class: `room-twisty ${expanded ? "open" : ""}`, title: expanded ? "collapse" : "expand", onclick: toggle, text: expanded ? "▾" : "▸" })
        : h("span", { class: "room-twisty leaf" }),
      h(
        "button",
        {
          class: `nav-item room-item ${room.isCurrent ? "active" : ""}`,
          title: room.path,
          onclick: room.isCurrent || !state.snapshot ? undefined : () => selectRoom(state.snapshot.workspace.id, room.id),
        },
        h("span", { class: "room-label" }, room.running ? h("span", { class: "room-dot running", title: "summon running" }) : null, h("span", { text: room.id })),
        h("small", {}, PathText(room.path)),
      ),
    ),
    kids.length > 0 && expanded ? h("div", { class: "room-children" }, kids.map((kid) => RoomNode(kid, childrenOf, depth + 1))) : null,
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
    h("div", {
      class: state.voice || state.voiceStatusText ? "status on-call" : "status",
      text: state.voiceStatusText
        ? state.voiceStatusText
        : snapshot
          ? `${state.voice ? `on call @${state.voice.agentId}` : `@${snapshot.workspace.defaultAgent}`}`
          : "idle",
    }),
  );
}

// The signature: a spaceship-style powerline status line. Every segment is one
// fact about the session; arrows are pure CSS so no Nerd Font is required.
function StatusBar() {
  const snapshot = state.snapshot;
  const segs = [];
  if (snapshot) {
    const runningAgents = (snapshot.agents ?? []).filter((agent) => agent.status === "running").length;
    const runningRooms = (snapshot.rooms ?? []).filter((room) => room.running).length;
    const running = runningAgents + runningRooms;
    segs.push({ text: snapshot.workspace.name, cls: "seg-head", title: snapshot.workspace.rootDir });
    segs.push({ text: `⊞ ${snapshot.room.id}`, cls: "seg-a", title: "active room" });
    segs.push({ text: `${snapshot.rooms?.length ?? 0} rooms`, cls: "seg-b" });
    segs.push({
      text: running ? `● ${running} running` : "○ idle",
      cls: running ? "seg-run on" : "seg-run",
      title: "running agents + summons",
    });
    if (state.voice) segs.push({ text: `🎙 @${state.voice.agentId}`, cls: "seg-voice", title: "on a voice call" });
  } else {
    segs.push({ text: "no workspace", cls: "seg-head" });
  }
  segs.push({ spacer: true });
  const theme = themeById(currentThemeId());
  segs.push({ text: `◈ ${theme.name}`, cls: "seg-theme", title: "themes (Alt+T)", onclick: openThemePalette });
  segs.push({ text: clockText(), cls: "seg-clock", id: "statusClock" });
  segs.push({ text: "^T new · ^B panes", cls: "seg-keys", title: "Ctrl+T new room · Ctrl+B/G toggle panes" });

  return h(
    "footer",
    { class: "statusbar" },
    segs.map((seg) =>
      seg.spacer
        ? h("div", { class: "seg spacer" })
        : h(seg.onclick ? "button" : "div", {
            class: `seg ${seg.cls}`,
            id: seg.id ?? null,
            title: seg.title ?? null,
            text: seg.text,
            onclick: seg.onclick ?? null,
          }),
    ),
  );
}

export function clockText() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// Omarchy-style theme palette. Hover previews live (instant recolour, no
// re-render); click commits; Esc or backdrop cancels back to where you were.
let themeCommitted = null;

export function openThemePalette() {
  themeCommitted = currentThemeId();
  state.themePaletteOpen = true;
  render();
}

export function closeThemePalette(commit) {
  if (!commit && themeCommitted) applyTheme(themeCommitted);
  state.themePaletteOpen = false;
  themeCommitted = null;
  render();
}

function ThemePalette() {
  return h(
    "div",
    {
      class: "palette-backdrop",
      onclick: (event) => {
        if (event.target === event.currentTarget) closeThemePalette(false);
      },
    },
    h(
      "div",
      { class: "palette" },
      h(
        "div",
        { class: "palette-head" },
        h("strong", { text: "themes" }),
        h("small", { text: "hover to preview · click to apply · esc to cancel" }),
      ),
      h(
        "div",
        { class: "palette-grid" },
        THEMES.map((theme) =>
          h(
            "button",
            {
              class: `swatch ${theme.id === currentThemeId() ? "active" : ""}`,
              style: `--sw-bg:${theme.bg};--sw-border:${theme.border}`,
              onmouseenter: () => applyTheme(theme.id),
              onclick: () => {
                applyTheme(theme.id);
                themeCommitted = theme.id;
                closeThemePalette(true);
              },
            },
            h(
              "span",
              { class: "sw-preview", style: `background:${theme.bg2}` },
              h("span", { class: "sw-dot", style: `background:${theme.accent}` }),
              h("span", { class: "sw-dot", style: `background:${theme.accent2}` }),
              h("span", { class: "sw-dot", style: `background:${theme.good}` }),
              h("span", { class: "sw-dot", style: `background:${theme.danger}` }),
            ),
            h("span", { class: "sw-name", text: theme.name }),
          ),
        ),
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
      agents.map((agent) => {
        const onCall = state.voice?.agentId === agent.id;
        const connecting = state.voicePendingAgentId === agent.id;
        const roles = agent.roles ?? [];
        return h(
          "div",
          { class: `agent-row ${onCall ? "on-call" : ""} ${agent.status === "running" ? "running" : ""} ${agent.activeRole ? "has-role" : ""}` },
          h(
            "button",
            { class: "agent-main", title: `open @${agent.id} settings`, onclick: () => void openAgentSettings(agent.id) },
            h("span", { class: `dot ${agent.status}` }),
            h("strong", { text: `${agent.icon} @${agent.id}` }),
            h("small", {
              text: [agent.isDefault ? "main" : "", agent.status === "running" ? "running" : "", agent.voice ? `voice:${agent.voice}` : "", agent.modelLabel]
                .filter(Boolean)
                .join(" / "),
            }),
          ),
          roles.length > 0
            ? h(
                "select",
                {
                  class: `role-select ${agent.activeRole ? "active" : ""}`,
                  title: `role for @${agent.id}`,
                  onchange: (event) => void setAgentRole(agent.id, event.target.value),
                },
                h("option", { value: "none", text: "— role —", selected: !agent.activeRole }),
                roles.map((roleName) => h("option", { value: roleName, text: roleName, selected: roleName === agent.activeRole })),
              )
            : null,
          h("button", {
            class: `main-button ${agent.isDefault ? "active" : ""}`,
            title: agent.isDefault ? `@${agent.id} is the main agent` : `make @${agent.id} the main agent`,
            disabled: agent.isDefault,
            onclick: () => void setDefaultAgent(agent.id),
            text: agent.isDefault ? "★" : "☆",
          }),
          h("button", {
            class: `call-button ${onCall ? "active" : ""}`,
            title: onCall ? `hang up @${agent.id}` : `start voice call with @${agent.id}`,
            disabled: connecting || (Boolean(state.voice) && !onCall),
            onclick: () => void toggleCall(agent.id),
            text: connecting ? "..." : onCall ? "⏹" : "📞",
          }),
        );
      }),
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

// Streaming deltas arrive far faster than the screen refreshes; coalesce
// transcript rebuilds to one per animation frame.
let transcriptRenderQueued = false;

// True when the transcript is scrolled to (or near) the bottom, so streaming
// output keeps it pinned but reading scrollback is never yanked away. Pass the
// node when you already hold it to skip a redundant querySelector + reflow.
function transcriptAtBottom(target) {
  const el = target ?? document.querySelector("#transcript");
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}

export function renderTranscriptOnly() {
  if (transcriptRenderQueued) return;
  transcriptRenderQueued = true;
  requestAnimationFrame(() => {
    transcriptRenderQueued = false;
    const target = document.querySelector("#transcript");
    if (!target) {
      render();
      return;
    }
    const stick = transcriptAtBottom(target);
    target.replaceWith(Transcript());
    if (stick) document.querySelector("#transcript")?.scrollTo({ top: 100000 });
  });
}

// Side panels that own their own scroll position. A full rebuild replaces these
// nodes, so we snapshot their scrollTop before and restore it after — otherwise
// the panel snaps to the top on every SSE event (e.g. while a swarm streams).
const SCROLL_KEEP = [".right", ".sidebar"];

// Full re-renders are coalesced to one per animation frame. Without this, a
// swarm of summons streaming at once triggers thousands of full-DOM rebuilds
// and locks the main thread ("Page Unresponsive").
let renderQueued = false;

export function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderNow();
  });
}

function renderNow() {
  const root = document.querySelector("#app");
  if (!root) return;
  const shouldKeepComposerFocus = document.activeElement === document.querySelector(".command-input") || document.activeElement === document.body;
  const stick = transcriptAtBottom();
  const scroll = SCROLL_KEEP.map((selector) => [selector, document.querySelector(selector)?.scrollTop ?? 0]);
  root.replaceChildren(App());
  for (const [selector, top] of scroll) {
    if (top) {
      const el = document.querySelector(selector);
      if (el) el.scrollTop = top;
    }
  }
  if (stick) document.querySelector("#transcript")?.scrollTo({ top: 100000 });
  if (shouldKeepComposerFocus && !state.settingsOpen) focusComposer();
}
