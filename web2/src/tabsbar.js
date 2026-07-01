// The tmux window bar. Rooms are windows; the active one is highlighted, each
// carries its jump number (Alt+N), drags to reorder, and closes from the
// working set without deleting the room.
import { addRoom, closeRoomTab, selectRoom } from "./actions.js";
import { $, h } from "./dom.js";
import { registerRegion, render } from "./render.js";
import { state } from "./state.js";
import { moveTab, visibleTabs } from "./tabs.js";

/** @typedef {import("./types.js").RoomSummary} RoomSummary */

function renderTabs() {
  const bar = $("#tabbar");
  if (!bar) return;
  const snapshot = state.snapshot;
  const wsId = snapshot?.workspace.id;
  const currentId = snapshot?.room?.id;
  const tabs = visibleTabs(snapshot);
  bar.replaceChildren(
    h("button", {
      class: "chrome-btn",
      title: state.sidebarCollapsed ? "show sessions (Ctrl+B)" : "hide sessions (Ctrl+B)",
      onclick: () => {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        render("layout", "tabs");
      },
      text: state.sidebarCollapsed ? "▸" : "◂",
    }),
    h("div", { class: "tab-brand" }, h("span", { class: "tab-logo", text: "◆" }), h("span", { text: "GAIA" })),
    h(
      "div",
      { class: "tab-strip" },
      tabs.map((room, index) => Tab(room, index + 1, room.id === currentId, wsId)),
      snapshot ? h("button", { class: "tab-new", title: "new room (Ctrl+T)", onclick: () => void addRoom(), text: "+" }) : null,
    ),
    h("div", { class: "tab-spacer" }),
    h("button", {
      class: "chrome-btn",
      title: state.rightCollapsed ? "show room panel (Ctrl+G)" : "hide room panel (Ctrl+G)",
      onclick: () => {
        state.rightCollapsed = !state.rightCollapsed;
        render("layout", "tabs");
      },
      text: "▥",
    }),
  );
}

registerRegion("tabs", renderTabs);

/**
 * @param {RoomSummary} room
 * @param {number} number
 * @param {boolean} isActive
 * @param {string|undefined} wsId
 */
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
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      },
      ondragend: () => {
        state.tabDragId = null;
        render("tabs");
      },
      ondragover: (event) => event.preventDefault(),
      ondrop: (event) => {
        event.preventDefault();
        if (state.tabDragId && wsId) moveTab(state.tabDragId, room.id, wsId);
        state.tabDragId = null;
        render("tabs");
      },
      onclick: isActive || !wsId ? null : () => void selectRoom(wsId, room.id),
    },
    h("span", { class: "tab-num", text: String(number) }),
    room.running ? h("span", { class: "tab-dot" }) : null,
    h("span", { class: "tab-name", text: room.id }),
    h("button", {
      class: "tab-close",
      title: "close tab (room is kept)",
      onclick: (event) => {
        event.stopPropagation();
        void closeRoomTab(room.id);
      },
      text: "×",
    }),
  );
}
