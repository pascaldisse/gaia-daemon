// The tmux window bar. Rooms are windows; the active one is highlighted, each
// carries its jump number (Alt+N), drags to reorder, and closes from the working
// set without deleting the room. Dragging a tab clear of the strip tears it into
// its own native window.
//
// The drag is built on POINTER events, not HTML5 drag-and-drop. In a WKWebView
// (the native shell) HTML5 dragend reports 0 for its coordinates and fires no
// drop when released outside the window — which is exactly why the old tear-off
// was unreliable. Pointer events with setPointerCapture report real coordinates
// for the whole gesture and keep firing even when the pointer leaves the window,
// so we get a trustworthy release point to place the torn-off window at.
import { addRoom, closeRoomTab, selectRoom } from "./actions.js";
import { tearOff } from "./chrome.js";
import { $, h } from "./dom.js";
import { isNative } from "./native.js";
import { markDirty, registerRegion } from "./render.js";
import { state } from "./state.js";
import { moveTabToIndex, visibleTabs } from "./tabs.js";

/** @typedef {import("./types.js").RoomSummary} RoomSummary */

// The live pointer-drag, or null. Module-scoped (one drag at a time) so the
// element handlers, the render guard, and the drop indicator all share it.
/** @type {null | { roomId: string, wsId: string, startX: number, startY: number, pointerId: number, el: HTMLElement, moved: boolean, tearing: boolean, dropIndex: number }} */
let drag = null;

// While a press is live the strip must NOT be rebuilt: the captured tab node, its
// imperative `.dragging` class, and the drop indicator all live in the current
// DOM, and an unrelated markDirty("tabs") (a task starting, a snapshot arriving)
// would blow them away and kill the pointer capture. Claimed on pointerdown (not
// on the move threshold) so even the pre-threshold window is protected; renderTabs
// bails while it's set, and end/cancel clears it and re-renders once.
let dragActive = false;

/** The accent caret showing where a reorder drop will land. @type {HTMLElement|null} */
let dropIndicator = null;

// Movement (px) before a press becomes a drag rather than a click.
const DRAG_THRESHOLD = 6;

