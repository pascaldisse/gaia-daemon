// The single UI state module. Views read it; every mutation goes through the
// small action functions (actions.js, events.js, module-local helpers) which
// then mark the affected render regions dirty (render.js).

import { isNative, isNativeWindowFocused } from "./native.js";

/** @typedef {import("./types.js").Snapshot} Snapshot */
/** @typedef {import("./types.js").Task} Task */
/** @typedef {import("./types.js").RoomSummary} RoomSummary */
/** @typedef {import("./types.js").VoiceCallInfo} VoiceCallInfo */
/** @typedef {import("./types.js").WorkspaceRecord} WorkspaceRecord */
/** @typedef {import("./types.js").FileDescriptor} FileDescriptor */
/** @typedef {import("./types.js").EditableFile} EditableFile */
/** @typedef {import("./types.js").StreamEntry} StreamEntry */
/** @typedef {import("./types.js").PendingAttachment} PendingAttachment */
/** @typedef {import("./types.js").SanitizeProposal} SanitizeProposal */
/** @typedef {import("./types.js").RoomEvent} RoomEvent */
/** @typedef {import("./types.js").ChatSearchHit} ChatSearchHit */

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
 *   pendingAttachments: PendingAttachment[],
 *   editingEventId: string|null,
 *   completionIndex: number,
 *   completionHidden: boolean,
 *   expandedActivities: Set<string>,
 *   expandedRooms: Set<string>,
 *   roomsShown: number,
 *   older: {roomId: string, events: RoomEvent[], loading: boolean, lastTotal: number},
 *   openTabs: string[],
 *   tabDragId: string|null,
 *   sidebarCollapsed: boolean,
 *   rightCollapsed: boolean,
 *   themePaletteOpen: boolean,
 *   voice: VoiceCallInfo|null,
 *   voicePendingAgentId: string|null,
 *   voiceStatusText: string,
 *   micMuted: boolean,
 *   dictating: boolean,
 *   dictationBusy: boolean,
 *   readAloud: {eventId: string, phase: "loading"|"playing"|"paused"|"ended", workspaceId: string, roomId: string}|null,
 *   dario: {open: boolean, loading: boolean, proposal: SanitizeProposal|null, error: string, selected: Set<string>, knownAt: string|null, lastAutoEventId: string},
 *   contextGate: {resolving: boolean, error: string, lastN: number},
 *   search: {open: boolean, scope: "chatwide"|"room", query: string, workspace: string, hits: ChatSearchHit[], degraded: string[], loading: boolean, seq: number, active: number, highlightEventId: string},
 *   thinkingMenuOpen: boolean,
 *   addAgentOpen: boolean,
 *   addAgentId: string,
 *   addAgentName: string,
 *   addAgentError: string,
 *   usage: Record<string, import("./types.js").UsageLimits>,
 *   usagePopoverOpen: boolean,
 *   bgTasksOpen: boolean,
 *   summonListOpen: boolean,
 *   sidebarFocus: {kind: "workspace"|"room", id: string}|null,
 *   readMarks: Record<string, number>,
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
  // Files pasted into the composer (system paste, no button), shown as a
  // preview strip; uploaded and attached when the message is sent.
  pendingAttachments: [],
  // Set while the composer is editing an existing user message (claude.ai
  // style): submit forks the room at that message instead of appending.
  editingEventId: null,
  completionIndex: 0,
  completionHidden: false,
  expandedActivities: new Set(),
  // Which parent rooms are expanded in the sidebar's nested rooms tree. Summon
  // sub-rooms are collapsed under their parent by default.
  expandedRooms: new Set(),
  // How many top-level rooms the sidebar list renders before "show more" —
  // rooms are chats, and a 100-chat history import must not flood the list.
  roomsShown: 25,
  // Older committed events paged in by the transcript's "load older" button,
  // strictly preceding the snapshot's tail window. Cleared on room switch and
  // whenever the transcript shrinks (rewind/truncate → lastTotal drops).
  older: { roomId: "", events: [], loading: false, lastTotal: 0 },
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
  // Composer dictation (voice input, this tab only): recording the mic clip,
  // then transcribing it. Distinct from a live call's micMuted (see voice.js /
  // dictation.js).
  dictating: false,
  dictationBusy: false,
  // Transcript read-aloud playback (one message at a time, this tab only).
  readAloud: null,
  // The Thanks-Dario review popup: proposal + which suggestion ids are
  // checked. knownAt tracks the last proposal timestamp this tab has seen so
  // a NEW proposal (e.g. from /thanks-dario) opens the popup exactly once.
  dario: { open: false, loading: false, proposal: null, error: "", selected: new Set(), knownAt: null, lastAutoEventId: "" },
  // Context-gate modal (new agent joining a big room). Snapshot-driven (the
  // pending gate lives on snapshot.room.contextGate); this only holds the
  // in-flight resolve state and the "last N" input value.
  contextGate: { resolving: false, error: "", lastN: 20 },
  // Chat search overlay (Cmd/Ctrl+K). scope "chatwide" = every room (filtered
  // by `workspace`: "all" or a workspace id); "room" = the open chat only. seq
  // guards against out-of-order responses; highlightEventId flashes the message
  // a result jumped to (folded into the transcript version stamp).
  search: { open: false, scope: "chatwide", query: "", workspace: "all", hits: [], degraded: [], loading: false, seq: 0, active: 0, highlightEventId: "" },
  thinkingMenuOpen: false,
  addAgentOpen: false,
  addAgentId: "",
  addAgentName: "",
  addAgentError: "",
  // Per-room "last activity seen" marks for the sidebar unread badge, keyed
  // "<workspaceId>::<roomId>". Persisted so unread survives a reload. A room
  // reads as unread when its lastActivity exceeds the mark captured while it
  // was last open (see syncReadMarks / roomUnread).
  // Account usage limits per harness (subscription session/weekly caps),
  // pushed by the daemon's `usage-limits` SSE event. Account-level, not tied to
  // the open room; rendered as the status-bar usage chip + popover.
  usage: {},
  usagePopoverOpen: false,
  bgTasksOpen: false,
  summonListOpen: false,
  // The sidebar's delete target: the last workspace/room the user clicked. The
  // OS delete chord (⌘⌫ on macOS, Del elsewhere) removes whatever this points
  // at — the only way to delete a workspace or room. null falls back to the
  // current room (see effectiveSidebarFocus).
  sidebarFocus: null,
  readMarks: loadReadMarks(),
};

