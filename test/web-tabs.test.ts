import test from "node:test";
import assert from "node:assert/strict";

class StorageStub {
  values = new Map<string, string>();
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

const localStorage = new StorageStub();
const sessionStorage = new StorageStub();
Object.assign(globalThis, { localStorage, sessionStorage, window: { localStorage, sessionStorage } });

const { state } = await import("../web/src/state.js");
const { closeTab, openTab, restoreTabs, visibleTabs } = await import("../web/src/tabs.js");

function reset(): void {
  localStorage.clear();
  state.openTabs = [];
  state.workspaceRooms = {};
  state.snapshot = null;
}

function room(id: string) {
  return { id, path: id, isCurrent: false, title: id };
}

test("openTab dedupes room/workspace pairs and closeTab returns a cross-workspace neighbour", () => {
  reset();
  openTab("same", "one");
  openTab("same", "two");
  openTab("same", "one");
  assert.deepEqual(state.openTabs, [{ roomId: "same", workspaceId: "one" }, { roomId: "same", workspaceId: "two" }]);
  assert.deepEqual(closeTab("same", "one", true), { roomId: "same", workspaceId: "two" });
});

test("restoreTabs migrates legacy workspace keys in Storage key order", () => {
  reset();
  localStorage.setItem("gaia.tabs.b", JSON.stringify(["b1", "b2"]));
  localStorage.setItem("gaia.tabs.a", JSON.stringify(["a1"]));
  restoreTabs();
  assert.deepEqual(state.openTabs, [
    { roomId: "b1", workspaceId: "b" },
    { roomId: "b2", workspaceId: "b" },
    { roomId: "a1", workspaceId: "a" },
  ]);
  assert.equal(localStorage.getItem("gaia.tabs.b"), null);
  assert.equal(localStorage.getItem("gaia.tabs.a"), null);
  assert.equal(localStorage.getItem("gaia.tabs"), JSON.stringify(state.openTabs));
});

test("visibleTabs resolves cached foreign rooms and keeps unknown workspace entries", () => {
  reset();
  state.openTabs = [
    { roomId: "current", workspaceId: "one" },
    { roomId: "foreign", workspaceId: "two" },
    { roomId: "missing", workspaceId: "two" },
    { roomId: "unknown", workspaceId: "three" },
  ];
  state.workspaceRooms = { two: [room("foreign")] };
  state.snapshot = /** @type {any} */ ({ workspace: { id: "one" }, room: { id: "current" }, rooms: [room("current")] });
  assert.deepEqual(visibleTabs(state.snapshot).map((entry) => [entry.workspaceId, entry.room.id]), [
    ["one", "current"],
    ["two", "foreign"],
    ["three", "unknown"],
  ]);
});
