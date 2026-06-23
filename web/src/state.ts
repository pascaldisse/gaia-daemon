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
  selectedSummonId: null,
  selectedSummon: null,
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
  addAgentOpen: false,
  addAgentId: "",
  addAgentName: "",
  addAgentError: "",
};

export function activeTask(snapshot = state.snapshot) {
  return (snapshot?.tasks ?? []).find((task) => task.status === "running") ?? null;
}

export function runningSummons(snapshot = state.snapshot) {
  return (snapshot?.summons ?? []).filter((summon) => summon.status === "running");
}

// "Busy" = a room turn is running OR any summoned worker is still running.
// Esc / Ctrl+C / the stop button all act on this so nothing is unstoppable.
export function isBusy(snapshot = state.snapshot) {
  return Boolean(activeTask(snapshot)) || runningSummons(snapshot).length > 0;
}
