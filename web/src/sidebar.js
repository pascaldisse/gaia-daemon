// The sessions sidebar: workspaces list + the recursive rooms tree. A summon's
// child room nests under its parent (via room.parentRoomId) and is collapsed
// by default behind a twisty. Nesting is unbounded — grandchildren summon
// their own children.
import { addRoom, addWorkspace, deleteWorkspace, loadWorkspace, renameRoom, reorderWorkspaces, selectRoom, setRoomFavorite, setWorkspaceFavorite } from "./actions.js";
import { closeSidebarOverlay } from "./chrome.js";
import { $, h } from "./dom.js";
import { PathText } from "./links.js";
import { refreshAttention } from "./attention.js";
import { hapticArm, holdTouchScroll, isTouchPointer, LONG_PRESS_MS, releaseTouchScroll, TOUCH_SLOP } from "./press-drag.js";
import { markDirty, registerRegion, setError } from "./render.js";
import { openSearch } from "./search.js";
import { openSettings } from "./settings.js";
import {
  effectiveSidebarFocus,
  markRoomRead,
  markRoomUnread,
  persistRoomsCollapsed,
  persistRoomsFavoritesOnly,
  persistWorkspacesCollapsed,
  roomUnread,
  state,
  workspaceActivity,
} from "./state.js";

/** @typedef {import("./types.js").RoomSummary} RoomSummary */

// Workspace drag-to-reorder: POINTER events (not HTML5 drag-and-drop), same
// reason as the tab strip (tabsbar.js) — the native WKWebView shell fires no
// HTML5 dragend/drop with real coordinates. Vertical list, no tear-off.
/** @type {null | { workspaceId: string, startY: number, pointerId: number, el: HTMLElement, moved: boolean, dropIndex: number, touch: boolean, armed: boolean, timer: ReturnType<typeof setTimeout>|null }} */
let wsDrag = null;
// While a press is live the sidebar must NOT be rebuilt (same reasoning as
// tabsbar's dragActive): the captured node + its imperative `.dragging` class
// + the drop indicator all live in the current DOM.
let wsDragActive = false;
/** The accent caret showing where a reorder drop will land. @type {HTMLElement|null} */
let wsDropIndicator = null;
const WS_DRAG_THRESHOLD = 6;

