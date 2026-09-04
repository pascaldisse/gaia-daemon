// The sessions sidebar: a Finder-style Favorites section (pinned workspaces +
// rooms, mixed and freely reorderable) above the workspaces list + the
// recursive rooms tree. A summon's child room nests under its parent (via
// room.parentRoomId) and is collapsed by default behind a twisty. Nesting is
// unbounded — grandchildren summon their own children.
import { addRoom, addWorkspace, deleteWorkspace, loadWorkspace, renameRoom, reorderRooms, reorderWorkspaces, selectRoom, setRoomFavorite, setWorkspaceFavorite } from "./actions.js";
import { UI } from "./glyphs.js";
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
  markWorkspaceRead,
  markRoomUnread,
  persistFavoritesOrder,
  persistRoomsCollapsed,
  persistRoomsFavoritesOnly,
  persistWorkspacesCollapsed,
  roomUnread,
  state,
  workspaceActivity,
} from "./state.js";

/** @typedef {import("./types.js").RoomSummary} RoomSummary */
/** @typedef {import("./types.js").WorkspaceRecord} WorkspaceRecord */
/** @typedef {"workspace"|"room"|"favorite"} DragKind */

// Sidebar drag-to-reorder: POINTER events (not HTML5 drag-and-drop), same
// reason as the tab strip (tabsbar.js) — the native WKWebView shell fires no
// HTML5 dragend/drop with real coordinates. ONE shared drag controller drives
// all three reorderable lists (favorites / workspaces / top-level rooms): a
// workspace or top-level room row can ALSO be dropped onto the favorites
// section — that sets favorite:true, the alternative to right-click "Add
// favorite" — but a room can never be dropped onto the workspaces section
// (favorites and its own list only). Vertical lists, no tear-off.
/** @type {null | { kind: DragKind, id: string, favKind: "workspace"|"room", startY: number, pointerId: number, el: HTMLElement, moved: boolean, dropIndex: number|null, zone: string|null, touch: boolean, armed: boolean, timer: ReturnType<typeof setTimeout>|null }} */
let drag = null;
// While a press is live the sidebar must NOT be rebuilt: the captured node +
// its imperative `.dragging` class + the drop indicator all live in the
// current DOM.
let dragActive = false;
/** The accent caret showing where a reorder drop will land. @type {HTMLElement|null} */
let dropIndicator = null;
const DRAG_THRESHOLD = 6;
/** Which section a kind reorders within when dropped on its own list. */
const HOME_ZONE = { workspace: "workspaces", room: "rooms", favorite: "favorites" };

function renderSidebar() {
  const nav = $("#sidebar");
  if (!nav) return;
  if (dragActive) return; // a live drag owns the list DOM — don't rebuild it
  const scrollTop = nav.scrollTop;
  /** @type {(HTMLElement|null)[]} */
  const children = [
    h("button", {
      class: "nav-search",
      title: "search across all chats (⌘K)",
      onclick: () => openSearch("chatwide"),
      text: `${UI.search} search chats`,
    }),
    FavoritesSection(),
    h(
      "div",
      { class: "workspaces-section" },
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
            text: state.workspacesCollapsed ? UI.twistyClosed : UI.twistyOpen,
          }),
          // Inline + next to the header, same UI element as "rooms"'s new-room +
          // — one click from the top, no separate full-width button buried under
          // the workspace list.
          h("button", { class: "nav-title-add", title: "add workspace", onclick: () => void addWorkspace(), text: "+" }),
        ),
      ),
      state.workspacesCollapsed ? null : WorkspaceList(),
      WorkspaceContextMenu(),
    ),
    h(
      "div",
      { class: "rooms-section" },
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
                text: state.roomsCollapsed ? UI.twistyClosed : UI.twistyOpen,
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
              h("button", { class: "nav-title-add", title: "new room (Ctrl+T) · ⌥-click = incognito ⊚", onclick: (/** @type {MouseEvent} */ e) => void addRoom({ incognito: e.altKey }), text: "+" }),
            )
          : null,
      ),
      state.roomsCollapsed ? null : RoomTree(),
      RoomContextMenu(),
    ),
    h(
      "div",
      { class: "side-bottom" },
      h("button", { class: "nav-action", onclick: () => openSettings(), text: "settings" }),
    ),
  ];
  nav.replaceChildren(...children.filter((child) => child !== null));
  if (scrollTop) nav.scrollTop = scrollTop;
}