function renderTabs() {
  const bar = $("#tabbar");
  if (!bar) return;
  if (dragActive) return; // a live drag owns the strip DOM — don't rebuild it
  const snapshot = state.snapshot;
  const wsId = snapshot?.workspace.id;
  const currentId = snapshot?.room?.id;
  const tabs = visibleTabs(snapshot);
  bar.replaceChildren(
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
  return h(
    "div",
    {
      class: `tab ${isActive ? "active" : ""} ${room.running ? "running" : ""}`,
      title: room.id,
      onpointerdown: (event) => beginDrag(event, room.id, wsId),
      onpointermove: (event) => moveDrag(event),
      onpointerup: (event) => endDrag(event),
      onpointercancel: (event) => cancelDrag(event),
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

/** @param {PointerEvent} event @param {string} roomId @param {string|undefined} wsId */
function beginDrag(event, roomId, wsId) {
  if (event.button !== 0 || !wsId) return;
  // A press on the × is a close, not a drag — leave it to the button's onclick.
  if (/** @type {HTMLElement} */ (event.target).closest(".tab-close")) return;
  const el = /** @type {HTMLElement} */ (event.currentTarget);
  drag = { roomId, wsId, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId, el, moved: false, tearing: false, dropIndex: -1 };
  // Freeze the strip for the whole press so an unrelated re-render can't detach
  // the node we're about to capture (cleared in end/cancel).
  dragActive = true;
  // Capture so pointermove/up keep coming to THIS element for the whole gesture,
  // even once the pointer leaves the strip (or the window).
  try {
    el.setPointerCapture(event.pointerId);
  } catch {
    // capture unsupported — the drag still works while the pointer stays inside.
  }
}

/** @param {PointerEvent} event */
function moveDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.moved) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
    drag.moved = true;
    drag.el.classList.add("dragging");
  }
  updateDropTarget(event);
}

/** Decide where a release right now would land — a reorder slot (show the caret)
 *  or a tear-off (mark the tab, hide the caret) — and reflect it live.
 *  @param {PointerEvent} event */
function updateDropTarget(event) {
  if (!drag) return;
  const strip = drag.el.parentElement;
  if (!strip) return;
  const rect = strip.getBoundingClientRect();
  // Tear-off intent: the pointer has left the strip's band — dragged down into
  // the chat, above the bar, or well off either end. Native only (a plain
  // browser has no windows to tear into, so a far drag just reorders).
  const tearing =
    isNative() &&
    (event.clientY > rect.bottom + 32 ||
      event.clientY < rect.top - 20 ||
      event.clientX < rect.left - 44 ||
      event.clientX > rect.right + 44);
  drag.tearing = tearing;
  drag.el.classList.toggle("tearing", tearing);
  if (tearing) {
    drag.dropIndex = -1;
    hideDropIndicator();
    return;
  }
  // Reorder slot: the first OTHER tab whose horizontal centre sits right of the
  // pointer — insert before it; past them all, append. dropIndex is measured
  // against the list with the dragged tab removed (what moveTabToIndex expects).
  const siblings = /** @type {HTMLElement[]} */ ([...strip.querySelectorAll(".tab")]).filter((tab) => tab !== drag?.el);
  let index = siblings.length;
  let boundary = siblings.length ? siblings[siblings.length - 1].getBoundingClientRect().right : rect.left;
  for (let i = 0; i < siblings.length; i++) {
    const r = siblings[i].getBoundingClientRect();
    if (event.clientX < r.left + r.width / 2) {
      index = i;
      boundary = r.left;
      break;
    }
  }
  drag.dropIndex = index;
  showDropIndicator(strip, rect, boundary);
}

/** @param {PointerEvent} event */
function endDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  try {
    d.el.releasePointerCapture(event.pointerId);
  } catch {
    // nothing captured — fine.
  }
  // A press that never crossed the threshold is a click → open the room.
  if (!d.moved) {
    cleanupDrag(d.el);
    if (d.roomId !== state.snapshot?.room?.id) void selectRoom(d.wsId, d.roomId);
    return;
  }
  if (d.tearing) {
    // Real release point (pointer events report it, unlike HTML5 dragend) → the
    // torn window opens under the cursor, offset so its title bar lands where the
    // tab was rather than its top-left corner.
    const sx = window.screenX + event.clientX - 48;
    const sy = window.screenY + event.clientY - 12;
    if (tearOff(d.roomId, sx, sy)) {
      cleanupDrag(d.el);
      void closeRoomTab(d.roomId);
      return;
    }
  }
  if (d.dropIndex >= 0) moveTabToIndex(d.roomId, d.dropIndex, d.wsId);
  cleanupDrag(d.el);
}

/** @param {PointerEvent} event */
function cancelDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const el = drag.el;
  drag = null;
  cleanupDrag(el);
}

/** End-of-drag teardown: drop the indicator, clear the tab's transient classes,
 *  release the render guard, and re-render once to reflect the committed order.
 *  @param {HTMLElement} el */
function cleanupDrag(el) {
  dragActive = false;
  hideDropIndicator();
  el.classList.remove("dragging", "tearing");
  markDirty("tabs");
}

/** @param {HTMLElement} strip @param {DOMRect} rect @param {number} clientX */
function showDropIndicator(strip, rect, clientX) {
  if (!dropIndicator) {
    dropIndicator = document.createElement("div");
    dropIndicator.className = "tab-drop-indicator";
  }
  if (dropIndicator.parentElement !== strip) strip.appendChild(dropIndicator);
  // The strip scrolls horizontally; convert the viewport x to strip-content x so
  // the caret tracks the boundary even when the strip is scrolled.
  const x = clientX - rect.left + strip.scrollLeft;
  dropIndicator.style.left = `${Math.max(0, x - 1)}px`;
}

function hideDropIndicator() {
  dropIndicator?.remove();
}
