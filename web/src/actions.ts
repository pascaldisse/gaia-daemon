import { api } from "./api.ts";
import { connectEvents } from "./events.ts";
import { render, setError } from "./render.ts";
import { loadInitialFiles, loadSelectedWorkspaceFile } from "./settings.ts";
import { activeTask, state } from "./state.ts";

async function applyAppPayload(body) {
  state.workspaces = body.workspaces ?? [];
  state.snapshot = body.snapshot ?? null;
  state.workspaceFiles = body.workspaceFiles ?? [];
  state.globalFiles = body.globalFiles ?? state.globalFiles;
  state.voice = body.voice ?? null;
  connectEvents();
  await loadInitialFiles();
  setError("");
}

export async function loadApp(currentWorkspaceId) {
  try {
    const body = await api("/api/app");
    await applyAppPayload(body);
    if (currentWorkspaceId && body.currentWorkspaceId !== currentWorkspaceId) await loadWorkspace(currentWorkspaceId);
  } catch (error) {
    setError(error);
  }
}

export async function loadWorkspace(workspaceId) {
  try {
    const body = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/snapshot`);
    state.snapshot = body.snapshot;
    state.workspaceFiles = body.workspaceFiles ?? [];
    state.voice = body.voice ?? null;
    state.selectedWorkspaceFileId = state.workspaceFiles[0]?.id ?? null;
    state.workspaceFile = null;
    connectEvents();
    await loadSelectedWorkspaceFile();
    setError("");
  } catch (error) {
    setError(error);
  }
}

export async function addWorkspace() {
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

export async function selectRoom(workspaceId, roomId) {
  try {
    const body = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/rooms/${encodeURIComponent(roomId)}/select`, {
      method: "POST",
      body: "{}",
    });
    state.snapshot = body.snapshot;
    state.workspaceFiles = body.workspaceFiles ?? [];
    state.voice = body.voice ?? null;
    state.selectedWorkspaceFileId = state.workspaceFiles[0]?.id ?? null;
    state.workspaceFile = null;
    connectEvents();
    await loadSelectedWorkspaceFile();
    setError("");
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

export async function sendMessage(text) {
  const snapshot = state.snapshot;
  if (!snapshot || !text.trim()) return;
  try {
    await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
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
