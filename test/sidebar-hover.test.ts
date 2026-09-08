// Product test for the ACTUAL sidebar render path (web/src/sidebar.js), driven
// through the real markDirty("sidebar") + registered region renderer under a
// MiniDOM. Run: bun test --preserve-symlinks test/sidebar-hover.test.ts
// (the web/src/design symlink needs --preserve-symlinks; same as web-navigation.)
//
// Covers the two live blockers parent reproduced with CDP:
//   1. a title / status / selection / activity update patches the row IN PLACE
//      — the SAME button node stays connected (never detached / rebuilt), so
//      native focus / :hover survive and the label/class/icons refresh on it;
//   2. a background room gaining activity does NOT reshuffle the room list out
//      from under a stationary pointer — the activity sort is frozen while the
//      pointer is inside the sidebar, and released on pointerleave.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { installMiniDom, MElement } from "./helpers/mini-dom.js";

const dom = installMiniDom();
// Swallow selectRoom()'s fetch so a click handler can run without a live server.
globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;

const { state } = await import("../web/src/state.js");
const { markDirty } = await import("../web/src/render.js");
await import("../web/src/sidebar.js"); // registers the "sidebar" region renderer

type RoomOver = Partial<{ title: string; running: boolean; lastActivity: number; parentRoomId: string; incognito: boolean }>;
function room(id: string, over: RoomOver = {}) {
  return { id, path: `/ws/${id}`, title: id, isCurrent: false, running: false, lastActivity: 0, ...over } as any;
}
function setup(rooms: any[], currentId: string) {
  state.snapshot = { workspace: { id: "ws", path: "/ws" }, room: { id: currentId, events: [], eventTotal: 0 }, rooms, agents: [], tasks: [] } as any;
  state.workspaces = [];
  state.workspaceRooms = {};
  state.roomsShown = 50;
  state.workspacesShown = 50;
  state.roomsFavoritesOnly = false;
  state.roomsCollapsed = false;
  state.workspacesCollapsed = false;
  state.expandedRooms = new Set();
  state.sidebarFocus = null;
  state.roomContextMenu = null;
  state.favoritesOrder = [];
}
function render() { markDirty("sidebar"); } // rAF is synchronous under MiniDOM
function roomButtons(): MElement[] { return dom.nav.querySelectorAll(".room-item"); }
function labels(): (string | null)[] { return roomButtons().map(b => b.querySelector(".room-name")?.textContent ?? null); }
function buttonFor(label: string): MElement | undefined { return roomButtons().find(b => b.querySelector(".room-name")?.textContent === label); }
function connected(node: MElement): boolean { let n: MElement | null = node; while (n) { if (n === dom.root) return true; n = n.parentNode; } return false; }

test("title / status / selection update patches the SAME button node in place (never detached)", () => {
  setup([room("a"), room("b"), room("c")], "a");
  render();
  const bBtn = buttonFor("b")!;
  assert.ok(bBtn, "row b rendered");
  assert.ok(connected(bBtn));

  // Title change (POST room/title → SSE) on the SAME room id, new snapshot objects.
  state.snapshot!.rooms = [room("a"), room("b", { title: "b-renamed" }), room("c")];
  render();
  const bBtnAfterTitle = buttonFor("b-renamed")!;
  assert.equal(bBtnAfterTitle, bBtn, "same button node instance after title update");
  assert.ok(connected(bBtn), "node still connected — not rebuilt/detached");
  assert.equal(bBtn.querySelector(".room-name")!.textContent, "b-renamed", "label patched in place");

  // Status change (agent starts running) — same node, dot appears in its slot.
  state.snapshot!.rooms = [room("a"), room("b", { title: "b-renamed", running: true }), room("c")];
  render();
  assert.equal(buttonFor("b-renamed"), bBtn, "same node after status update");
  const dot = bBtn.querySelector(".room-dot");
  assert.ok(dot && dot.classList.contains("running"), "running dot patched into the slot");

  // Selection change — same node gains .active.
  state.snapshot!.room = { id: "b", events: [], eventTotal: 0 } as any;
  state.snapshot!.rooms = [room("a"), room("b", { title: "b-renamed", running: true, isCurrent: true }), room("c")];
  render();
  assert.equal(buttonFor("b-renamed"), bBtn, "same node after selection update");
  assert.ok(bBtn.classList.contains("active"), ".active patched onto the same node");
});

