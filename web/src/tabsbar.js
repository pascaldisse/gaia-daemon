// The tmux window bar. Rooms are windows; the active one is highlighted, each
// carries its jump number (Alt+N), drags to reorder, and closes from the
// working set without deleting the room.
import { addRoom, closeRoomTab, selectRoom } from "./actions.js";
import { dockBack, tearOff } from "./chrome.js";
import { $, h } from "./dom.js";
import { isMainWindow, isNative } from "./native.js";
import { markDirty, registerRegion } from "./render.js";
import { state } from "./state.js";
import { moveTab, visibleTabs } from "./tabs.js";

/** @typedef {import("./types.js").RoomSummary} RoomSummary */

// True once a tab-drag ended on a sibling tab (a reorder drop). A drag that ends
// anywhere else — including truly outside the window — leaves this false and is
// treated as a tear-off. This is the reliable signal in a webview, where a drop
// outside the window fires no drop event and dragend screen coords are unusable
// (WebKit reports 0).
let droppedOnTab = false;

function renderTabs() {
  const bar = $("#tabbar");
  if (!bar) return;
  const snapshot = state.snapshot;
  const wsId = snapshot?.workspace.id;
  const currentId = snapshot?.room?.id;
  const tabs = visibleTabs(snapshot);
  // Torn-off window: a leading button to merge this chat back into the main window
  // as a tab (the reliable path; drag-window-onto-tabbar is the fiddly follow-up).
  const leading =
    isNative() && !isMainWindow()
      ? [h("button", { class: "chrome-btn", title: "merge back into the main window (⌘⇧M)", onclick: () => dockBack(), text: "⇤" })]
      : [];
  bar.replaceChildren(
    ...leading,
    h("button", {
      class: "chrome-btn",
      title: state.sidebarCollapsed ? "show sessions" : "hide sessions",
      onclick: () => {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        markDirty("layout", "tabs");
      },
      text: state.sidebarCollapsed ? "▸" : "◂",
    }),
    h("div", { class: "tab-brand" }, h("span", { class: "tab-logo", text: "◆" }), h("span", { text: "GAIA" })),
    h(
      "div",
      { class: "tab-strip" },
      tabs.map((room, index) => Tab(room, index + 1, room.id === currentId, wsId)),
      snapshot ? h("button", { class: "tab-new", title: "new room (⌘T)", onclick: () => void addRoom(), text: "+" }) : null,
    ),
    h("div", { class: "tab-spacer" }),
    h("button", {
      class: "chrome-btn",
      title: state.rightCollapsed ? "show room panel" : "hide room panel",
      onclick: () => {
        state.rightCollapsed = !state.rightCollapsed;
        markDirty("layout", "tabs");
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
        droppedOnTab = false;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          // WebKit needs drag data present or it may cancel the drag outright.
          try {
            event.dataTransfer.setData("text/plain", room.id);
          } catch {
            // some engines disallow setData here — harmless to skip.
          }
        }
      },
      ondragend: () => {
        const dragged = state.tabDragId;
        state.tabDragId = null;
        // Tear-off: a drag that did NOT end on a sibling tab (see droppedOnTab)
        // becomes its own native window — that chat, side panels collapsed. The
        // window opens offset from this one; precise drop coords aren't available
        // in a webview (WebKit reports 0 at dragend), and aren't needed.
        if (isNative() && dragged === room.id && wsId && !droppedOnTab) {
          const sx = window.screenX + 96;
          const sy = window.screenY + 72;
          if (tearOff(room.id, sx, sy)) {
            void closeRoomTab(room.id);
            return;
          }
        }
        markDirty("tabs");
      },
      ondragover: (event) => event.preventDefault(),
      ondrop: (event) => {
        event.preventDefault();
        droppedOnTab = true;
        if (state.tabDragId && wsId) moveTab(state.tabDragId, room.id, wsId);
        state.tabDragId = null;
        markDirty("tabs");
      },
      onclick: isActive || !wsId ? null : () => void selectRoom(wsId, room.id),
    },
    h("span", { class: "tab-num", text: String(number) }),
    room.running ? h("span", { class: "tab-dot" }) : null,
    room.incognito ? h("span", { class: "tab-incognito", title: "incognito — no memory", text: "🕶" }) : null,
    h("span", { class: "tab-name", text: room.title ?? room.id }),
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