// How many workspaces the sidebar list renders before "show more" — mirrors
// ROOMS_CHUNK below: a long-lived install accumulates dozens of workspaces,
// and an unpaginated list buries the rooms section under them (the bug this
// fixes). The current workspace is always kept visible even past the cap.
const WORKSPACES_CHUNK = 8;

/** @param {string | undefined} timestamp */
function localTime(timestamp) {
  const date = timestamp ? new Date(timestamp) : null;
  return date && !Number.isNaN(date.valueOf())
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : "";
}
/**
 * Running/unread-dot + optional incognito mark, each in its own fixed-width
 * slot so a row's name always starts at the same x whether or not an icon is
 * present — the icon appears/vanishes INSIDE its slot, the slot itself never
 * does. Pass `incognito` (room rows only; omit for workspace/favorite rows)
 * to render a second slot the same way. No favorite star here (removed
 * 2026-09 — favorite status now shows by an item's PRESENCE in the Favorites
 * section instead, Finder-style, not a per-row glyph).
 * @param {{running?: boolean, unread?: boolean, incognito?: boolean, runningTitle?: string, unreadTitle?: string}} opts
 */
function StatusIcons({ running, unread, incognito, runningTitle = "agent running", unreadTitle = "unread messages" }) {
  return [
    h(
      "span",
      { class: "room-icon-slot" },
      running
        ? h("span", { class: "room-dot running", title: runningTitle })
        : unread
          // v2-parity `.unread-dot` class rides alongside the existing
          // `.room-dot.unread` — same element, same behavior, native.css
          // adds the v2 hook without touching styles.css's own rule.
          ? h("span", { class: "room-dot unread unread-dot", title: unreadTitle })
          : null,
    ),
    incognito === undefined
      ? null
      : h("span", { class: "room-icon-slot" }, incognito ? h("span", { class: "room-incognito", title: "incognito — no memory", text: UI.incognito }) : null),
  ];
}

// --- favorites (Finder-style: pinned workspaces + rooms, mixed) -------------

/** @typedef {{kind: "workspace", workspace: WorkspaceRecord}|{kind: "room", room: RoomSummary}} FavoriteEntry */

/** @param {"workspace"|"room"} kind @param {string} id */
function favKey(kind, id) {
  return `${kind === "workspace" ? "ws" : "room"}:${id}`;
}
/** @param {FavoriteEntry} entry */
function favEntryId(entry) {
  return entry.kind === "workspace" ? entry.workspace.id : entry.room.id;
}

/**
 * Every favorited workspace (global) + every favorited room of the CURRENT
 * workspace (room lists are per-workspace; a favorited room in a workspace
 * you haven't opened this session isn't known client-side, so it can't
 * appear here until you visit it once), ordered by the user's own drag
 * order (state.favoritesOrder), newly-favorited items appended at the end.
 * @returns {FavoriteEntry[]}
 */
function favoriteEntries() {
  /** @type {FavoriteEntry[]} */
  const all = [
    ...state.workspaces.filter((workspace) => workspace.favorite).map((workspace) => /** @type {FavoriteEntry} */ ({ kind: "workspace", workspace })),
    ...(state.snapshot?.rooms ?? []).filter((room) => room.favorite).map((room) => /** @type {FavoriteEntry} */ ({ kind: "room", room })),
  ];
  const pos = new Map(state.favoritesOrder.map((key, index) => [key, index]));
  return all
    .map((entry, index) => ({ entry, index, order: pos.get(favKey(entry.kind, favEntryId(entry))) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ entry }) => entry);
}

function FavoritesSection() {
  const entries = favoriteEntries();
  return h(
    "div",
    { class: "favorites-section" },
    h("div", { class: "nav-title nav-title-row" }, h("span", { text: "favorites" })),
    h(
      "div",
      { class: "workspace-list favorites-list" },
      entries.length === 0
        ? h("div", { class: "favorites-empty", text: "Drag a workspace or room here, or right-click it → Add favorite." })
        : entries.map((entry) => FavoriteRow(entry)),
    ),
    FavoriteContextMenu(),
  );
}

