// The sessions sidebar: workspaces list + the recursive rooms tree. A summon's
// child room nests under its parent (via room.parentRoomId) and is collapsed
// by default behind a twisty. Nesting is unbounded — grandchildren summon
// their own children.
import { addRoom, addWorkspace, loadWorkspace, selectRoom } from "./actions.js";
import { $, h } from "./dom.js";
import { PathText } from "./links.js";
import { registerRegion, render, setError } from "./render.js";
import { state } from "./state.js";

/** @typedef {import("./types.js").RoomSummary} RoomSummary */

function renderSidebar() {
  const nav = $("#sidebar");
  if (!nav) return;
  const scrollTop = nav.scrollTop;
  const current = state.snapshot?.workspace.id;
  /** @type {(HTMLElement|null)[]} */
  const children = [
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
    h("div", { class: "nav-title", text: "rooms" }),
    RoomTree(),
    state.snapshot ? h("button", { class: "nav-action", onclick: () => void addRoom(), text: "+ add room" }) : null,
    h("div", { class: "spacer" }),
    h("button", {
      class: "nav-action",
      onclick: () => {
        state.settingsOpen = true;
        render("settings");
      },
      text: "global settings",
    }),
  ];
  nav.replaceChildren(...children.filter((child) => child !== null));
  if (scrollTop) nav.scrollTop = scrollTop;
}

registerRegion("sidebar", renderSidebar);

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
  return h("div", { class: "room-tree" }, (childrenOf.get(null) ?? []).map((room) => RoomNode(room, childrenOf, 0)));
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
    render("sidebar");
  };
  const snapshot = state.snapshot;
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
          onclick: room.isCurrent || !snapshot ? null : () => void selectRoom(snapshot.workspace.id, room.id),
        },
        h(
          "span",
          { class: "room-label" },
          room.running ? h("span", { class: "room-dot running", title: "summon running" }) : null,
          h("span", { text: room.id }),
        ),
        h("small", {}, PathText(room.path)),
      ),
    ),
    kids.length > 0 && expanded ? h("div", { class: "room-children" }, kids.map((kid) => RoomNode(kid, childrenOf, depth + 1))) : null,
  );
}
