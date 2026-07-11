// The sessions sidebar: workspaces list + the recursive rooms tree. A summon's
// child room nests under its parent (via room.parentRoomId) and is collapsed
// by default behind a twisty. Nesting is unbounded — grandchildren summon
// their own children.
import { addRoom, addWorkspace, loadWorkspace, renameRoom, selectRoom, setRoomFavorite } from "./actions.js";
import { closeSidebarOverlay } from "./chrome.js";
import { $, h } from "./dom.js";
import { PathText } from "./links.js";
import { refreshAttention } from "./attention.js";
import { markDirty, registerRegion, setError } from "./render.js";
import { openSearch } from "./search.js";
import { openSettings } from "./settings.js";
import { effectiveSidebarFocus, markRoomRead, markRoomUnread, persistRoomsFavoritesOnly, roomUnread, state, workspaceActivity } from "./state.js";

/** @typedef {import("./types.js").RoomSummary} RoomSummary */

function renderSidebar() {
  const nav = $("#sidebar");
  if (!nav) return;
  const scrollTop = nav.scrollTop;
  const current = state.snapshot?.workspace.id;
  // The delete target: which workspace/room the OS delete chord will remove.
  const focus = effectiveSidebarFocus();
  /** @type {(HTMLElement|null)[]} */
  const children = [
    h("button", {
      class: "nav-search",
      title: "search across all chats (⌘K)",
      onclick: () => openSearch("chatwide"),
      text: "🔍 search chats",
    }),
    h("div", { class: "nav-title", text: "workspaces" }),
    h(
      "div",
      { class: "workspace-list" },
      state.workspaces.map((workspace) => {
        // Roll the workspace's rooms up to one dot so activity in a workspace
        // you're NOT viewing is still visible: green (pulsing) while any room in
        // it has an agent running, else accent while any has unread replies.
        const act = workspaceActivity(workspace.id);
        return h(
          "button",
          {
            class: `nav-item ${workspace.id === current ? "active" : ""} ${workspace.isInitialized ? "" : "muted"} ${focus?.kind === "workspace" && focus.id === workspace.id ? "focused" : ""}`,
            title: workspace.path,
            // Clicking makes this the delete target (the ⌘⌫ / Del chord acts on
            // it) and opens it. The muted state means its .gaia is missing.
            onclick: () => {
              state.sidebarFocus = { kind: "workspace", id: workspace.id };
              if (workspace.isInitialized) void loadWorkspace(workspace.id);
              else setError(`Missing .gaia workspace: ${workspace.path}`);
              markDirty("sidebar");
            },
          },
          h(
            "span",
            { class: "room-label" },
            act.running
              ? h("span", { class: "room-dot running", title: "agent running in this workspace" })
              : act.unread
                ? h("span", { class: "room-dot unread", title: "unread messages in this workspace" })
                : null,
            h("span", { class: act.unread && !act.running ? "room-name unread" : "room-name", text: workspace.name }),
          ),
          h("small", {}, PathText(workspace.path)),
        );
      }),
    ),
    h("button", { class: "nav-action", onclick: () => void addWorkspace(), text: "+ add workspace" }),
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
    RoomTree(),
    RoomContextMenu(),
    h("div", { class: "spacer" }),
    h("button", { class: "nav-action", onclick: () => openSettings(), text: "settings" }),
  ];
  nav.replaceChildren(...children.filter((child) => child !== null));
  if (scrollTop) nav.scrollTop = scrollTop;
}

registerRegion("sidebar", renderSidebar);

// How many top-level rooms each "show more" click adds to the list.
const ROOMS_CHUNK = 25;

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
          // One status slot: a green blinking dot while an agent is working in
          // the room, else an accent dot when it has unread replies, else empty.
          room.running
            ? h("span", { class: "room-dot running", title: "agent running" })
            : roomUnread(room)
              ? h("span", { class: "room-dot unread", title: "unread messages" })
              : null,
          room.favorite ? h("span", { class: "room-star", title: "favorite", text: "★" }) : null,
          room.incognito ? h("span", { class: "room-incognito", title: "incognito — no memory", text: "🕶" }) : null,
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

window.addEventListener("click", (event) => {
  if (!state.roomContextMenu) return;
  if (event.target instanceof HTMLElement && event.target.closest(".room-menu")) return;
  state.roomContextMenu = null;
  markDirty("sidebar");
});