/** @param {FavoriteEntry} entry */
function FavoriteRow(entry) {
  const id = favEntryId(entry);
  const name = entry.kind === "workspace" ? entry.workspace.name : (entry.room.title ?? entry.room.id);
  const path = entry.kind === "workspace" ? entry.workspace.path : entry.room.path;
  const active = entry.kind === "workspace" ? entry.workspace.id === state.snapshot?.workspace.id : entry.room.id === state.snapshot?.room.id;
  const act = entry.kind === "workspace" ? workspaceActivity(entry.workspace.id) : { running: entry.room.running, unread: roomUnread(entry.room) };
  const onClick = () => {
    if (entry.kind === "workspace") {
      state.sidebarFocus = { kind: "workspace", id: entry.workspace.id };
      if (entry.workspace.isInitialized) void loadWorkspace(entry.workspace.id);
      else setError(`Missing .gaia workspace: ${entry.workspace.path}`);
    } else {
      const snapshot = state.snapshot;
      if (!snapshot) return;
      state.roomContextMenu = null;
      state.sidebarFocus = { kind: "room", id: entry.room.id };
      if (entry.room.isCurrent) markRoomRead(snapshot.workspace.id, entry.room.id, entry.room.lastActivity ?? 0);
      else void selectRoom(snapshot.workspace.id, entry.room.id);
    }
    markDirty("sidebar");
    closeSidebarOverlay();
  };
  return h(
    "button",
    {
      class: `nav-item fav-item ${active ? "active" : ""}`,
      title: path,
      onpointerdown: (/** @type {PointerEvent} */ event) => beginDrag(event, "favorite", id, entry.kind),
      onpointermove: (/** @type {PointerEvent} */ event) => moveDrag(event),
      onpointerup: (/** @type {PointerEvent} */ event) => endDrag(event, onClick),
      onpointercancel: (/** @type {PointerEvent} */ event) => cancelDrag(event),
      oncontextmenu: (/** @type {MouseEvent} */ event) => {
        event.preventDefault();
        state.favoriteContextMenu = { kind: entry.kind, id, x: event.clientX, y: event.clientY };
        markDirty("sidebar");
      },
    },
    h(
      "span",
      { class: "room-label" },
      ...StatusIcons({ running: act.running, unread: act.unread }),
      h("span", { class: act.unread && !act.running ? "room-name unread" : "room-name", text: name }),
    ),
    h("small", {}, PathText(path)),
  );
}

/** @returns {HTMLElement|null} */
function FavoriteContextMenu() {
  const open = state.favoriteContextMenu;
  if (!open) return null;
  const name = open.kind === "workspace" ? state.workspaces.find((workspace) => workspace.id === open.id)?.name : (state.snapshot?.rooms.find((room) => room.id === open.id)?.title ?? open.id);
  if (name === undefined) return null;
  const close = () => {
    state.favoriteContextMenu = null;
    markDirty("sidebar");
  };
  return h(
    "div",
    { class: "room-menu", style: `left:${open.x}px;top:${open.y}px`, oncontextmenu: (/** @type {MouseEvent} */ event) => event.preventDefault() },
    h("div", { class: "room-menu-title", text: name }),
    h("button", {
      type: "button",
      onclick: () => {
        close();
        if (open.kind === "workspace") void setWorkspaceFavorite(open.id, false);
        else void setRoomFavorite(open.id, false);
      },
      text: "Remove favorite",
    }),
  );
}

// --- workspaces ---------------------------------------------------------------

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
      const onClick = () => {
        state.sidebarFocus = { kind: "workspace", id: workspace.id };
        if (workspace.isInitialized) void loadWorkspace(workspace.id);
        else setError(`Missing .gaia workspace: ${workspace.path}`);
        markDirty("sidebar");
      };
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
          // never both fire off one gesture. Dragged past the workspaces
          // section into Favorites pins it there (see endDrag/applyDrop).
          onpointerdown: (/** @type {PointerEvent} */ event) => beginDrag(event, "workspace", workspace.id),
          onpointermove: (/** @type {PointerEvent} */ event) => moveDrag(event),
          onpointerup: (/** @type {PointerEvent} */ event) => endDrag(event, onClick),
          onpointercancel: (/** @type {PointerEvent} */ event) => cancelDrag(event),
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

/** Every top-level room id (no parent, or a parent not present in this
 *  workspace's room list) in their current display order — the reorderable
 *  set (nested summon children aren't individually reorderable). @returns {string[]} */