test("activity update on the CURRENT/streaming row never detaches it (repeated lastActivity ticks)", () => {
  setup([room("a", { isCurrent: true, running: true }), room("b"), room("c")], "a");
  render();
  const aBtn = buttonFor("a")!;
  for (let tick = 1; tick <= 5; tick++) {
    // The active row's lastActivity keeps advancing while it streams.
    state.snapshot!.rooms = [room("a", { isCurrent: true, running: true, lastActivity: tick }), room("b"), room("c")];
    render();
    assert.equal(buttonFor("a"), aBtn, `tick ${tick}: same node`);
    assert.ok(connected(aBtn), `tick ${tick}: still connected`);
  }
});

test("activity re-sort is frozen while the pointer is inside the sidebar, released on pointerleave", () => {
  setup([room("a"), room("b"), room("c")], "a");
  render(); // binds pointerenter/leave, frozen order = [a,b,c]
  assert.deepEqual(labels(), ["a", "b", "c"]);
  const bBtn = buttonFor("b")!;

  // Pointer enters and rests on row b.
  dom.nav.dispatch("pointerenter");

  // A background room (c) gets activity → daemon re-sorts latest-first to [c,a,b].
  state.snapshot!.rooms = [room("c", { lastActivity: 99 }), room("a"), room("b")];
  render();
  assert.deepEqual(labels(), ["a", "b", "c"], "order held — pointer's row does not slide");
  assert.equal(buttonFor("b"), bBtn, "row b keeps its node identity and slot");

  // Pointer leaves → the held order is released and the fresh sort applies.
  dom.nav.dispatch("pointerleave");
  assert.deepEqual(labels(), ["c", "a", "b"], "released to the latest activity order");
  assert.equal(buttonFor("b"), bBtn, "same node, just moved on release");
});

test("while frozen: a NEW room is appended, a REMOVED room is dropped, others hold position", () => {
  setup([room("a"), room("b"), room("c")], "a");
  render();
  dom.nav.dispatch("pointerenter");

  // New room d arrives at the top of the activity sort.
  state.snapshot!.rooms = [room("d", { lastActivity: 99 }), room("a"), room("b"), room("c")];
  render();
  assert.deepEqual(labels(), ["a", "b", "c", "d"], "new room appended, held rooms keep order");

  // Room c is deleted.
  state.snapshot!.rooms = [room("d", { lastActivity: 99 }), room("a"), room("b")];
  render();
  assert.deepEqual(labels(), ["a", "b", "d"], "removed room dropped, order otherwise held");
});

test("a workspace change reflows immediately even while the pointer is held inside", () => {
  setup([room("a"), room("b"), room("c")], "a");
  render();
  dom.nav.dispatch("pointerenter");

  // Different workspace id + its own (activity-sorted) room order.
  state.snapshot = { workspace: { id: "ws2", path: "/ws2" }, room: { id: "z", events: [], eventTotal: 0 }, rooms: [room("z"), room("y"), room("x")], agents: [], tasks: [] } as any;
  render();
  assert.deepEqual(labels(), ["z", "y", "x"], "workspace switch is not held by the freeze");
});

test("a bound click handler on a carried-over node acts on the LATEST data (fresh, not stale)", () => {
  // Nested child rows use a plain onclick; drive it directly on the same node
  // across an update to prove the handler reads the current ctx (no rebind churn).
  setup([room("p"), room("kid", { parentRoomId: "p" })], "p");
  state.expandedRooms = new Set(["p"]);
  render();
  const kidBtn = buttonFor("kid")!;
  assert.ok(kidBtn, "child row rendered under expanded parent");

  // Update the child (new snapshot object, same id) — node must persist.
  state.snapshot!.rooms = [room("p"), room("kid", { parentRoomId: "p", title: "kid2" })];
  render();
  const kidBtnAfter = buttonFor("kid2")!;
  assert.equal(kidBtnAfter, kidBtn, "child node carried over");

  state.sidebarFocus = null;
  kidBtn.dispatch("click", { metaKey: false });
  assert.deepEqual(state.sidebarFocus, { kind: "room", id: "kid" }, "click ran on the same node with the current room id");
});