/** @param {string} workspaceId @param {string} roomId */
function readMarkKey(workspaceId, roomId) {
  return `${workspaceId}::${roomId}`;
}

/** @returns {Record<string, number>} */
function loadReadMarks() {
  try {
    return JSON.parse(localStorage.getItem("gaia.readMarks") ?? "{}") || {};
  } catch {
    return {};
  }
}

function persistReadMarks() {
  try {
    localStorage.setItem("gaia.readMarks", JSON.stringify(state.readMarks));
  } catch {
    // Private mode / quota — unread just won't survive a reload.
  }
}

/**
 * The workspace + room the user last had open, persisted client-side so a
 * refresh — or a full daemon restart — restores exactly where they were. The
 * daemon's own current-room map is in-memory and resets on restart, and `/api/app`
 * otherwise falls back to the most-recently-touched workspace, so this is the
 * only thing that survives both.
 * @typedef {{ workspaceId: string, roomId: string }} OpenLocation
 */

/** @param {Snapshot|null} snapshot */
export function rememberLocation(snapshot) {
  if (!snapshot) return;
  try {
    localStorage.setItem("gaia.lastOpen", JSON.stringify({ workspaceId: snapshot.workspace.id, roomId: snapshot.room.id }));
  } catch {
    // storage disabled — location just won't survive a reload.
  }
}

/** @returns {OpenLocation|null} */
export function recallLocation() {
  try {
    const value = JSON.parse(localStorage.getItem("gaia.lastOpen") ?? "null");
    return value && typeof value.workspaceId === "string" && typeof value.roomId === "string" ? value : null;
  } catch {
    return null;
  }
}

/** The window is actually in front of the user (visible and focused). When it
 * is NOT — minimized, another app on top, another tab — a finished turn in the
 * open room stays "unread" so it still badges/notifies, mirroring how Claude
 * Code / Codex ping you only when you've looked away. In the native shell,
 * document.hasFocus() is unreliable (a background WKWebView still reports true),
 * so the shell's real window focus state is used instead. */
export function isWindowFocused() {
  if (typeof document === "undefined") return true;
  const visible = document.visibilityState !== "hidden";
  if (isNative()) return visible && isNativeWindowFocused();
  return visible && document.hasFocus();
}

/**
 * Baseline any room seen for the first time (so nothing is retroactively marked
 * unread on load) and advance the current room's mark to its latest activity —
 * viewing a room IS reading it, but only while the window is actually focused
 * (looking away must not silently clear the pending badge). Call after any
 * snapshot / rooms update, and again when the window regains focus.
 */