function topLevelRoomIds() {
  const rooms = state.snapshot?.rooms ?? [];
  const ids = new Set(rooms.map((room) => room.id));
  return rooms.filter((room) => !(room.parentRoomId && ids.has(room.parentRoomId))).map((room) => room.id);
}

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
  // Rooms ARE chats: the daemon lists them latest-activity first (or the
  // user's own drag order — see reorderRooms), so render a chunk at a time —
  // a 100-chat history import must not flood the sidebar.
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
  // Only TOP-LEVEL rooms are individually draggable (reorder among siblings,
  // or drag into Favorites) — same scope as the server's reorderRooms (nested
  // summon children keep their parent-relative position, never reordered).
  const isTop = depth === 0;
  const since = localTime(room.runningSince);
  const runningTitle = room.running && since ? `running since ${since}` : "agent running";
  const onClick = () => {
    if (!snapshot) return;
    state.roomContextMenu = null;
    state.sidebarFocus = { kind: "room", id: room.id };
    if (room.isCurrent) markRoomRead(snapshot.workspace.id, room.id, room.lastActivity ?? 0);
    if (!room.isCurrent) void selectRoom(snapshot.workspace.id, room.id);
    else markDirty("sidebar");
    closeSidebarOverlay();
  };
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
          class: `nav-item room-item ${isTop ? "room-row-top" : ""} ${room.isCurrent ? "active" : ""} ${focused ? "focused" : ""}`,
          title: room.running && since ? runningTitle : `${label} — ${room.path}`,
          // Top-level rows use the same pointer press/drag split as workspace
          // rows (a press that never crosses the drag threshold = a click);
          // nested rows (not draggable) keep a plain click. Clicking also makes
          // this the delete target (the ⌘⌫ / Del chord acts on it).
          ...(isTop
            ? {
                onpointerdown: !snapshot ? null : (/** @type {PointerEvent} */ event) => beginDrag(event, "room", room.id),
                onpointermove: !snapshot ? null : (/** @type {PointerEvent} */ event) => moveDrag(event),
                onpointerup: !snapshot ? null : (/** @type {PointerEvent} */ event) => endDrag(event, onClick),
                onpointercancel: !snapshot ? null : (/** @type {PointerEvent} */ event) => cancelDrag(event),
              }
            : { onclick: !snapshot ? null : onClick }),

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
          ...StatusIcons({ running: room.running, unread: roomUnread(room), incognito: room.incognito, runningTitle }),
          h("span", { class: roomUnread(room) && !room.running ? "room-name unread" : "room-name", text: label }),
          depth && room.running && since ? h("small", { class: "room-running-since", text: `· since ${since}` }) : null,
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
    workspaceActivity(workspace.id).unread
      ? h("button", {
          type: "button",
          onclick: () => {
            markWorkspaceRead(workspace.id);
            refreshAttention();
            close();
          },
          text: "Mark all as read",
        })
      : null,
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

// --- shared drag controller (favorites / workspaces / top-level rooms) -----

/** @param {PointerEvent} event @param {DragKind} kind @param {string} id @param {"workspace"|"room"} [favKind] */
function beginDrag(event, kind, id, favKind = "workspace") {
  if (event.button !== 0) return;
  const el = /** @type {HTMLElement} */ (event.currentTarget);
  const touch = isTouchPointer(event);
  drag = { kind, id, favKind, startY: event.clientY, pointerId: event.pointerId, el, moved: false, dropIndex: -1, zone: HOME_ZONE[kind], touch, armed: !touch, timer: null };
  // Touch: these lists are also the scroll surface → arm only after a still
  // long press (press-drag.js); an earlier swipe stays a scroll.
  if (touch) {
    const d = drag;
    d.timer = setTimeout(() => {
      if (drag !== d) return;
      d.armed = true;
      d.timer = null;
      holdTouchScroll();
      hapticArm();
    }, LONG_PRESS_MS);
  }
  // Freeze the sidebar for the whole press so an unrelated re-render (activity
  // dots, a background snapshot) can't detach the node we're about to capture.
  dragActive = true;
  try {
    el.setPointerCapture(event.pointerId);
  } catch {
    // capture unsupported — the drag still works while the pointer stays inside.
  }
}

