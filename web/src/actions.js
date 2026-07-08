// Every server mutation goes through these small action functions: they call
// the API, update state, and mark the affected regions. Views never mutate
// state directly.
import { api } from "./api.js";
import { connectEvents, seedLiveTurn } from "./events.js";
import { confirmDialog, promptText } from "./prompt.js";
import { markDirty, setError } from "./render.js";
import { loadInitialFiles, loadSelectedWorkspaceFile } from "./settings.js";
import { activeTask, runningSummonRooms, state, syncReadMarks } from "./state.js";
import { closeTab, openTab, restoreTabs } from "./tabs.js";
import { syncDarioFromSnapshot } from "./dario.js";

/** @typedef {import("./types.js").AppPayload} AppPayload */
/** @typedef {import("./types.js").SnapshotPayload} SnapshotPayload */

/** @param {AppPayload} body */
async function applyAppPayload(body) {
  state.workspaces = body.workspaces ?? [];
  state.snapshot = body.snapshot ?? null;
  state.streams.clear();
  seedLiveTurn();
  syncReadMarks();
  syncDarioFromSnapshot(); // surface a pending Dario proposal on initial load
  state.older = { roomId: state.snapshot?.room.id ?? "", events: [], loading: false, lastTotal: state.snapshot?.room.eventTotal ?? 0 };
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
  seedLiveTurn();
  syncReadMarks();
  syncDarioFromSnapshot(); // surface a pending Dario proposal when switching into a room
  // Workspace/room switch: paged-in older history belongs to the old room.
  state.older = { roomId: body.snapshot.room.id, events: [], loading: false, lastTotal: body.snapshot.room.eventTotal };
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
  if (!path && pickerUnavailable) path = await promptText("Workspace path", { placeholder: "/path/to/workspace" });
  if (!path) return;
  try {
    await applyAppPayload(await api("/api/workspaces", { method: "POST", body: JSON.stringify({ path }) }));
  } catch (error) {
    setError(error);
  }
}

/**
 * @param {string} workspaceId
 * @param {string} roomId
 * @param {{ incognito?: boolean }} [opts] `incognito` only takes effect when this
 *   call creates the room (a no-op when selecting one that already exists).
 */
export async function selectRoom(workspaceId, roomId, opts = {}) {
  try {
    // Read-aloud deliberately keeps playing across a room switch — it only
    // stops when you play another message (or hit stop from the status-bar
    // now-playing chip). So no stopReadAloud() here.
    const body = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/rooms/${encodeURIComponent(roomId)}/select`, {
      method: "POST",
      body: JSON.stringify(opts.incognito ? { incognito: true } : {}),
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

/** Toggle room agent-dialogue (agents responding to each other's @mentions).
 * @param {boolean} on */
export async function setRoomAgentDialogue(on) {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  try {
    const body = await api(
      `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/agent-dialogue`,
      { method: "POST", body: JSON.stringify({ on }) },
    );
    applySnapshotPayload(body);
    state.error = "";
    markDirty();
  } catch (error) {
    setError(error);
  }
}

export async function addRoom() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const result = await promptText("New room name", {
    placeholder: "letters, numbers, dots, hyphens, underscores",
    checkbox: { label: "🕶 Incognito — no memory (no capture, recall, or memory tools)" },
  });
  if (!result || !result.value.trim()) return;
  try {
    await selectRoom(snapshot.workspace.id, result.value.trim(), { incognito: result.checked });
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

/**
 * Permanently delete a room (reversible on the server — it moves to trash and is
 * purged from memory). Confirms first, then DELETEs; the server reselects a
 * neighbour and returns its snapshot, so a room is always in view afterward.
 * @param {string} roomId
 */
export async function deleteRoom(roomId) {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const ok = await confirmDialog(`Delete room "${roomId}"?`, {
    detail: "The room moves to trash (recoverable) and is removed from memory/recall. It won't appear in the sidebar anymore.",
    okLabel: "Delete room",
    danger: true,
  });
  if (!ok) return;
  try {
    closeTab(roomId, snapshot.workspace.id, false); // drop from the working set if open
    const body = await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(roomId)}`, {
      method: "DELETE",
      body: "{}",
    });
    applySnapshotPayload(body);
    if (state.snapshot) openTab(state.snapshot.room.id, state.snapshot.workspace.id);
    connectEvents();
    await loadSelectedWorkspaceFile();
    state.error = "";
    markDirty();
  } catch (error) {
    setError(error);
  }
}

/**
 * Upload one pasted file into the current room's files dir. Raw fetch, not
 * api(): the body is the file's bytes, not JSON.
 * @param {File} file
 * @param {string} name
 * @returns {Promise<import("./types.js").UploadedAttachment>}
 */
export async function uploadAttachment(file, name) {
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error("No room selected");
  const url = `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/files?name=${encodeURIComponent(name)}`;
  const response = await fetch(url, {
    method: "POST",
    ...(file.type ? { headers: { "content-type": file.type } } : {}),
    body: file,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Upload failed: ${response.status}`);
  return body.attachment;
}

/**
 * @param {string} text
 * @param {import("./types.js").UploadedAttachment[]} [attachments]
 * @param {{ queue?: boolean }} [options] queue:true forces the durable queue
 *   (Cmd/Ctrl+Enter) instead of steering the running turn.
 */
export async function sendMessage(text, attachments = [], options = {}) {
  const snapshot = state.snapshot;
  if (!snapshot || (!text.trim() && attachments.length === 0)) return;
  try {
    const body = await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text,
        ...(attachments.length ? { attachments: attachments.map(({ id, name, mime }) => ({ id, name, mime })) } : {}),
        ...(options.queue ? { queue: true } : {}),
      }),
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

/**
 * Retry: regenerate everything from the user message that produced `eventId`
 * (works on an agent reply or a user message). The server forks the room
 * there — later events move to rewound.jsonl — and re-runs the same text.
 * @param {string} eventId
 */
export async function retryMessage(eventId) {
  await forkMessage("retry", { eventId });
}

/**
 * Edit: fork the room at the user message `eventId` and re-send it as `text`.
 * @param {string} eventId
 * @param {string} text
 */
export async function editMessage(eventId, text) {
  await forkMessage("edit", { eventId, text });
}

/** @param {"retry"|"edit"} action @param {{ eventId: string, text?: string }} payload */
async function forkMessage(action, payload) {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  try {
    const body = await api(
      `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/${action}`,
      { method: "POST", body: JSON.stringify(payload) },
    );
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