function renderSidebar() {
  const nav = $("#sidebar");
  if (!nav) return;
  if (wsDragActive) return; // a live workspace drag owns the list DOM — don't rebuild it
  const scrollTop = nav.scrollTop;
  /** @type {(HTMLElement|null)[]} */
  const children = [
    h("button", {
      class: "nav-search",
      title: "search across all chats (⌘K)",
      onclick: () => openSearch("chatwide"),
      text: "🔍 search chats",
    }),
    h(
      "div",
      { class: "nav-title nav-title-row" },
      h("span", { text: "workspaces" }),
      h(
        "span",
        { class: "nav-title-actions" },
        // Minimise the whole workspace list — a long history of workspaces
        // otherwise pushes "rooms" (and everything under it) off-screen.
        h("button", {
          class: "nav-title-add nav-title-collapse",
          title: state.workspacesCollapsed ? "show workspaces" : "collapse workspaces",
          onclick: () => {
            state.workspacesCollapsed = !state.workspacesCollapsed;
            persistWorkspacesCollapsed();
            markDirty("sidebar");
          },
          text: state.workspacesCollapsed ? "▸" : "▾",
        }),
        // Inline + next to the header, same UI element as "rooms"'s new-room +
        // — one click from the top, no separate full-width button buried under
        // the workspace list.
        h("button", { class: "nav-title-add", title: "add workspace", onclick: () => void addWorkspace(), text: "+" }),
      ),
    ),
    state.workspacesCollapsed ? null : WorkspaceList(),
    WorkspaceContextMenu(),
    h(
      "div",
      { class: "nav-title nav-title-row" },
      h("span", { text: "rooms" }),
      // Inline + next to the header, so a new room is one click from the top —
      // not a button buried under the whole (possibly 100-chat) room list.
      state.snapshot
        ? h(
            "span",
            { class: "nav-title-actions" },
            // Same minimise affordance as workspaces above — collapses the
            // whole room tree behind the header.
            h("button", {
              class: "nav-title-add nav-title-collapse",
              title: state.roomsCollapsed ? "show rooms" : "collapse rooms",
              onclick: () => {
                state.roomsCollapsed = !state.roomsCollapsed;
                persistRoomsCollapsed();
                markDirty("sidebar");
              },
              text: state.roomsCollapsed ? "▸" : "▾",
            }),
            h("button", {
              class: `nav-title-add ${state.roomsFavoritesOnly ? "active" : ""}`,
              title: state.roomsFavoritesOnly ? "show all rooms" : "show favorites only",
              onclick: () => {
                state.roomsFavoritesOnly = !state.roomsFavoritesOnly;
                persistRoomsFavoritesOnly();
                markDirty("sidebar");
              },
              text: "★",
            }),
            h("button", { class: "nav-title-add", title: "new room (Ctrl+T) · ⌥-click = incognito 🕶", onclick: (/** @type {MouseEvent} */ e) => void addRoom({ incognito: e.altKey }), text: "+" }),
          )
        : null,
    ),
    state.roomsCollapsed ? null : RoomTree(),
    RoomContextMenu(),
    h("div", { class: "spacer" }),
    h("button", { class: "nav-action", onclick: () => openSettings(), text: "settings" }),
  ];
  nav.replaceChildren(...children.filter((child) => child !== null));
  if (scrollTop) nav.scrollTop = scrollTop;
}

// How many workspaces the sidebar list renders before "show more" — mirrors
// ROOMS_CHUNK below: a long-lived install accumulates dozens of workspaces,
// and an unpaginated list buries the rooms section under them (the bug this
// fixes). The current workspace is always kept visible even past the cap.
const WORKSPACES_CHUNK = 8;

/**
 * Star + running/unread-dot, each in its own fixed-width slot so a row's name
 * always starts at the same x whether or not either icon is present — the
 * icon appears/vanishes INSIDE its slot, the slot itself never does. Pass
 * `incognito` (room rows only; omit for workspace rows) to render a third
 * slot the same way, ordered star → dot → incognito → name.
 * @param {{favorite?: boolean, running?: boolean, unread?: boolean, incognito?: boolean, runningTitle?: string, unreadTitle?: string}} opts
 */
function StatusIcons({ favorite, running, unread, incognito, runningTitle = "agent running", unreadTitle = "unread messages" }) {
  return [
    h("span", { class: "room-icon-slot" }, favorite ? h("span", { class: "room-star", title: "favorite", text: "★" }) : null),
    h(
      "span",
      { class: "room-icon-slot" },
      running
        ? h("span", { class: "room-dot running", title: runningTitle })
        : unread
          ? h("span", { class: "room-dot unread", title: unreadTitle })
          : null,
    ),
    incognito === undefined
      ? null
      : h("span", { class: "room-icon-slot" }, incognito ? h("span", { class: "room-incognito", title: "incognito — no memory", text: "🕶" }) : null),
  ];
}

