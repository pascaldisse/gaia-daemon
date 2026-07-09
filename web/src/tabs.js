// The room tabs are a tmux-style working set: an ordered list of room ids the
// user has open IN THIS WINDOW. The sidebar tree still lists every room; tabs are
// just the ones in play. Order is user-controlled (drag) and persisted per
// workspace. Closing a tab never deletes the room — it only drops it from the
// working set.
//
// PER-WINDOW ISOLATION (why the store is chosen, not fixed):
// Under the native shell every window is a separate Tauri webview but shares ONE
// localStorage origin (http://127.0.0.1:<port>). If every window persisted its
// tabs to the same localStorage key, closing a tab in one window would delete it
// from all of them — windows would fight over a single shared set. So:
//   * the MAIN window persists to localStorage — a stable key ("main" is the one
//     window that survives an app restart), so its working set is remembered.
//   * every SPAWNED window (win-N: a torn-off chat or a Cmd+N window) uses
//     sessionStorage, which is scoped to that ONE webview and cleared when the
//     window closes. It can never collide with, or bleed into, another window.
// A plain browser (the web backup) is always "main" → localStorage, unchanged.
import { isMainWindow } from "./native.js";
import { state } from "./state.js";

/** @typedef {import("./types.js").Snapshot} Snapshot */
/** @typedef {import("./types.js").RoomSummary} RoomSummary */

/** This window's tab store: localStorage for the main window (persists across an
 *  app restart), sessionStorage for a spawned window (isolated per webview,
 *  auto-cleared on close). Undefined if storage is disabled. @returns {Storage|undefined} */
function tabStore() {
  try {
    return isMainWindow() ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** @param {string} workspaceId */
function storageKey(workspaceId) {
  return `gaia.tabs.${workspaceId}`;
}

/** @param {string|undefined} workspaceId */
function persist(workspaceId) {
  if (!workspaceId) return;
  const store = tabStore();
  if (!store) return;
  try {
    store.setItem(storageKey(workspaceId), JSON.stringify(state.openTabs));
  } catch {
    // storage disabled — tabs just won't survive a reload.
  }
}

/**
 * Load the saved tab order for a workspace into state (called on every
 * workspace/room switch so each workspace keeps its own set). Reads from THIS
 * window's store, so windows never inherit each other's tabs.
 * @param {string} workspaceId
 */
export function restoreTabs(workspaceId) {
  const store = tabStore();
  /** @type {unknown} */
  let saved = [];
  try {
    saved = JSON.parse(store?.getItem(storageKey(workspaceId)) ?? "[]");
  } catch {
    saved = [];
  }
  state.openTabs = Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
}

/**
 * Ensure a room is present as a tab (used whenever a room becomes current).
 * @param {string} roomId
 * @param {string} workspaceId
 */
export function openTab(roomId, workspaceId) {
  if (!roomId) return;
  if (!state.openTabs.includes(roomId)) {
    state.openTabs.push(roomId);
    persist(workspaceId);
  }
}

/**
 * Drop a tab from the working set; returns the neighbour id to select next, or
 * null when it was not the active tab (caller keeps the current selection).
 * @param {string} roomId
 * @param {string} workspaceId
 * @param {boolean} isActive
 * @returns {string|null}
 */
export function closeTab(roomId, workspaceId, isActive) {
  const index = state.openTabs.indexOf(roomId);
  if (index === -1) return null;
  state.openTabs.splice(index, 1);
  persist(workspaceId);
  if (!isActive) return null;
  return state.openTabs[index] ?? state.openTabs[index - 1] ?? null;
}

/**
 * Reorder to an explicit slot — the pointer-drag drop. `index` is the position
 * in the list WITH the dragged tab already removed (i.e. computed against the
 * other tabs), which is exactly what the splice below produces.
 * @param {string} fromId
 * @param {number} index
 * @param {string} workspaceId
 */
export function moveTabToIndex(fromId, index, workspaceId) {
  const from = state.openTabs.indexOf(fromId);
  if (from === -1) return;
  state.openTabs.splice(from, 1);
  const clamped = Math.max(0, Math.min(index, state.openTabs.length));
  state.openTabs.splice(clamped, 0, fromId);
  persist(workspaceId);
}

/**
 * The tabs to render: persisted order, filtered to rooms that still exist, with
 * the current room guaranteed present (appended if it was never opened).
 * @param {Snapshot|null} snapshot
 * @returns {RoomSummary[]}
 */
export function visibleTabs(snapshot) {
  const rooms = snapshot?.rooms ?? [];
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const ordered = state.openTabs.filter((id) => byId.has(id));
  const currentId = snapshot?.room?.id;
  if (currentId && byId.has(currentId) && !ordered.includes(currentId)) ordered.push(currentId);
  return ordered.map((id) => /** @type {RoomSummary} */ (byId.get(id)));
}
