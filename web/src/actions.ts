import { api } from "./api.ts";
import { connectEvents } from "./events.ts";
import { render, setError } from "./render.ts";
import { loadInitialFiles, loadSelectedWorkspaceFile } from "./settings.ts";
import { activeTask, state } from "./state.ts";

export async function loadApp(currentWorkspaceId) {
  try {
    const body = await api("/api/app");
    state.app = body;
    state.snapshot = body.snapshot ?? null;
    state.workspaceFiles = body.workspaceFiles ?? [];
    state.globalFiles = body.globalFiles ?? [];
    state.voice = body.voice ?? null;
    if (currentWorkspaceId && body.currentWorkspaceId !== currentWorkspaceId) await loadWorkspace(currentWorkspaceId);
    connectEvents();
    await loadInitialFiles();
    setError("");
  } catch (error) {
    setError(error);
  }
}

export async function loadWorkspace(workspaceId) {
  const body = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/snapshot`);
  state.snapshot = body.snapshot;
  state.workspaceFiles = body.workspaceFiles ?? [];
  state.voice = body.voice ?? null;
  state.selectedWorkspaceFileId = state.workspaceFiles[0]?.id ?? null;
  state.workspaceFile = null;
  connectEvents();
  await loadSelectedWorkspaceFile();
  render();
}

export async function addWorkspace() {
  const path = window.prompt("Workspace path");
  if (!path) return;
  try {
    const body = await api("/api/workspaces", { method: "POST", body: JSON.stringify({ path }) });
    state.app = body;
    state.snapshot = body.snapshot ?? null;
    state.workspaceFiles = body.workspaceFiles ?? [];
    state.globalFiles = body.globalFiles ?? state.globalFiles;
    connectEvents();
    await loadInitialFiles();
    setError("");
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
