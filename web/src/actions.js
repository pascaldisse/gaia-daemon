// Every server mutation goes through these small action functions: they call
// the API, update state, and mark the affected regions. Views never mutate
// state directly.
import { api } from "./api.js";
import { connectEvents } from "./events.js";
import { markDirty, setError } from "./render.js";
import { loadInitialFiles, loadSelectedWorkspaceFile } from "./settings.js";
import { activeTask, runningSummonRooms, state } from "./state.js";
import { closeTab, openTab, restoreTabs } from "./tabs.js";

/** @typedef {import("./types.js").AppPayload} AppPayload */
/** @typedef {import("./types.js").SnapshotPayload} SnapshotPayload */

/** @param {AppPayload} body */
async function applyAppPayload(body) {
  state.workspaces = body.workspaces ?? [];
  state.snapshot = body.snapshot ?? null;
  state.streams.clear();
  state.workspaceFiles = body.workspaceFiles ?? [];
  state.globalFiles = body.globalFiles ?? state.globalFiles;
  state.voice = body.voice ?? null;
  if (state.snapshot) {
    restoreTabs(state.snapshot.workspace.id);
    openTab(state.snapshot.room.id, state.snapshot.workspace.id);
  }
  connectEvents();
  await loadInitialFiles();
  state.error = "";
  markDirty();
}

/** @param {string} [currentWorkspaceId] */
export async function loadApp(currentWorkspaceId) {
  try {
    const body = await api("/api/app");
    await applyAppPayload(body);
    if (currentWorkspaceId && body.currentWorkspaceId !== currentWorkspaceId) await loadWorkspace(currentWorkspaceId);
  } catch (error) {
    setError(error);
  }
}

/** @param {SnapshotPayload} body */
function applySnapshotPayload(body) {
  state.snapshot = body.snapshot;
  state.streams.clear();
  state.workspaceFiles = body.workspaceFiles ?? [];
  state.voice = body.voice ?? null;
}

/** @param {string} workspaceId */
export async function loadWorkspace(workspaceId) {
  try {
    const body = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/snapshot`);
    applySnapshotPayload(body);
    state.selectedWorkspaceFileId = state.workspaceFiles[0]?.id ?? null;
    state.workspaceFile = null;
    if (state.snapshot) {
      restoreTabs(state.snapshot.workspace.id);
      openTab(state.snapshot.room.id, state.snapshot.workspace.id);
    }
    connectEvents();
    await loadSelectedWorkspaceFile();
    state.error = "";
    markDirty();
  } catch (error) {
    setError(error);
  }
}

export async function addWorkspace() {
  /** @type {string|null|undefined} */
  let path;
  let pickerUnavailable = false;
  try {
    const pick = await api("/api/pick-directory", { method: "POST", body: "{}" });
    path = pick.path;
  } catch {
    pickerUnavailable = true;
  }
  if (!path && pickerUnavailable) path = window.prompt("Workspace path");
  if (!path) return;
  try {
    await applyAppPayload(await api("/api/workspaces", { method: "POST", body: JSON.stringify({ path }) }));
  } catch (error) {
    setError(error);
  }
}

/** @param {string} workspaceId @param {string} roomId */
export async function selectRoom(workspaceId, roomId) {
  try {
    const body = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/rooms/${encodeURIComponent(roomId)}/select`, {
      method: "POST",
      body: "{}",
    });
    applySnapshotPayload(body);
    state.selectedWorkspaceFileId = state.workspaceFiles[0]?.id ?? null;
    state.workspaceFile = null;
    if (state.snapshot) openTab(state.snapshot.room.id, state.snapshot.workspace.id);
    connectEvents();
    await loadSelectedWorkspaceFile();
    state.error = "";
    markDirty();
  } catch (error) {
    setError(error);
  }
}

/** @param {string} agentId */
export async function setDefaultAgent(agentId) {
  const snapshot = state.snapshot;
  if (!snapshot || snapshot.workspace.defaultAgent === agentId) return;
  try {
    const body = await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/default-agent`, {
      method: "POST",
      body: JSON.stringify({ agentId }),
    });
    applySnapshotPayload(body);
    connectEvents();
    await loadSelectedWorkspaceFile();
    state.error = "";
    markDirty();
  } catch (error) {
    setError(error);
  }
}

/** @param {string} agentId @param {string} role */
export async function setAgentRole(agentId, role) {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  try {
    const body = await api(
      `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/role`,
      {
        method: "POST",
        body: JSON.stringify({ agentId, role: role || "none" }),
      },
    );
    applySnapshotPayload(body);
    connectEvents();
    await loadSelectedWorkspaceFile();
    state.error = body.message && /^Unknown|^Usage/.test(body.message) ? body.message : "";
    markDirty();
  } catch (error) {
    setError(error);
  }
}

export async function addRoom() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const roomId = window.prompt("Room name (letters, numbers, dots, hyphens, underscores)");
  if (!roomId?.trim()) return;
  try {
    await selectRoom(snapshot.workspace.id, roomId.trim());
  } catch (error) {
    setError(error);
  }
}

/**
 * Close a room tab. This only drops it from the working set — the room and its
 * transcript stay put and remain reachable from the sidebar tree. If the closed
 * tab was active, jump to a neighbour so a room is always in view.
 * @param {string} roomId
 */
export async function closeRoomTab(roomId) {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const isActive = snapshot.room.id === roomId;
  const neighbour = closeTab(roomId, snapshot.workspace.id, isActive);
  if (isActive && neighbour && neighbour !== roomId) await selectRoom(snapshot.workspace.id, neighbour);
  else markDirty("tabs", "sidebar");
}

/** @param {string} text */
export async function sendMessage(text) {
  const snapshot = state.snapshot;
  if (!snapshot || !text.trim()) return;
  try {
    const body = await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    // Reflect the accepted task immediately so busy state doesn't wait for SSE.
    if (body.task && state.snapshot === snapshot && !snapshot.tasks.some((task) => task.id === body.task.id)) {
      snapshot.tasks.push(body.task);
      markDirty("panel", "status", "composer");
    }
  } catch (error) {
    setError(error);
  }
}

export async function cancelActiveTask() {
  const snapshot = state.snapshot;
  if (!snapshot || !activeTask(snapshot)) return;
  try {
    await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    setError(error);
  }
}

/**
 * Panic stop: abort the running room turn AND every running summon sub-room.
 * A summon is a child room, so each one is cancelled through the ordinary
 * room-cancel endpoint. Bound to Esc, Ctrl+C, and the stop button.
 */
export async function stopAll() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const workspaceId = snapshot.workspace.id;
  const summonRooms = runningSummonRooms(snapshot);
  try {
    await Promise.allSettled([
      ...(activeTask(snapshot) ? [cancelActiveTask()] : []),
      ...summonRooms.map((room) =>
        api(`/api/workspaces/${encodeURIComponent(workspaceId)}/rooms/${encodeURIComponent(room.id)}/cancel`, { method: "POST", body: "{}" }),
      ),
    ]);
    setError("");
  } catch (error) {
    setError(error);
  }
}
