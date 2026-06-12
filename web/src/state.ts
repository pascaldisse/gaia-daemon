// Shared mutable UI state. Views read it; actions/events mutate it and re-render.
export const state = {
  workspaces: [],
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
  settingsOpen: false,
  eventSource: null,
  error: "",
  composerText: "",
  completionIndex: 0,
  completionHidden: false,
  expandedActivities: new Set(),
  // Active voice call binding from the server (visible to every tab); the
  // tab that started the call also holds the audio session (see voice.ts).
  voice: null,
  voicePendingAgentId: null,
  voiceStatusText: "",
  micMuted: false,
  thinkingMenuOpen: false,
};

export function activeTask(snapshot = state.snapshot) {
  return (snapshot?.tasks ?? []).find((task) => task.status === "running") ?? null;
}