/** @param {PointerEvent} event */
function moveDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.armed) {
    if (Math.abs(event.clientY - drag.startY) >= TOUCH_SLOP) abandonDrag();
    return;
  }
  if (!drag.moved) {
    if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return;
    drag.moved = true;
    drag.el.classList.add("dragging");
  }
  updateDropTarget(event);
}

/** Which section (top-to-bottom: favorites, workspaces, rooms) a pointer
 *  sits over right now. A section spans from its own header down to the NEXT
 *  section's header (not just its own — possibly short/empty — list), so
 *  there's no dead gap between them. @param {number} clientY */
function sectionZoneAt(clientY) {
  const nav = $("#sidebar");
  if (!nav) return null;
  const rooms = nav.querySelector(".rooms-section");
  const workspaces = nav.querySelector(".workspaces-section");
  const favorites = nav.querySelector(".favorites-section");
  if (rooms && clientY >= rooms.getBoundingClientRect().top) return "rooms";
  if (workspaces && clientY >= workspaces.getBoundingClientRect().top) return "workspaces";
  if (favorites) return "favorites";
  return null;
}

/** @param {boolean} on */
function setFavoritesHighlight(on) {
  $("#sidebar")?.querySelector(".favorites-section")?.classList.toggle("favorites-drop-target", on);
}

/** @param {PointerEvent} event */
function updateDropTarget(event) {
  if (!drag) return;
  if (drag.kind === "favorite") {
    // A favorites-row only ever reorders within the favorites list itself —
    // dragging a favorite back OUT isn't a remove gesture here (use the
    // context menu's "Remove favorite"), so there's only one valid target.
    computeDropIndex(event, $("#sidebar")?.querySelector(".favorites-list") ?? null, ".fav-item");
    return;
  }
  const zone = sectionZoneAt(event.clientY);
  drag.zone = zone;
  if (zone === "favorites") {
    hideDropIndicator();
    setFavoritesHighlight(true);
    drag.dropIndex = -1; // sentinel: drop here = "make it a favorite", not a reorder
    return;
  }
  setFavoritesHighlight(false);
  if (zone !== HOME_ZONE[drag.kind]) {
    // Forbidden target (a room over the workspaces section, or vice versa) —
    // no indicator, drop does nothing.
    hideDropIndicator();
    drag.dropIndex = null;
    return;
  }
  if (drag.kind === "workspace") computeDropIndex(event, $("#sidebar")?.querySelector(".workspace-list") ?? null, ".ws-item");
  else computeDropIndex(event, $("#sidebar")?.querySelector(".room-tree") ?? null, ".room-row-top");
}

/** Where a release right now would land — the first OTHER item whose
 *  vertical centre sits below the pointer; past them all, append. Index is
 *  measured against the list with the dragged item removed (what applyDrop's
 *  splice expects). @param {PointerEvent} event @param {HTMLElement|null} list @param {string} selector */
function computeDropIndex(event, list, selector) {
  if (!drag) return;
  if (!list) {
    drag.dropIndex = null;
    return;
  }
  const rect = list.getBoundingClientRect();
  const siblings = /** @type {HTMLElement[]} */ ([...list.querySelectorAll(selector)]).filter((item) => item !== drag?.el);
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
  drag.dropIndex = index;
  showDropIndicator(list, rect, boundary);
}

/** @param {PointerEvent} event @param {() => void} onClick invoked when the press never crossed the drag threshold (a plain click) */
function endDrag(event, onClick) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  if (d.timer) clearTimeout(d.timer);
  releaseTouchScroll();
  try {
    d.el.releasePointerCapture(event.pointerId);
  } catch {
    // nothing captured — fine.
  }
  setFavoritesHighlight(false);
  if (!d.moved) {
    cleanupDrag(d.el);
    onClick();
    return;
  }
  applyDrop(d);
  cleanupDrag(d.el);
}

/** Commits a finished drag: reorder within its home list, favorite it (a
 *  workspace/room dropped on the Favorites section), reorder within
 *  Favorites, or — an invalid target — nothing at all (snaps back).
 *  @param {NonNullable<typeof drag>} d */
