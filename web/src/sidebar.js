// The sessions sidebar: workspaces list + the recursive rooms tree. A summon's
// child room nests under its parent (via room.parentRoomId) and is collapsed
// by default behind a twisty. Nesting is unbounded — grandchildren summon
// their own children.
import { addRoom, addWorkspace, deleteRoom, loadWorkspace, selectRoom } from "./actions.js";
import { $, h } from "./dom.js";
import { PathText } from "./links.js";
import { markDirty, registerRegion, setError } from "./render.js";
import { openSearch } from "./search.js";
import { roomUnread, state } from "./state.js";

/** @typedef {import("./types.js").RoomSummary} RoomSummary */

function renderSidebar() {
  const nav = $("#sidebar");
  if (!nav) return;
  const scrollTop = nav.scrollTop;
  const current = state.snapshot?.workspace.id;
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
      state.workspaces.map((workspace) =>
        h(
          "button",
          {
            class: `nav-item ${workspace.id === current ? "active" : ""} ${workspace.isInitialized ? "" : "muted"}`,
            title: workspace.path,
            onclick: () => (workspace.isInitialized ? void loadWorkspace(workspace.id) : setError(`Missing .gaia workspace: ${workspace.path}`)),
          },
          h("span", { text: workspace.name }),
          h("small", {}, PathText(workspace.path)),
        ),
      ),
    ),
    h("button", { class: "nav-action", onclick: () => void addWorkspace(), text: "+ add workspace" }),
    h(
      "div",
      { class: "nav-title nav-title-row" },
      h("span", { text: "rooms" }),
      // Inline + next to the header, so a new room is one click from the top —
      // not a button buried under the whole (possibly 100-chat) room list.
      state.snapshot
        ? h("button", { class: "nav-title-add", title: "new room (Ctrl+T)", onclick: () => void addRoom(), text: "+" })
        : null,
    ),
    RoomTree(),
    h("div", { class: "spacer" }),
    h("button", {
      class: "nav-action",
      onclick: () => {
        state.settingsOpen = true;
        markDirty("settings");
      },
      text: "global settings",
    }),
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
  const visible = top.slice(0, state.roomsShown);
  const current = top.find((room) => room.isCurrent);
  if (current && !visible.includes(current)) visible.push(current);
  const remaining = top.length - visible.length;
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
 * @param {number} depth
 * @returns {HTMLElement}
 */
function RoomNode(room, childrenOf, depth) {
  const kids = childrenOf.get(room.id) ?? [];
  const expanded = state.expandedRooms.has(room.id);
  /** @param {MouseEvent} event */
  const toggle = (event) => {
    event.stopPropagation();
    if (expanded) state.expandedRooms.delete(room.id);
    else state.expandedRooms.add(room.id);
    markDirty("sidebar");
  };
  const snapshot = state.snapshot;
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
          class: `nav-item room-item ${room.isCurrent ? "active" : ""}`,
          title: room.path,
          onclick: room.isCurrent || !snapshot ? null : () => void selectRoom(snapshot.workspace.id, room.id),
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
          room.incognito ? h("span", { class: "room-incognito", title: "incognito — no memory", text: "🕶" }) : null,
          h("span", { class: roomUnread(room) && !room.running ? "room-name unread" : "room-name", text: room.title ?? room.id }),
        ),
        h("small", {}, room.imported ? document.createTextNode(room.imported.slice(0, 10)) : PathText(room.path)),
      ),
      // Hover-revealed delete: moves the room to trash and purges it from memory
      // (confirmed first). Server refuses the last room, so it's always safe here.
      h("button", {
        class: "room-del",
        title: "delete room (moves to trash)",
        onclick: (/** @type {MouseEvent} */ event) => {
          event.stopPropagation();
          void deleteRoom(room.id);
        },
        text: "🗑",
      }),
      kids.length > 0
        ? h("button", { class: `room-twisty ${expanded ? "open" : ""}`, title: expanded ? "collapse" : "expand", onclick: toggle, text: expanded ? "▾" : "▸" })
        : h("span", { class: "room-twisty leaf" }),
    ),
    kids.length > 0 && expanded ? h("div", { class: "room-children" }, kids.map((kid) => RoomNode(kid, childrenOf, depth + 1))) : null,
  );
}