function WorkspaceList() {
  const currentId = state.snapshot?.workspace.id;
  const focus = effectiveSidebarFocus();
  const all = state.workspaces;
  const visible = all.slice(0, state.workspacesShown);
  const current = all.find((workspace) => workspace.id === currentId);
  if (current && !visible.includes(current)) visible.push(current);
  const remaining = all.length - visible.length;
  return h(
    "div",
    { class: "workspace-list" },
    visible.map((workspace) => {
      // Roll the workspace's rooms up to one dot so activity in a workspace
      // you're NOT viewing is still visible: green (pulsing) while any room in
      // it has an agent running, else accent while any has unread replies.
      const act = workspaceActivity(workspace.id);
      return h(
        "button",
        {
          class: `nav-item ws-item ${workspace.id === currentId ? "active" : ""} ${workspace.isInitialized ? "" : "muted"} ${focus?.kind === "workspace" && focus.id === workspace.id ? "focused" : ""}`,
          title: workspace.path,
          // The muted state means its .gaia is missing. Removing a workspace is
          // right-click -> "Remove workspace" ONLY — never the ⌘⌫/Del chord
          // (that's rooms only, see keys.js), so an accidental keypress can't
          // nuke a workspace. Open/select is driven from the pointer handlers
          // below (a press that never crosses the drag threshold), not onclick
          // — same split as the tab strip, so a real click and a reorder drag
          // never both fire off one gesture.
          onpointerdown: (/** @type {PointerEvent} */ event) => beginWorkspaceDrag(event, workspace.id),
          onpointermove: (/** @type {PointerEvent} */ event) => moveWorkspaceDrag(event),
          onpointerup: (/** @type {PointerEvent} */ event) => endWorkspaceDrag(event, workspace),
          onpointercancel: (/** @type {PointerEvent} */ event) => cancelWorkspaceDrag(event),
          oncontextmenu: (/** @type {MouseEvent} */ event) => {
            event.preventDefault();
            state.workspaceContextMenu = { workspaceId: workspace.id, x: event.clientX, y: event.clientY };
            markDirty("sidebar");
          },
        },
        h(
          "span",
          { class: "room-label" },
          ...StatusIcons({
            favorite: workspace.favorite,
            running: act.running,
            unread: act.unread,
            runningTitle: "agent running in this workspace",
            unreadTitle: "unread messages in this workspace",
          }),
          h("span", { class: act.unread && !act.running ? "room-name unread" : "room-name", text: workspace.name }),
        ),
        h("small", {}, PathText(workspace.path)),
      );
    }),
    remaining > 0
      ? h("button", {
          class: "nav-action rooms-more",
          text: `↓ show ${Math.min(WORKSPACES_CHUNK, remaining)} more (${remaining} left)`,
          onclick: () => {
            state.workspacesShown += WORKSPACES_CHUNK;
            markDirty("sidebar");
          },
        })
      : null,
  );
}

registerRegion("sidebar", renderSidebar);

// How many top-level rooms each "show more" click adds to the list. Same
// chunk size as WORKSPACES_CHUNK above, for consistency.
const ROOMS_CHUNK = 8;

function RoomTree() {
  /** @type {RoomSummary[]} */
  const rooms = state.snapshot?.rooms ?? [{ id: "no room", path: "select a workspace", isCurrent: true }];
  const ids = new Set(rooms.map((room) => room.id));
  /** @type {Map<string|null, RoomSummary[]>} */
  const childrenOf = new Map();
  for (const room of rooms) {
    // Treat a child whose parent isn't present as top-level, so nothing is lost.
    const parent = room.parentRoomId && ids.has(room.parentRoomId) ? room.parentRoomId : null;
    const list = childrenOf.get(parent);
    if (list) list.push(room);
    else childrenOf.set(parent, [room]);
  }
  // Rooms ARE chats: the daemon lists them latest-activity first, so render a
  // chunk at a time — a 100-chat history import must not flood the sidebar.
  const top = childrenOf.get(null) ?? [];
  const filteredTop = state.roomsFavoritesOnly ? top.filter((room) => room.favorite || hasFavoriteDescendant(room, childrenOf)) : top;
  const visible = filteredTop.slice(0, state.roomsShown);
  const current = top.find((room) => room.isCurrent);
  if (!state.roomsFavoritesOnly && current && !visible.includes(current)) visible.push(current);
  const remaining = filteredTop.length - visible.length;
  return h(
    "div",
    { class: "room-tree" },
    visible.map((room) => RoomNode(room, childrenOf, 0)),
    remaining > 0
      ? h("button", {
          class: "nav-action rooms-more",
          text: `↓ show ${Math.min(ROOMS_CHUNK, remaining)} more (${remaining} left)`,
          onclick: () => {
            state.roomsShown += ROOMS_CHUNK;
            markDirty("sidebar");
          },
        })
      : null,
  );
}