function applyDrop(d) {
  if (d.kind === "favorite") {
    if (d.dropIndex !== null && d.dropIndex >= 0) reorderFavorites(d.id, d.favKind, d.dropIndex);
    return;
  }
  if (d.zone === "favorites" && d.dropIndex === -1) {
    if (d.kind === "workspace") void setWorkspaceFavorite(d.id, true);
    else void setRoomFavorite(d.id, true);
    return;
  }
  if (d.zone !== HOME_ZONE[d.kind] || d.dropIndex === null || d.dropIndex < 0) return; // forbidden/no-op target
  if (d.kind === "workspace") {
    const ids = state.workspaces.map((workspace) => workspace.id).filter((id) => id !== d.id);
    ids.splice(Math.max(0, Math.min(d.dropIndex, ids.length)), 0, d.id);
    // Optimistic local reorder for instant feedback; the server response (still
    // favorites-first, see WorkspaceRegistry.list) is the authority and
    // overwrites this the moment it lands.
    const byId = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]));
    state.workspaces = ids.map((id) => byId.get(id)).filter((workspace) => workspace !== undefined);
    void reorderWorkspaces(ids);
  } else {
    const workspaceId = state.snapshot?.workspace.id;
    if (!workspaceId || !state.snapshot) return;
    const ids = topLevelRoomIds().filter((id) => id !== d.id);
    ids.splice(Math.max(0, Math.min(d.dropIndex, ids.length)), 0, d.id);
    // Optimistic local reorder: move the top-level rooms to their new order,
    // nested children keep their existing position relative to each other
    // (only their PARENT's bucket order can change, computed by RoomTree from
    // this same array on the next render — see topLevelRoomIds).
    const byId = new Map(state.snapshot.rooms.map((room) => [room.id, room]));
    const topSet = new Set(ids);
    const reorderedTop = ids.map((id) => byId.get(id)).filter((room) => room !== undefined);
    state.snapshot.rooms = [...reorderedTop, ...state.snapshot.rooms.filter((room) => !topSet.has(room.id))];
    void reorderRooms(workspaceId, ids);
  }
}

/** @param {string} id @param {"workspace"|"room"} favKind @param {number} dropIndex */
function reorderFavorites(id, favKind, dropIndex) {
  const draggedKey = favKey(favKind, id);
  const ids = favoriteEntries()
    .map((entry) => favKey(entry.kind, favEntryId(entry)))
    .filter((key) => key !== draggedKey);
  ids.splice(Math.max(0, Math.min(dropIndex, ids.length)), 0, draggedKey);
  state.favoritesOrder = ids;
  persistFavoritesOrder();
  markDirty("sidebar");
}

/** @param {PointerEvent} event */
function cancelDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  abandonDrag();
}

/** Hand the gesture back to the browser (touch scroll won, or pointercancel). */
function abandonDrag() {
  if (!drag) return;
  const el = drag.el;
  const pointerId = drag.pointerId;
  if (drag.timer) clearTimeout(drag.timer);
  drag = null;
  releaseTouchScroll();
  setFavoritesHighlight(false);
  try {
    el.releasePointerCapture(pointerId);
  } catch {
    // nothing captured — fine.
  }
  cleanupDrag(el);
}

/** End-of-drag teardown: drop the indicator, clear the item's transient class,
 *  release the render guard, and re-render once. @param {HTMLElement} el */
function cleanupDrag(el) {
  dragActive = false;
  hideDropIndicator();
  el.classList.remove("dragging");
  markDirty("sidebar");
}

/** @param {HTMLElement} list @param {DOMRect} rect @param {number} clientY */
function showDropIndicator(list, rect, clientY) {
  if (!dropIndicator) {
    dropIndicator = document.createElement("div");
    dropIndicator.className = "workspace-drop-indicator";
  }
  if (dropIndicator.parentElement !== list) list.appendChild(dropIndicator);
  const y = clientY - rect.top + list.scrollTop;
  dropIndicator.style.top = `${Math.max(0, y - 1)}px`;
}

function hideDropIndicator() {
  dropIndicator?.remove();
}

window.addEventListener("click", (event) => {
  if (state.workspaceContextMenu && !(event.target instanceof HTMLElement && event.target.closest(".room-menu"))) {
    state.workspaceContextMenu = null;
    markDirty("sidebar");
  }
  if (state.favoriteContextMenu && !(event.target instanceof HTMLElement && event.target.closest(".room-menu"))) {
    state.favoriteContextMenu = null;
    markDirty("sidebar");
  }
  if (!state.roomContextMenu) return;
  if (event.target instanceof HTMLElement && event.target.closest(".room-menu")) return;
  state.roomContextMenu = null;
  markDirty("sidebar");
});
