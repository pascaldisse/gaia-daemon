// The single UI state module. Views read it; every mutation goes through the
// small action functions (actions.js, events.js, module-local helpers) which
// then mark the affected render regions dirty (render.js).

/** @typedef {import("./types.js").Snapshot} Snapshot */
/** @typedef {import("./types.js").Task} Task */
/** @typedef {import("./types.js").RoomSummary} RoomSummary */
/** @typedef {import("./types.js").VoiceCallInfo} VoiceCallInfo */
/** @typedef {import("./types.js").WorkspaceRecord} WorkspaceRecord */
/** @typedef {import("./types.js").FileDescriptor} FileDescriptor */
/** @typedef {import("./types.js").EditableFile} EditableFile */
/** @typedef {import("./types.js").StreamEntry} StreamEntry */

/**
 * @type {{
 *   workspaces: WorkspaceRecord[],
 *   snapshot: Snapshot|null,
 *   streams: Map<string, StreamEntry>,
 *   workspaceFiles: FileDescriptor[],
 *   globalFiles: FileDescriptor[],
 *   selectedWorkspaceFileId: string|null,
 *   selectedGlobalFileId: string|null,
 *   workspaceFile: EditableFile|null,
 *   globalFile: EditableFile|null,
 *   workspaceRaw: boolean,
 *   globalRaw: boolean,
 *   selectedGlobalSection: string,
 *   settingsOpen: boolean,
 *   eventSource: EventSource|null,
 *   error: string,
 *   composerText: string,
 *   completionIndex: number,
 *   completionHidden: boolean,
 *   expandedActivities: Set<string>,
 *   expandedRooms: Set<string>,
 *   openTabs: string[],
 *   tabDragId: string|null,
 *   sidebarCollapsed: boolean,
 *   rightCollapsed: boolean,
 *   themePaletteOpen: boolean,
 *   voice: VoiceCallInfo|null,
 *   voicePendingAgentId: string|null,
 *   voiceStatusText: string,
 *   micMuted: boolean,
 *   thinkingMenuOpen: boolean,
 *   addAgentOpen: boolean,
 *   addAgentId: string,
 *   addAgentName: string,
 *   addAgentError: string,
 * }}
 */
export const state = {
  workspaces: [],
  snapshot: null,
  // In-flight agent replies keyed by the reserved transcript event id (the
  // v2 SSE `eventId`). v1's author+text snapshot-merge heuristic is gone.
  streams: new Map(),
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
  // tab that started the call also holds the audio session (see voice.js).
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

/** @param {Snapshot|null} [snapshot] @returns {Task|null} */
export function activeTask(snapshot = state.snapshot) {
  return (snapshot?.tasks ?? []).find((task) => task.status === "running") ?? null;
}

/**
 * Summon sub-rooms whose first turn is still streaming, surfaced on the rooms
 * list so the panic stop can reach background workers in other rooms.
 * @param {Snapshot|null} [snapshot]
 * @returns {RoomSummary[]}
 */
export function runningSummonRooms(snapshot = state.snapshot) {
  return (snapshot?.rooms ?? []).filter((room) => room.running);
}

/**
 * "Busy" = a room turn is running OR any summoned worker is still running.
 * Esc / Ctrl+C / the stop button all act on this so nothing is unstoppable.
 * @param {Snapshot|null} [snapshot]
 */
export function isBusy(snapshot = state.snapshot) {
  return Boolean(activeTask(snapshot)) || runningSummonRooms(snapshot).length > 0;
}
