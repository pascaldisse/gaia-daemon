// The sessions sidebar: a Finder-style Favorites section (pinned workspaces +
// rooms, mixed and freely reorderable) above the workspaces list + the
// recursive rooms tree. A summon's child room nests under its parent (via
// room.parentRoomId) and is collapsed by default behind a twisty. Nesting is
// unbounded — grandchildren summon their own children.
import { addRoom, addWorkspace, deleteWorkspace, loadWorkspace, renameRoom, reorderRooms, reorderWorkspaces, selectRoom, setRoomFavorite, setWorkspaceFavorite } from "./actions.js";
import { navigation } from "./navigation.js";

import { UI } from "./glyphs.js";
import { closeSidebarOverlay } from "./chrome.js";
import { $, h } from "./dom.js";
import { PathText } from "./links.js";
import { refreshAttention } from "./attention.js";
import { openTab } from "./tabs.js";
import { hapticArm, holdTouchScroll, isTouchPointer, LONG_PRESS_MS, releaseTouchScroll, TOUCH_SLOP } from "./press-drag.js";
import { markDirty, registerRegion, setError } from "./render.js";
import { NodeCache, syncChildren } from "./reconcile.js";
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

/** Click-time selection; rendered isCurrent may precede a pending navigation.
 * @param {string} workspaceId @param {string} roomId */
export function roomIsSelected(workspaceId, roomId) {
  return !navigation.pending && state.snapshot?.workspace.id === workspaceId && state.snapshot.room.id === roomId;
}

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

// Keyed-node cache for the whole sidebar: section wrappers + list containers are
// persistent (never detached), every row is reused while its version stamp is
// unchanged. This is what keeps a hovered / focused / mid-press row alive across
// the activity ticks that fire markDirty("sidebar") constantly — only rows whose
// own visible/handler state changed rebuild. See reconcile.js.
const cache = new NodeCache();

function renderSidebar() {
  const nav = $("#sidebar");
  if (!nav) return;
  if (dragActive) return; // a live drag owns the list DOM — don't rebuild it
  const scrollTop = nav.scrollTop;
  cache.begin();
  // Keyed sync (never replaceChildren): persistent skeleton nodes stay put, only
  // changed rows rebuild — a hovered / focused / mid-press row survives the tick.
  const children = [
    cache.persistent("nav-search", () =>
      h("button", {
        class: "nav-search",
        title: "search across all chats (⌘K)",
        onclick: () => openSearch("chatwide"),
        text: `${UI.search} search chats`,
      }),
    ),
    FavoritesSection(),
    WorkspacesSection(),
    RoomsSection(),
    cache.persistent("side-bottom", () =>
      h("div", { class: "side-bottom" }, h("button", { class: "nav-action", onclick: () => openSettings(), text: "settings" })),
    ),
  ];
  syncChildren(nav, children);
  cache.prune();
  if (scrollTop) nav.scrollTop = scrollTop;
}

function WorkspacesSection() {
  const section = cache.persistent("workspaces-section", () => h("div", { class: "workspaces-section" }));
  const header = cache.keyed("workspaces-header", `c:${state.workspacesCollapsed}`, () =>
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
  );
  const list = state.workspacesCollapsed ? null : WorkspaceList();
  const menu = WorkspaceContextMenu();
  syncChildren(section, [header, ...(list ? [list] : []), ...(menu ? [menu] : [])]);
  return section;
}

