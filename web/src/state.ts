// Shared mutable UI state. Views read it; actions/events mutate it and re-render.
export const state = {
  app: null,
  snapshot: null,
  workspaceFiles: [],
  globalFiles: [],
  selectedWorkspaceFileId: null,
  selectedGlobalFileId: null,
  workspaceFile: null,
  globalFile: null,
  workspaceRaw: false,
  globalRaw: false,
  selectedGlobalSection: "general",
  selectedGlobalAgentId: null,
  selectedGlobalAgentView: "config",
  settingsOpen: false,
  eventSource: null,
  error: "",
  composerText: "",
  completionIndex: 0,
  completionHidden: false,
  expandedActivities: new Set(),
};

export function activeTask(snapshot = state.snapshot) {
  return (snapshot?.tasks ?? []).find((task) => task.status === "running") ?? null;
}