/**
 * @param {RoomSummary} room
 * @param {Map<string|null, RoomSummary[]>} childrenOf
 */
function hasFavoriteDescendant(room, childrenOf) {
  const stack = [...(childrenOf.get(room.id) ?? [])];
  const seen = new Set();
  while (stack.length > 0) {
    const kid = stack.pop();
    if (!kid || seen.has(kid.id)) continue;
    seen.add(kid.id);
    if (kid.favorite) return true;
    for (const grand of childrenOf.get(kid.id) ?? []) stack.push(grand);
  }
  return false;
}

/**
 * @param {RoomSummary} room
 * @param {Map<string|null, RoomSummary[]>} childrenOf
 */
function favoriteVisible(room, childrenOf) {
  return !state.roomsFavoritesOnly || room.favorite || hasFavoriteDescendant(room, childrenOf);
}

/**
 * Rolled-up LIVE-STATUS activity of a room's descendants (children,
 * grandchildren, …) so a COLLAPSED parent still surfaces a summon sub-room
 * that's currently running. Rendered in the row's right gutter — a different
 * position from the room's own left dot — to say the activity is down inside a
 * subroom, not here.
 *
 * Deliberately running-only, no unread rollup: every descendant here is a
 * summon sub-room (today, the only way a room gets a parent), and a summon's
 * unread state is meant to stay local to its own row (still visible once you
 * expand) rather than bubble up — the parent already gets its own single
 * unread mark from the summon's delivered result landing as new activity in
 * it. Rolling child unread up here too used to mean clicking into every one of
 * (possibly hundreds of) finished summons just to clear a redundant dot.
 * @param {RoomSummary} room
 * @param {Map<string|null, RoomSummary[]>} childrenOf
 * @returns {{running: boolean}}
 */
function descendantActivity(room, childrenOf) {
  let running = false;
  const stack = [...(childrenOf.get(room.id) ?? [])];
  const seen = new Set();
  while (stack.length > 0) {
    const kid = stack.pop();
    if (!kid || seen.has(kid.id)) continue;
    seen.add(kid.id);
    if (kid.running) running = true;
    for (const grand of childrenOf.get(kid.id) ?? []) stack.push(grand);
  }
  return { running };
}

/**
 * @param {RoomSummary} room
 * @param {Map<string|null, RoomSummary[]>} childrenOf
 * @param {number} depth
 * @returns {HTMLElement}
 */
