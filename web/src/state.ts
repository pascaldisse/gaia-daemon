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
  // Which parent rooms are expanded in the sidebar's nested rooms tree. Summon
  // sub-rooms are collapsed under their parent by default.
  expandedRooms: new Set(),
  // The tmux-style working set: room ids open as tabs, in user order. Persisted
  // per workspace; the sidebar tree remains the full list of every room.
  openTabs: [],
  tabDragId: null,
  // Collapsible panes (Ctrl+B / Ctrl+G), like zooming a tmux pane.
  sidebarCollapsed: false,
  rightCollapsed: false,
  // The omarchy-style theme palette overlay.
  themePaletteOpen: false,
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

// Summon sub-rooms whose first turn is still streaming, surfaced on the rooms
// list so the panic stop can reach background workers in other rooms.
export function runningSummonRooms(snapshot = state.snapshot) {
  return (snapshot?.rooms ?? []).filter((room) => room.running);
}

// "Busy" = a room turn is running OR any summoned worker is still running.
// Esc / Ctrl+C / the stop button all act on this so nothing is unstoppable.
export function isBusy(snapshot = state.snapshot) {
  return Boolean(activeTask(snapshot)) || runningSummonRooms(snapshot).length > 0;
}