export function syncReadMarks() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const ws = snapshot.workspace.id;
  const focused = isWindowFocused();
  let changed = false;
  for (const room of snapshot.rooms ?? []) {
    const key = readMarkKey(ws, room.id);
    const activity = room.lastActivity ?? 0;
    if (state.readMarks[key] === undefined) {
      state.readMarks[key] = activity;
      changed = true;
    } else if (room.isCurrent && focused && state.readMarks[key] < activity) {
      state.readMarks[key] = activity;
      changed = true;
    }
  }
  if (changed) persistReadMarks();
}

/** Reload the read marks from localStorage — another GAIA window advanced them
 * (a `storage` event). Lets the badge-driving main window notice a room was read
 * elsewhere and drop it from the count. */
export function reloadReadMarks() {
  state.readMarks = loadReadMarks();
}

/** A room has unread agent activity: newer than what we saw while it was open.
 * The room being viewed is never unread.
 * @param {RoomSummary} room @returns {boolean} */
export function roomUnread(room) {
  const snapshot = state.snapshot;
  if (room.isCurrent || !snapshot) return false;
  const mark = state.readMarks[readMarkKey(snapshot.workspace.id, room.id)] ?? 0;
  return (room.lastActivity ?? 0) > mark;
}

/** A room has activity awaiting the user's attention — like roomUnread, but the
 * open room counts too when the window isn't focused (an agent that finished
 * while you looked away is exactly what the dock badge / notification is for).
 * syncReadMarks keeps the focused-and-current room's mark level, so this stays
 * false there. Drives the badge count and completion notifications.
 * @param {RoomSummary} room @returns {boolean} */
export function roomPending(room) {
  const snapshot = state.snapshot;
  if (!snapshot) return false;
  const mark = state.readMarks[readMarkKey(snapshot.workspace.id, room.id)] ?? 0;
  return (room.lastActivity ?? 0) > mark;
}

/**
 * The sidebar item the delete chord acts on: the explicit click-selected focus,
 * or — when nothing is explicitly selected — the current room, so a room is
 * always a safe default target and the highlight always matches what delete
 * removes. Returns null only when there's no snapshot at all.
 * @returns {{kind: "workspace"|"room", id: string}|null}
 */
export function effectiveSidebarFocus() {
  if (state.sidebarFocus) return state.sidebarFocus;
  const roomId = state.snapshot?.room.id;
  return roomId ? { kind: "room", id: roomId } : null;
}

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
  // A summon is a BACKGROUND sub-room (it has a parentRoomId) descended from
  // the room being viewed. Any other running room — an unrelated chat with a
  // turn streaming, or another room's summons — is NOT this room's summon:
  // counting those put a "1 summon" badge in every chat and made the panic
  // stop reach into rooms it had no business cancelling. The room you're
  // viewing is excluded too — its own streaming turn is represented by the
  // running agent(s), so this also stops the composer from labelling your
  // current turn "1 summon" and the panic stop from cancelling it twice.
  const rooms = snapshot?.rooms ?? [];
  const currentId = rooms.find((room) => room.isCurrent)?.id;
  if (!currentId) return [];
  const parents = new Map(rooms.map((room) => [room.id, room.parentRoomId]));
  const descendsFromCurrent = (/** @type {string|undefined} */ id) => {
    // Walk the parent chain (summons can nest); hop cap guards a cycle.
    for (let hops = 0; id !== undefined && hops < 16; id = parents.get(id), hops++) {
      if (id === currentId) return true;
    }
    return false;
  };
  return rooms.filter((room) => room.running && !room.isCurrent && descendsFromCurrent(room.parentRoomId));
}

/**
 * "Busy" = a room turn is running OR any summoned worker is still running OR an
 * agent is compacting. The compacting case matters for the context-gate
 * "Compact & join" summary: it has no task of its own, so without this the
 * running/compacting banner (and its progress bar) stayed hidden and the pass
 * looked like a silent black box — the /compact command shows because it runs
 * as a command task. Esc / Ctrl+C / the stop button all act on this.
 * @param {Snapshot|null} [snapshot]
 */
export function isBusy(snapshot = state.snapshot) {
  return (
    Boolean(activeTask(snapshot)) ||
    runningSummonRooms(snapshot).length > 0 ||
    (snapshot?.agents ?? []).some((agent) => agent.status === "compacting")
  );
}