function RoomNode(room, childrenOf, depth) {
  const kids = (childrenOf.get(room.id) ?? []).filter((kid) => favoriteVisible(kid, childrenOf));
  const expanded = state.expandedRooms.has(room.id);
  // A collapsed parent hides its subrooms, so bubble their RUNNING status up
  // here (unread deliberately does not bubble — see descendantActivity).
  const sub = kids.length > 0 && !expanded ? descendantActivity(room, childrenOf) : { running: false };
  /** @param {MouseEvent} event */
  const toggle = (event) => {
    event.stopPropagation();
    if (expanded) state.expandedRooms.delete(room.id);
    else state.expandedRooms.add(room.id);
    markDirty("sidebar");
  };
  const snapshot = state.snapshot;
  const focus = effectiveSidebarFocus();
  const focused = focus?.kind === "room" && focus.id === room.id;
  const label = room.title ?? room.id;
  return h(
    "div",
    { class: "room-node" },
    h(
      "div",
      { class: `room-row ${room.isCurrent ? "active" : ""}`, style: depth ? `padding-left:${depth * 14}px` : null },
      // The room button leads so every label starts at the same left edge; the
      // twisty trails on the right and never indents the names (a leaf keeps the
      // right gutter aligned for childless rooms).
      h(
        "button",
        {
          class: `nav-item room-item ${room.isCurrent ? "active" : ""} ${focused ? "focused" : ""}`,
          title: `${label} — ${room.path}`,
          // Clicking makes this the delete target (the ⌘⌫ / Del chord acts on
          // it) and opens it. Re-clicking the current room just re-targets it.
          onclick: !snapshot
            ? null
            : () => {
                state.roomContextMenu = null;
                state.sidebarFocus = { kind: "room", id: room.id };
                if (room.isCurrent) markRoomRead(snapshot.workspace.id, room.id, room.lastActivity ?? 0);
                if (!room.isCurrent) void selectRoom(snapshot.workspace.id, room.id);
                else markDirty("sidebar");
                closeSidebarOverlay();
              },
          oncontextmenu: snapshot
            ? (/** @type {MouseEvent} */ event) => {
                event.preventDefault();
                state.sidebarFocus = { kind: "room", id: room.id };
                state.roomContextMenu = { roomId: room.id, x: event.clientX, y: event.clientY };
                markDirty("sidebar");
              }
            : undefined,
          ondblclick: !snapshot
            ? null
            : (/** @type {MouseEvent} */ event) => {
                event.preventDefault();
                void renameRoom(room.id, label);
              },
        },
        h(
          "span",
          { class: "room-label" },
          ...StatusIcons({ favorite: room.favorite, running: room.running, unread: roomUnread(room), incognito: room.incognito }),
          h("span", { class: roomUnread(room) && !room.running ? "room-name unread" : "room-name", text: label }),
        ),
        h("small", {}, room.imported ? document.createTextNode(room.imported.slice(0, 10)) : PathText(room.path)),
      ),
      // Collapsed-subtree RUNNING status rolls up into the right gutter (distinct
      // from the room's own left dot) so a live summon sub-room is visible
      // without expanding. Unread does not roll up here (see descendantActivity):
      // a finished summon's own row still shows its dot once expanded, but the
      // parent's single unread mark comes only from its own new activity.
      sub.running ? h("span", { class: "room-subdot running", title: "a subroom has an agent running" }) : null,
      // No per-row delete button: deletion is the OS delete chord (⌘⌫ on macOS,
      // Del elsewhere) acting on the focused room — see keys.js.
      kids.length > 0
        ? h("button", { class: `room-twisty ${expanded ? "open" : ""}`, title: expanded ? "collapse" : "expand", onclick: toggle, text: expanded ? "▾" : "▸" })
        : h("span", { class: "room-twisty leaf" }),
    ),
    kids.length > 0 && expanded ? h("div", { class: "room-children" }, kids.map((kid) => RoomNode(kid, childrenOf, depth + 1))) : null,
  );
}

/** @returns {HTMLElement|null} */
function RoomContextMenu() {
  const snapshot = state.snapshot;
  const open = state.roomContextMenu;
  if (!snapshot || !open) return null;
  const room = snapshot.rooms.find((candidate) => candidate.id === open.roomId);
  if (!room) return null;
  const close = () => {
    state.roomContextMenu = null;
    markDirty("sidebar");
  };
  const label = room.title ?? room.id;
  return h(
    "div",
    { class: "room-menu", style: `left:${open.x}px;top:${open.y}px`, oncontextmenu: (/** @type {MouseEvent} */ event) => event.preventDefault() },
    h("div", { class: "room-menu-title", text: label }),
    h("button", {
      type: "button",
      onclick: () => {
        markRoomUnread(snapshot.workspace.id, room);
        refreshAttention();
        close();
      },
      text: "Mark as unread",
    }),
    roomUnread(room)
      ? h("button", {
          type: "button",
          onclick: () => {
            markRoomRead(snapshot.workspace.id, room.id, room.lastActivity ?? 0);
            refreshAttention();
            close();
          },
          text: "Mark as read",
        })
      : null,
    h("button", {
      type: "button",
      onclick: () => {
        close();
        void setRoomFavorite(room.id, !room.favorite);
      },
      text: room.favorite ? "Remove favorite" : "Add favorite",
    }),
  );
}

