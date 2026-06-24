// The room tabs are a tmux-style working set: an ordered list of room ids the
// user has open. The sidebar tree still lists every room; tabs are just the
// ones in play. Order is user-controlled (drag) and persisted per workspace.
// Closing a tab never deletes the room — it only drops it from the working set.
import { state } from "./state.ts";

function storageKey(workspaceId) {
  return `gaia.tabs.${workspaceId}`;
}

function persist(workspaceId) {
  if (!workspaceId) return;
  try {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(state.openTabs));
  } catch {
    // storage disabled — tabs just won't survive a reload.
  }
}

// Load the saved tab order for a workspace into state (called on every
// workspace/room switch so each workspace keeps its own set).
export function restoreTabs(workspaceId) {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(storageKey(workspaceId)) ?? "[]");
  } catch {
    saved = [];
  }
  state.openTabs = Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
}

// Ensure a room is present as a tab (used whenever a room becomes current).
export function openTab(roomId, workspaceId) {
  if (!roomId) return;
  if (!state.openTabs.includes(roomId)) {
    state.openTabs.push(roomId);
    persist(workspaceId);
  }
}

// Drop a tab from the working set; returns the neighbour id to select next, or
// null when it was not the active tab (caller keeps the current selection).
export function closeTab(roomId, workspaceId, isActive) {
  const index = state.openTabs.indexOf(roomId);
  if (index === -1) return null;
  state.openTabs.splice(index, 1);
  persist(workspaceId);
  if (!isActive) return null;
  return state.openTabs[index] ?? state.openTabs[index - 1] ?? null;
}

// Reorder: drop the dragged tab just before the target tab.
export function moveTab(fromId, toId, workspaceId) {
  if (fromId === toId) return;
  const from = state.openTabs.indexOf(fromId);
  if (from === -1) return;
  state.openTabs.splice(from, 1);
  const to = state.openTabs.indexOf(toId);
  state.openTabs.splice(to === -1 ? state.openTabs.length : to, 0, fromId);
  persist(workspaceId);
}

// The tabs to render: persisted order, filtered to rooms that still exist, with
// the current room guaranteed present (appended if it was never opened).
export function visibleTabs(snapshot) {
  const rooms = snapshot?.rooms ?? [];
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const ordered = state.openTabs.filter((id) => byId.has(id));
  const currentId = snapshot?.room?.id;
  if (currentId && byId.has(currentId) && !ordered.includes(currentId)) ordered.push(currentId);
  return ordered.map((id) => byId.get(id));
}
