// The room tabs are a tmux-style working set: an ordered list of room/workspace
// pairs open IN THIS WINDOW. The sidebar tree still lists every room; tabs are
// just the ones in play. Order is user-controlled (drag) and global across
// workspaces. Closing a tab never deletes the room — it only drops it from the
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
/** @typedef {{roomId: string, workspaceId: string}} TabEntry */
/** @typedef {{room: RoomSummary, workspaceId: string}} VisibleTab */

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

function storageKey() {
  return "gaia.tabs";
}

function persist() {
  const store = tabStore();
  if (!store) return;
  try {
    store.setItem(storageKey(), JSON.stringify(state.openTabs));
  } catch {
    // storage disabled — tabs just won't survive a reload.
  }
}

/** @param {unknown} value @returns {value is TabEntry} */
function isTabEntry(value) {
  const entry = /** @type {any} */ (value);
  return Boolean(entry) && typeof entry === "object" && typeof entry.roomId === "string" && typeof entry.workspaceId === "string";
}

/** Load this window's global tab order. If the global key is absent, migrate the
 * old per-workspace keys in Storage key order, then remove them. */
export function restoreTabs() {
  const store = tabStore();
  if (!store) {
    state.openTabs = [];
    return;
  }
  try {
    const saved = store.getItem(storageKey());
    if (saved !== null) {
      const parsed = JSON.parse(saved);
      state.openTabs = Array.isArray(parsed) ? parsed.filter(isTabEntry) : [];
      return;
    }
    /** @type {TabEntry[]} */
    const migrated = [];
    /** @type {string[]} */
    const legacyKeys = [];
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (key?.startsWith("gaia.tabs.")) legacyKeys.push(key);
    }
    for (const key of legacyKeys) {
      try {
        const workspaceId = key.slice("gaia.tabs.".length);
        const parsed = JSON.parse(store.getItem(key) ?? "[]");
        if (Array.isArray(parsed)) {
          for (const roomId of parsed) if (typeof roomId === "string") migrated.push({ roomId, workspaceId });
        }
      } catch {
        // A corrupt legacy entry must not discard other workspaces' tabs.
      }
    }
    state.openTabs = migrated;
    persist();
    for (const key of legacyKeys) store.removeItem(key);
  } catch {
    state.openTabs = [];
  }
}

/** @param {string} roomId @param {string} workspaceId @returns {number} */
function tabIndex(roomId, workspaceId) {
  return state.openTabs.findIndex((entry) => entry.roomId === roomId && entry.workspaceId === workspaceId);
}

/** Ensure a room/workspace pair is present as a tab (used whenever a room becomes current).
 * @param {string} roomId @param {string} workspaceId */
export function openTab(roomId, workspaceId) {
  if (!roomId || !workspaceId) return;
  if (tabIndex(roomId, workspaceId) === -1) {
    state.openTabs.push({ roomId, workspaceId });
    persist();
  }
}
/** Navigate from one active room/workspace pair to another without growing the
 * working set. Existing targets stay put; otherwise replace the prior active
 * entry in place, falling back to an initial append when no prior entry exists.
 * @param {TabEntry|null} prev @param {TabEntry} next */
export function navigateTab(prev, next) {
  if (!next?.roomId || !next.workspaceId) return;
  if (tabIndex(next.roomId, next.workspaceId) !== -1) return;
  const previous = prev && tabIndex(prev.roomId, prev.workspaceId);
  if (previous !== null && previous !== -1) state.openTabs.splice(previous, 1, { ...next });
  else state.openTabs.push({ ...next });
  persist();
}

/** Drop a tab; returns the neighbour pair to select next, or null when inactive.
 * @param {string} roomId @param {string} workspaceId @param {boolean} isActive
 * @returns {TabEntry|null} */
export function closeTab(roomId, workspaceId, isActive) {
  const index = tabIndex(roomId, workspaceId);
  if (index === -1) return null;
  state.openTabs.splice(index, 1);
  persist();
  if (!isActive) return null;
  return state.openTabs[index] ?? state.openTabs[index - 1] ?? null;
}

/** Reorder a room/workspace pair into an explicit slot.
 * @param {string} roomId @param {string} workspaceId @param {number} index */
export function moveTabToIndex(roomId, workspaceId, index) {
  const from = tabIndex(roomId, workspaceId);
  if (from === -1) return;
  const [entry] = state.openTabs.splice(from, 1);
  const clamped = Math.max(0, Math.min(index, state.openTabs.length));
  state.openTabs.splice(clamped, 0, entry);
  persist();
}

/** Close every tab to the right; returns the context pair if active is removed.
 * @param {string} roomId @param {string} workspaceId
 * @param {{roomId: string, workspaceId: string}|undefined} active
 * @returns {TabEntry|null} */
export function closeTabsToRight(roomId, workspaceId, active) {
  const index = tabIndex(roomId, workspaceId);
  if (index === -1) return null;
  const removed = state.openTabs.splice(index + 1);
  if (removed.length === 0) return null;
  persist();
  return active && removed.some((entry) => entry.roomId === active.roomId && entry.workspaceId === active.workspaceId) ? state.openTabs[index] ?? null : null;
}

/** The tabs to render: persisted global order, with the current room guaranteed
 * present. Known workspace lists prune deleted rooms; unknown lists retain a
 * placeholder until cross-workspace cache data arrives.
 * @param {Snapshot|null} snapshot @returns {VisibleTab[]} */
export function visibleTabs(snapshot) {
  const currentWorkspaceId = snapshot?.workspace.id;
  /** @type {VisibleTab[]} */
  const ordered = [];
  for (const entry of state.openTabs) {
    const rooms = entry.workspaceId === currentWorkspaceId ? snapshot?.rooms : state.workspaceRooms[entry.workspaceId];
    const room = rooms?.find((candidate) => candidate.id === entry.roomId);
    if (room) ordered.push({ room, workspaceId: entry.workspaceId });
    else if (rooms === undefined) ordered.push({ room: { id: entry.roomId, path: "", isCurrent: false }, workspaceId: entry.workspaceId });
  }
  const current = snapshot?.rooms.find((room) => room.id === snapshot.room.id);
  if (current && currentWorkspaceId && !ordered.some((entry) => entry.room.id === current.id && entry.workspaceId === currentWorkspaceId)) {
    ordered.push({ room: current, workspaceId: currentWorkspaceId });
  }
  return ordered;
}