function RoomsSection() {
  const section = cache.persistent("rooms-section", () => h("div", { class: "rooms-section" }));
  const header = cache.keyed("rooms-header", `s:${Boolean(state.snapshot)}|c:${state.roomsCollapsed}|f:${state.roomsFavoritesOnly}`, () =>
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
  );
  const tree = state.roomsCollapsed ? null : RoomTree();
  const menu = RoomContextMenu();
  syncChildren(section, [header, ...(tree ? [tree] : []), ...(menu ? [menu] : [])]);
  return section;
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

/** Cmd/Ctrl-click follows browser tab semantics on every platform.
 * @param {MouseEvent|PointerEvent} event */
function hasPrimaryModifier(event) {
  return event.metaKey || event.ctrlKey;
}
/** @param {import("./types.js").Snapshot} snapshot @param {RoomSummary} room @param {boolean} newTab */
function selectSidebarRoom(snapshot, room, newTab) {
  if (newTab) openTab(room.id, snapshot.workspace.id);
  if (newTab || !roomIsSelected(snapshot.workspace.id, room.id)) void selectRoom(snapshot.workspace.id, room.id);
  else markRoomRead(snapshot.workspace.id, room.id, room.lastActivity ?? 0);
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
  const section = cache.persistent("favorites-section", () => h("div", { class: "favorites-section" }));
  const header = cache.persistent("favorites-header", () => h("div", { class: "nav-title nav-title-row" }, h("span", { text: "favorites" })));
  const list = cache.persistent("favorites-list", () => h("div", { class: "workspace-list favorites-list" }));
  const entries = favoriteEntries();
  const rows =
    entries.length === 0
      ? [cache.persistent("favorites-empty", () => h("div", { class: "favorites-empty", text: "Drag a workspace or room here, or right-click it → Add favorite." }))]
      : entries.map((entry) => FavoriteRow(entry));
  syncChildren(list, rows);
  const menu = FavoriteContextMenu();
  syncChildren(section, [header, list, ...(menu ? [menu] : [])]);
  return section;
}

/** @param {FavoriteEntry} entry @returns {Node} */
function FavoriteRow(entry) {
  const snapshot = state.snapshot;
  const id = favEntryId(entry);
  const name = entry.kind === "workspace" ? entry.workspace.name : (entry.room.title ?? entry.room.id);
  const path = entry.kind === "workspace" ? entry.workspace.path : entry.room.path;
  const active = entry.kind === "workspace" ? entry.workspace.id === state.snapshot?.workspace.id : entry.room.id === state.snapshot?.room.id;
  const act = entry.kind === "workspace" ? workspaceActivity(entry.workspace.id) : { running: entry.room.running, unread: roomUnread(entry.room) };
  // Version = every field the row RENDERS or a handler READS, so an unchanged
  // version reuses the node (identity kept) and any change rebuilds it with
  // fresh handlers (never a stale closure). lastActivity/isInitialized feed
  // handlers (markRoomRead / loadWorkspace) though they aren't drawn.
  const lastActivity = entry.kind === "room" ? (entry.room.lastActivity ?? 0) : 0;
  const isInit = entry.kind === "workspace" ? entry.workspace.isInitialized : true;
  const version = [entry.kind, name, path, active, act.running, act.unread, isInit, lastActivity, Boolean(snapshot)].join("|");
  return cache.keyed(`fav:${favKey(entry.kind, id)}`, version, () => buildFavoriteRow(entry, id, snapshot, name, path, active, act));
}

/** @param {FavoriteEntry} entry @param {string} id @param {import("./types.js").Snapshot|null} snapshot @param {string} name @param {string} path @param {boolean} active @param {{running?: boolean, unread?: boolean}} act @returns {HTMLElement} */
function buildFavoriteRow(entry, id, snapshot, name, path, active, act) {
  /** @param {MouseEvent|PointerEvent} [event] */
  const onClick = (event) => {
    if (entry.kind === "workspace") {
      state.sidebarFocus = { kind: "workspace", id: entry.workspace.id };
      if (entry.workspace.isInitialized) void loadWorkspace(entry.workspace.id);
      else setError(`Missing .gaia workspace: ${entry.workspace.path}`);
    } else {
      if (!snapshot) return;
      state.roomContextMenu = null;
      state.sidebarFocus = { kind: "room", id: entry.room.id };
      selectSidebarRoom(snapshot, entry.room, Boolean(event && hasPrimaryModifier(event)));
    }
    markDirty("sidebar");
    closeSidebarOverlay();
  };
  /** @param {MouseEvent} event */
  const onAuxClick = (event) => {
    if (entry.kind !== "room" || event.button !== 1) return;
    const snapshot = state.snapshot;
    if (!snapshot) return;
    event.preventDefault();
    state.roomContextMenu = null;
    state.sidebarFocus = { kind: "room", id: entry.room.id };
    selectSidebarRoom(snapshot, entry.room, true);
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
      onauxclick: onAuxClick,
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
/** @returns {Node|null} */
function FavoriteContextMenu() {
  const open = state.favoriteContextMenu;
  if (!open) return null;
  const name = open.kind === "workspace" ? state.workspaces.find((workspace) => workspace.id === open.id)?.name : (state.snapshot?.rooms.find((room) => room.id === open.id)?.title ?? open.id);
  if (name === undefined) return null;
  const close = () => {
    state.favoriteContextMenu = null;
    markDirty("sidebar");
  };
  return cache.keyed("favorite-context-menu", `${open.kind}|${open.id}|${open.x}|${open.y}|${name}`, () => h(
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
  ));
}

// --- workspaces ---------------------------------------------------------------

function WorkspaceList() {
  const container = cache.persistent("workspace-list", () => h("div", { class: "workspace-list" }));
  const currentId = state.snapshot?.workspace.id;
  const focus = effectiveSidebarFocus();
  const all = state.workspaces;
  const visible = all.slice(0, state.workspacesShown);
  const current = all.find((workspace) => workspace.id === currentId);
  if (current && !visible.includes(current)) visible.push(current);
  const remaining = all.length - visible.length;
  /** @type {Node[]} */
  const rows = visible.map((workspace) => WorkspaceRow(workspace, currentId, focus));
  if (remaining > 0) {
    rows.push(
      cache.keyed("ws-more", `${remaining}`, () =>
        h("button", {
          class: "nav-action rooms-more",
          text: `↓ show ${Math.min(WORKSPACES_CHUNK, remaining)} more (${remaining} left)`,
          onclick: () => {
            state.workspacesShown += WORKSPACES_CHUNK;
            markDirty("sidebar");
          },
        }),
      ),
    );
  }
  syncChildren(container, rows);
  return container;
}

/** @param {WorkspaceRecord} workspace @param {string|undefined} currentId @param {ReturnType<typeof effectiveSidebarFocus>} focus @returns {Node} */
function WorkspaceRow(workspace, currentId, focus) {
  // Roll the workspace's rooms up to one dot so activity in a workspace
  // you're NOT viewing is still visible: green (pulsing) while any room in
  // it has an agent running, else accent while any has unread replies.
  const act = workspaceActivity(workspace.id);
  const isCurrent = workspace.id === currentId;
  const focused = focus?.kind === "workspace" && focus.id === workspace.id;
  const version = [workspace.name, workspace.path, isCurrent, workspace.isInitialized, focused, act.running, act.unread].join("|");
  return cache.keyed(`ws:${workspace.id}`, version, () => buildWorkspaceRow(workspace, isCurrent, focused, act));
}

/** @param {WorkspaceRecord} workspace @param {boolean} isCurrent @param {boolean} focused @param {{running?: boolean, unread?: boolean}} act @returns {HTMLElement} */
function buildWorkspaceRow(workspace, isCurrent, focused, act) {
  const onClick = () => {
    state.sidebarFocus = { kind: "workspace", id: workspace.id };
    if (workspace.isInitialized) void loadWorkspace(workspace.id);
    else setError(`Missing .gaia workspace: ${workspace.path}`);
    markDirty("sidebar");
  };
  return h(
    "button",
    {
      class: `nav-item ws-item ${isCurrent ? "active" : ""} ${workspace.isInitialized ? "" : "muted"} ${focused ? "focused" : ""}`,
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
  const container = cache.persistent("room-tree", () => h("div", { class: "room-tree" }));
  /** @type {Node[]} */
  const nodes = visible.map((room) => RoomNode(room, childrenOf, 0));
  if (remaining > 0) {
    nodes.push(
      cache.keyed("rooms-more", `${remaining}`, () =>
        h("button", {
          class: "nav-action rooms-more",
          text: `↓ show ${Math.min(ROOMS_CHUNK, remaining)} more (${remaining} left)`,
          onclick: () => {
            state.roomsShown += ROOMS_CHUNK;
            markDirty("sidebar");
          },
        }),
      ),
    );
  }
  syncChildren(container, nodes);
  return container;
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
 * A room row + (when expanded) its children. The `.room-node` wrapper and the
 * `.room-children` container are PERSISTENT per room id so they are never
 * detached; the `.room-row` itself is keyed by a version stamp of everything it
 * renders / a handler reads, so an activity tick that does not touch this room
 * leaves its node (and any live hover / focus / mid-press) intact.
 * @param {RoomSummary} room
 * @param {Map<string|null, RoomSummary[]>} childrenOf
 * @param {number} depth
 * @returns {Node}
 */
function RoomNode(room, childrenOf, depth) {
  const node = cache.persistent(`room-node:${room.id}`, () => h("div", { class: "room-node" }));
  const kids = (childrenOf.get(room.id) ?? []).filter((kid) => favoriteVisible(kid, childrenOf));
  const expanded = state.expandedRooms.has(room.id);
  // A collapsed parent hides its subrooms, so bubble their RUNNING status up
  // here (unread deliberately does not bubble — see descendantActivity).
  const sub = kids.length > 0 && !expanded ? descendantActivity(room, childrenOf) : { running: false };
  const row = RoomRow(room, depth, expanded, kids.length, sub.running);
  /** @type {Node[]} */
  const parts = [row];
  if (kids.length > 0 && expanded) {
    const childrenBox = cache.persistent(`room-children:${room.id}`, () => h("div", { class: "room-children" }));
    syncChildren(childrenBox, kids.map((kid) => RoomNode(kid, childrenOf, depth + 1)));
    parts.push(childrenBox);
  }
  syncChildren(node, parts);
  return node;
}

/**
 * @param {RoomSummary} room @param {number} depth @param {boolean} expanded
 * @param {number} kidCount @param {boolean} subRunning @returns {Node}
 */
function RoomRow(room, depth, expanded, kidCount, subRunning) {
  const snapshot = state.snapshot;
  const focus = effectiveSidebarFocus();
  const focused = focus?.kind === "room" && focus.id === room.id;
  const label = room.title ?? room.id;
  const since = localTime(room.runningSince);
  const unread = roomUnread(room);
  // Every field the row renders OR a handler reads (lastActivity feeds
  // selectSidebarRoom's markRoomRead though it isn't drawn). Unchanged → reuse
  // node (identity kept); changed → rebuild with fresh handlers.
  const version = [
    depth,
    room.isCurrent,
    focused,
    room.running,
    since,
    room.incognito,
    unread,
    label,
    room.path ?? "",
    room.imported ?? "",
    kidCount,
    expanded,
    subRunning,
    room.lastActivity ?? 0,
    Boolean(snapshot),
  ].join("|");
  return cache.keyed(`room-row:${room.id}`, version, () => buildRoomRow(room, depth, expanded, kidCount, subRunning, snapshot, focused, label, since, unread));
}

/**
 * @param {RoomSummary} room @param {number} depth @param {boolean} expanded
 * @param {number} kidCount @param {boolean} subRunning
 * @param {import("./types.js").Snapshot|null} snapshot @param {boolean} focused
 * @param {string} label @param {string} since @param {boolean} unread
 * @returns {HTMLElement}
 */
function buildRoomRow(room, depth, expanded, kidCount, subRunning, snapshot, focused, label, since, unread) {
  // Only TOP-LEVEL rooms are individually draggable (reorder among siblings,
  // or drag into Favorites) — same scope as the server's reorderRooms (nested
  // summon children keep their parent-relative position, never reordered).
  const isTop = depth === 0;
  const runningTitle = room.running && since ? `running since ${since}` : "agent running";
  /** @param {MouseEvent} event */
  const toggle = (event) => {
    event.stopPropagation();
    if (expanded) state.expandedRooms.delete(room.id);
    else state.expandedRooms.add(room.id);
    markDirty("sidebar");
  };
  /** @param {MouseEvent|PointerEvent} [event] */
  const onClick = (event) => {
    if (!snapshot) return;
    state.roomContextMenu = null;
    state.sidebarFocus = { kind: "room", id: room.id };
    selectSidebarRoom(snapshot, room, Boolean(event && hasPrimaryModifier(event)));
    markDirty("sidebar");
    closeSidebarOverlay();
  };
  /** @param {MouseEvent} event */
  const onAuxClick = (event) => {
    if (event.button !== 1 || !snapshot) return;
    event.preventDefault();
    state.roomContextMenu = null;
    state.sidebarFocus = { kind: "room", id: room.id };
    selectSidebarRoom(snapshot, room, true);
    markDirty("sidebar");
    closeSidebarOverlay();
  };
  return h(
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

          onauxclick: !snapshot ? null : onAuxClick,
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
      subRunning ? h("span", { class: "room-subdot running", title: "a subroom has an agent running" }) : null,
      // No per-row delete button: deletion is the OS delete chord (⌘⌫ on macOS,
      // Del elsewhere) acting on the focused room — see keys.js.
      kidCount > 0
        ? h("button", { class: `room-twisty ${expanded ? "open" : ""}`, title: expanded ? "collapse" : "expand", onclick: toggle, text: expanded ? "▾" : "▸" })
        : h("span", { class: "room-twisty leaf" }),
  );
}

/** @returns {Node|null} */
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
  return cache.keyed("room-context-menu", `${open.roomId}|${open.x}|${open.y}|${label}|${roomUnread(room)}|${room.favorite}`, () => h(
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
  ));
}

/** @returns {Node|null} */
function WorkspaceContextMenu() {
  const open = state.workspaceContextMenu;
  if (!open) return null;
  const workspace = state.workspaces.find((candidate) => candidate.id === open.workspaceId);
  if (!workspace) return null;
  const close = () => {
    state.workspaceContextMenu = null;
    markDirty("sidebar");
  };
  return cache.keyed("workspace-context-menu", `${open.workspaceId}|${open.x}|${open.y}|${workspace.name}|${workspaceActivity(workspace.id).unread}|${workspace.favorite}`, () => h(
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
  ));
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

/** @param {PointerEvent} event @param {(event: PointerEvent) => void} onClick invoked when the press never crossed the drag threshold (a plain click) */
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
    onClick(event);
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