/** @returns {HTMLElement|null} */
function WorkspaceContextMenu() {
  const open = state.workspaceContextMenu;
  if (!open) return null;
  const workspace = state.workspaces.find((candidate) => candidate.id === open.workspaceId);
  if (!workspace) return null;
  const close = () => {
    state.workspaceContextMenu = null;
    markDirty("sidebar");
  };
  return h(
    "div",
    { class: "room-menu", style: `left:${open.x}px;top:${open.y}px`, oncontextmenu: (/** @type {MouseEvent} */ event) => event.preventDefault() },
    h("div", { class: "room-menu-title", text: workspace.name }),
    h("button", {
      type: "button",
      onclick: () => {
        close();
        void setWorkspaceFavorite(workspace.id, !workspace.favorite);
      },
      text: workspace.favorite ? "Remove favorite" : "Add favorite",
    }),
    h("button", {
      type: "button",
      class: "danger",
      onclick: () => {
        close();
        void deleteWorkspace(workspace.id);
      },
      text: "Remove workspace",
    }),
  );
}

/** @param {PointerEvent} event @param {string} workspaceId */
function beginWorkspaceDrag(event, workspaceId) {
  if (event.button !== 0) return;
  const el = /** @type {HTMLElement} */ (event.currentTarget);
  const touch = isTouchPointer(event);
  wsDrag = { workspaceId, startY: event.clientY, pointerId: event.pointerId, el, moved: false, dropIndex: -1, touch, armed: !touch, timer: null };
  // Touch: this list is also the scroll surface → arm only after a still long
  // press (press-drag.js); an earlier swipe stays a scroll.
  if (touch) {
    const d = wsDrag;
    d.timer = setTimeout(() => {
      if (wsDrag !== d) return;
      d.armed = true;
      d.timer = null;
      holdTouchScroll();
      hapticArm();
    }, LONG_PRESS_MS);
  }
  // Freeze the list for the whole press so an unrelated re-render (activity
  // dots, a background snapshot) can't detach the node we're about to capture.
  wsDragActive = true;
  try {
    el.setPointerCapture(event.pointerId);
  } catch {
    // capture unsupported — the drag still works while the pointer stays inside.
  }
}

/** @param {PointerEvent} event */
function moveWorkspaceDrag(event) {
  if (!wsDrag || event.pointerId !== wsDrag.pointerId) return;
  if (!wsDrag.armed) {
    if (Math.abs(event.clientY - wsDrag.startY) >= TOUCH_SLOP) abandonWorkspaceDrag();
    return;
  }
  if (!wsDrag.moved) {
    if (Math.abs(event.clientY - wsDrag.startY) < WS_DRAG_THRESHOLD) return;
    wsDrag.moved = true;
    wsDrag.el.classList.add("dragging");
  }
  updateWorkspaceDropTarget(event);
}

/** Where a release right now would land — the first OTHER item whose vertical
 *  centre sits below the pointer; past them all, append. dropIndex is measured
 *  against the list with the dragged item removed (what the splice below
 *  expects). @param {PointerEvent} event */
function updateWorkspaceDropTarget(event) {
  if (!wsDrag) return;
  const list = wsDrag.el.parentElement;
  if (!list) return;
  const rect = list.getBoundingClientRect();
  const siblings = /** @type {HTMLElement[]} */ ([...list.querySelectorAll(".ws-item")]).filter((item) => item !== wsDrag?.el);
  let index = siblings.length;
  let boundary = siblings.length ? siblings[siblings.length - 1].getBoundingClientRect().bottom : rect.top;
  for (let i = 0; i < siblings.length; i++) {
    const r = siblings[i].getBoundingClientRect();
    if (event.clientY < r.top + r.height / 2) {
      index = i;
      boundary = r.top;
      break;
    }
  }
  wsDrag.dropIndex = index;
  showWorkspaceDropIndicator(list, rect, boundary);
}

/** @param {PointerEvent} event @param {import("./types.js").WorkspaceRecord} workspace */
function endWorkspaceDrag(event, workspace) {
  if (!wsDrag || event.pointerId !== wsDrag.pointerId) return;
  const d = wsDrag;
  wsDrag = null;
  if (d.timer) clearTimeout(d.timer);
  releaseTouchScroll();
  try {
    d.el.releasePointerCapture(event.pointerId);
  } catch {
    // nothing captured — fine.
  }
  // A press that never crossed the threshold is a click → open the workspace.
  if (!d.moved) {
    cleanupWorkspaceDrag(d.el);
    state.sidebarFocus = { kind: "workspace", id: workspace.id };
    if (workspace.isInitialized) void loadWorkspace(workspace.id);
    else setError(`Missing .gaia workspace: ${workspace.path}`);
    markDirty("sidebar");
    return;
  }
  if (d.dropIndex >= 0) {
    const ids = state.workspaces.map((w) => w.id).filter((id) => id !== d.workspaceId);
    ids.splice(Math.max(0, Math.min(d.dropIndex, ids.length)), 0, d.workspaceId);
    // Optimistic local reorder for instant feedback; the server response (still
    // favorites-first, see WorkspaceRegistry.list) is the authority and
    // overwrites this the moment it lands.
    const byId = new Map(state.workspaces.map((w) => [w.id, w]));
    state.workspaces = ids.map((id) => byId.get(id)).filter((w) => w !== undefined);
    void reorderWorkspaces(ids);
  }
  cleanupWorkspaceDrag(d.el);
}

/** @param {PointerEvent} event */
function cancelWorkspaceDrag(event) {
  if (!wsDrag || event.pointerId !== wsDrag.pointerId) return;
  abandonWorkspaceDrag();
}

/** Hand the gesture back to the browser (touch scroll won, or pointercancel). */
function abandonWorkspaceDrag() {
  if (!wsDrag) return;
  const el = wsDrag.el;
  const pointerId = wsDrag.pointerId;
  if (wsDrag.timer) clearTimeout(wsDrag.timer);
  wsDrag = null;
  releaseTouchScroll();
  try {
    el.releasePointerCapture(pointerId);
  } catch {
    // nothing captured — fine.
  }
  cleanupWorkspaceDrag(el);
}

/** End-of-drag teardown: drop the indicator, clear the item's transient class,
 *  release the render guard, and re-render once. @param {HTMLElement} el */
function cleanupWorkspaceDrag(el) {
  wsDragActive = false;
  hideWorkspaceDropIndicator();
  el.classList.remove("dragging");
  markDirty("sidebar");
}

/** @param {HTMLElement} list @param {DOMRect} rect @param {number} clientY */
function showWorkspaceDropIndicator(list, rect, clientY) {
  if (!wsDropIndicator) {
    wsDropIndicator = document.createElement("div");
    wsDropIndicator.className = "workspace-drop-indicator";
  }
  if (wsDropIndicator.parentElement !== list) list.appendChild(wsDropIndicator);
  const y = clientY - rect.top + list.scrollTop;
  wsDropIndicator.style.top = `${Math.max(0, y - 1)}px`;
}

function hideWorkspaceDropIndicator() {
  wsDropIndicator?.remove();
}

window.addEventListener("click", (event) => {
  if (state.workspaceContextMenu && !(event.target instanceof HTMLElement && event.target.closest(".room-menu"))) {
    state.workspaceContextMenu = null;
    markDirty("sidebar");
  }
  if (!state.roomContextMenu) return;
  if (event.target instanceof HTMLElement && event.target.closest(".room-menu")) return;
  state.roomContextMenu = null;
  markDirty("sidebar");
});
