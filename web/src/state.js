// The single UI state module. Views read it; every mutation goes through the
// small action functions (actions.js, events.js, module-local helpers) which
// then mark the affected render regions dirty (render.js).

import { isNative, isNativeWindowFocused } from "./native.js";

/** @typedef {import("./types.js").Snapshot} Snapshot */
/** @typedef {import("./types.js").Task} Task */
/** @typedef {import("./types.js").RoomSummary} RoomSummary */
/** @typedef {import("./types.js").VoiceCallInfo} VoiceCallInfo */
/** @typedef {import("./types.js").WorkspaceRecord} WorkspaceRecord */
/** @typedef {import("./types.js").StreamEntry} StreamEntry */
/** @typedef {import("./types.js").PendingAttachment} PendingAttachment */
/** @typedef {import("./types.js").SanitizeProposal} SanitizeProposal */
/** @typedef {import("./types.js").RoomEvent} RoomEvent */
/** @typedef {import("./types.js").ChatSearchHit} ChatSearchHit */
/** @typedef {import("./types.js").FileDescriptor} FileDescriptor */
/** @typedef {import("./types.js").EditableFile} EditableFile */
/** @typedef {import("./types.js").FileHints} FileHints */
/** @typedef {import("./types.js").KeepAwakeCapability} KeepAwakeCapability */
/** @typedef {import("./eventchannel.js").EventChannel} EventChannel */

/**
 * @type {{
 *   workspaces: WorkspaceRecord[],
 *   snapshot: Snapshot|null,
 *   streams: Map<string, StreamEntry>,
 *   eventSource: EventSource|EventChannel|null,
 *   error: string,
 *   composerText: string,
 *   pendingAttachments: PendingAttachment[],
 *   editingEventId: string|null,
 *   editingAttachments: import("./types.js").MessageAttachment[],
 *   completionIndex: number,
 *   completionHidden: boolean,
 *   expandedActivities: Set<string>,
 *   expandedRooms: Set<string>,
 *   roomsShown: number,
 *   roomsFavoritesOnly: boolean,
 *   older: {roomId: string, events: RoomEvent[], loading: boolean, lastTotal: number},
 *   openTabs: string[],
 *   sidebarCollapsed: boolean,
 *   rightCollapsed: boolean,
 *   themePaletteOpen: boolean,
 *   voice: VoiceCallInfo|null,
 *   voicePendingAgentId: string|null,
 *   voiceStatusText: string,
 *   micMuted: boolean,
 *   dictating: boolean,
 *   dictationBusy: boolean,
 *   dictationLevel: number,
 *   dictationBars: number[],
 *   dictationError: string,
 *   dictationDrafts: {id: string, bytes: number, mtimeMs: number}[],
 *   readAloud: {eventId: string, phase: "loading"|"playing"|"paused"|"ended", workspaceId: string, roomId: string}|null,
 *   dario: {open: boolean, loading: boolean, proposal: SanitizeProposal|null, error: string, selected: Set<string>, knownAt: string|null, lastAutoEventId: string},
 *   contextGate: {resolving: boolean, error: string, lastN: number},
 *   search: {open: boolean, scope: "chatwide"|"room", query: string, workspace: string, hits: ChatSearchHit[], degraded: string[], loading: boolean, seq: number, active: number, highlightEventId: string},
 *   thinkingMenuOpen: boolean,
 *   usage: Record<string, import("./types.js").UsageLimits>,
 *   usagePopoverOpen: boolean,
 *   usageRefreshing: boolean,
 *   bgTasksOpen: boolean,
 *   summonListOpen: boolean,
 *   sidebarFocus: {kind: "workspace"|"room", id: string}|null,
 *   roomContextMenu: {roomId: string, x: number, y: number}|null,
 *   workspaceContextMenu: {workspaceId: string, x: number, y: number}|null,
 *   readMarks: Record<string, number>,
 *   manualUnread: Record<string, boolean>,
 *   workspaceRooms: Record<string, RoomSummary[]>,
 *   settingsOpen: boolean,
 *   settingsTab: "general"|"workspace"|"agents"|"accounts",
 *   settingsAgentId: string|null,
 *   settingsAgentView: "config"|"persona"|"memory",
 *   settingsWorkspaceFiles: FileDescriptor[],
 *   settingsGlobalFiles: FileDescriptor[],
 *   settingsSelectedWorkspaceFileId: string|null,
 *   settingsSelectedAgentFileId: string|null,
 *   settingsFile: EditableFile|null,
 *   settingsFileHints: FileHints|undefined,
 *   settingsDraft: any,
 *   settingsView: "form"|"raw",
 *   settingsError: string,
 *   keepAwake: KeepAwakeCapability,
 *   userName: string,
 * }}
 */
export const state = {
  workspaces: [],
  snapshot: null,
  // In-flight agent replies keyed by the reserved transcript event id (the
  // v2 SSE `eventId`). v1's author+text snapshot-merge heuristic is gone.
  streams: new Map(),
  eventSource: null,
  error: "",
  composerText: "",
  // Files pasted into the composer (system paste, no button), shown as a
  // preview strip; uploaded and attached when the message is sent.
  pendingAttachments: [],
  // Set while the composer is editing an existing user message (claude.ai
  // style): submit forks the room at that message instead of appending.
  editingEventId: null,
  // The edited message's own attachments, editable (removable, not
  // addable — pasting new files is blocked during edit) while editingEventId
  // is set. Whatever remains here at submit time is what survives the edit.
  editingAttachments: [],
  completionIndex: 0,
  completionHidden: false,
  expandedActivities: new Set(),
  // Which parent rooms are expanded in the sidebar's nested rooms tree. Summon
  // sub-rooms are collapsed under their parent by default.
  expandedRooms: new Set(),
  // How many top-level rooms the sidebar list renders before "show more" —
  // rooms are chats, and a 100-chat history import must not flood the list.
  roomsShown: 25,
  // Sidebar room-list filter: show just favorited rooms (plus their ancestor
  // containers so favorite summon subrooms stay reachable). Persisted per app.
  roomsFavoritesOnly: loadBoolean("gaia.roomsFavoritesOnly"),
  // Older committed events paged in by the transcript's "load older" button,
  // strictly preceding the snapshot's tail window. Cleared on room switch and
  // whenever the transcript shrinks (rewind/truncate → lastTotal drops).
  older: { roomId: "", events: [], loading: false, lastTotal: 0 },
  // The tmux-style working set: room ids open as tabs, in user order. Persisted
  // per workspace; the sidebar tree remains the full list of every room.
  openTabs: [],
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
  // Composer dictation (voice input, this-tab-only): recording the mic clip,
  // then transcribing it. Distinct from a live call's micMuted (see voice.js
  // / dictation.js). The live session itself is in-memory-only on the
  // client; the daemon separately keeps each clip on disk (streamed there
  // chunk-by-chunk during recording) for crash/reload durability —
  // dictationDrafts below is the recovered summary of that server-side layer,
  // not the live recording state.
  dictating: false,
  dictationBusy: false,
  dictationLevel: 0,
  dictationBars: [],
  dictationError: "",
  // Recovered clips (from a crash/reload) the daemon still has on disk for
  // the current room, surfaced as dismissable/transcribable chips in the
  // composer. Never gates send or the mic — see dictation.js's
  // refreshRecoveredClips.
  dictationDrafts: [],
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
  // Per-room "last activity seen" marks for the sidebar unread badge, keyed
  // "<workspaceId>::<roomId>". Persisted so unread survives a reload. A room
  // reads as unread when its lastActivity exceeds the mark captured while it
  // was last open (see syncReadMarks / roomUnread).
  // Usage limits per subscription ACCOUNT ("anthropic", "openai"), pushed by
  // the daemon's `usage-limits` SSE event (and re-seeded on every SSE connect
  // from the daemon's disk-backed cache). Not tied to the open room; rendered
  // as the status-bar usage chip + popover.
  usage: {},
  usagePopoverOpen: false,
  // True while the popover's manual-refresh POST is in flight (disables the button).
  usageRefreshing: false,
  bgTasksOpen: false,
  summonListOpen: false,
  // The sidebar's delete target: the last workspace/room the user clicked. The
  // OS delete chord (⌘⌫ on macOS, Del elsewhere) removes the focused ROOM only
  // (workspace removal is right-click -> "Remove workspace", never this chord —
  // see keys.js and sidebar.js's workspace context menu). null falls back to
  // the current room (see effectiveSidebarFocus).
  sidebarFocus: null,
  roomContextMenu: null,
  workspaceContextMenu: null,
  readMarks: loadReadMarks(),
  manualUnread: loadManualUnread(),
  // Per-workspace room activity (running + last-activity), keyed by workspace id,
  // for the sidebar's workspace-level dots. Seeded by the app payload, kept fresh
  // by the cross-workspace `rooms` broadcasts (which fire for EVERY workspace,
  // not just the open one). The open workspace reads live from state.snapshot.
  workspaceRooms: {},
  // The Settings modal (sidebar's "settings" button / see settings.js). Files are
  // raw-edited for now (JSON/markdown content + textarea); settingsFileHints mirrors
  // whatever file is currently open so a later smart-form renderer can drive
  // hint-aware controls off one place without threading through settingsFile.
  settingsOpen: false,
  settingsTab: "general",
  settingsAgentId: null,
  settingsAgentView: "config",
  // Editable-file catalogs: workspace-scoped ones refresh on every app/snapshot
  // payload (see actions.js); global ones (general/voice/agents) only arrive with
  // the app payload, since they don't vary per workspace.
  settingsWorkspaceFiles: [],
  settingsGlobalFiles: [],
  settingsSelectedWorkspaceFileId: null,
  settingsSelectedAgentFileId: null,
  settingsFile: null,
  settingsFileHints: undefined,
  // The hints-driven form's working copy of the open JSON file, parsed once on
  // load (settings.js's syncDraftFromFile); null when the file has no hints or
  // fails to parse, which forces the raw-only fallback. settingsView is the
  // user's form/raw toggle choice, only meaningful while a draft exists — see
  // FileEditor's `canForm` gate, which coerces back to raw regardless of this
  // when a draft isn't available.
  settingsDraft: null,
  settingsView: "form",
  settingsError: "",
  // "Keep laptop awake while GAIA runs" — daemon-managed, macOS-only capability
  // served in /api/app; `supported` false elsewhere hides the control entirely.
  keepAwake: { supported: false, enabled: false },
  // "Your name" (Settings ▸ General) — replaces the anonymous "user" token in
  // what agents see of the human's own messages. "" = unset.
  userName: "",
};

/** @param {string} workspaceId @param {string} roomId */
function readMarkKey(workspaceId, roomId) {
  return `${workspaceId}::${roomId}`;
}

/** @param {string} key @returns {boolean} */
function loadBoolean(key) {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

/** @returns {Record<string, number>} */
function loadReadMarks() {
  try {
    return JSON.parse(localStorage.getItem("gaia.readMarks") ?? "{}") || {};
  } catch {
    return {};
  }
}

/** @returns {Record<string, boolean>} */
function loadManualUnread() {
  try {
    return JSON.parse(localStorage.getItem("gaia.manualUnread") ?? "{}") || {};
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

function persistManualUnread() {
  try {
    localStorage.setItem("gaia.manualUnread", JSON.stringify(state.manualUnread));
  } catch {
    // Private mode / quota — manual unread just won't survive a reload.
  }
}

export function persistRoomsFavoritesOnly() {
  try {
    localStorage.setItem("gaia.roomsFavoritesOnly", state.roomsFavoritesOnly ? "true" : "false");
  } catch {
    // storage disabled — the filter just won't survive a reload.
  }
}

/**
 * The workspace + room the user last had open, persisted client-side so a
 * refresh — or a full daemon restart — restores exactly where they were. The
 * daemon's own current-room map is in-memory and resets on restart, and `/api/app`
 * otherwise falls back to the most-recently-touched workspace, so this is the
 * only thing that survives both. Written to two stores: `sessionStorage` is
 * per-window and gives an exact restore across dev reloads of that same window
 * (each window keeps its own room instead of clobbering the others); `localStorage`
 * is shared across windows/launches and is only consulted as a fallback — e.g. a
 * brand-new window/tab with no session history yet, or a fresh app launch.
 * @typedef {{ workspaceId: string, roomId: string }} OpenLocation
 */

/** @param {Snapshot|null} snapshot */
export function rememberLocation(snapshot) {
  if (!snapshot) return;
  const payload = JSON.stringify({ workspaceId: snapshot.workspace.id, roomId: snapshot.room.id });
  try {
    sessionStorage.setItem("gaia.lastOpen", payload);
  } catch {
    // Private mode / quota — this window just won't get exact reload restore.
  }
  try {
    localStorage.setItem("gaia.lastOpen", payload);
  } catch {
    // storage disabled — location just won't survive a reload.
  }
}

/** @returns {OpenLocation|null} */
export function recallLocation() {
  try {
    const value = JSON.parse(sessionStorage.getItem("gaia.lastOpen") ?? "null");
    if (value && typeof value.workspaceId === "string" && typeof value.roomId === "string") return value;
  } catch {
    // fall through to localStorage
  }
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
  const focused = isWindowFocused();
  let changed = false;
  // Baseline every room in every OTHER workspace on first sight, so a workspace
  // you haven't opened — or one that gains activity in the background — is never
  // retroactively marked unread. Only NEW activity after this baseline lights
  // its workspace dot. (The open workspace is handled with live marks below.)
  const openWs = state.snapshot?.workspace.id;
  for (const [workspaceId, rooms] of Object.entries(state.workspaceRooms)) {
    if (workspaceId === openWs) continue;
    for (const room of rooms) {
      const key = readMarkKey(workspaceId, room.id);
      if (state.readMarks[key] === undefined) {
        state.readMarks[key] = room.lastActivity ?? 0;
        changed = true;
      }
    }
  }
  const snapshot = state.snapshot;
  if (snapshot) {
    const ws = snapshot.workspace.id;
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
  }
  if (changed) persistReadMarks();
}

/** Mark a room read from the client's attention ledger. Used when a room is
 * explicitly opened; separate from syncReadMarks so a user can deliberately mark
 * the currently-open room unread from the context menu.
 * @param {string} workspaceId @param {string} roomId @param {number} [activity] */
export function markRoomRead(workspaceId, roomId, activity = 0) {
  const key = readMarkKey(workspaceId, roomId);
  state.readMarks[key] = activity;
  delete state.manualUnread[key];
  persistReadMarks();
  persistManualUnread();
}

/** Force a room to show the existing unread marker until it is explicitly opened
 * again or marked read. This is client-local, like the rest of unread state.
 * @param {string} workspaceId @param {RoomSummary} room */
export function markRoomUnread(workspaceId, room) {
  const key = readMarkKey(workspaceId, room.id);
  state.manualUnread[key] = true;
  state.readMarks[key] = Math.max(0, (room.lastActivity ?? 1) - 1);
  persistReadMarks();
  persistManualUnread();
}

/** Reload the read marks from localStorage — another GAIA window advanced them
 * (a `storage` event). Lets the badge-driving main window notice a room was read
 * elsewhere and drop it from the count. */
export function reloadReadMarks() {
  state.readMarks = loadReadMarks();
  state.manualUnread = loadManualUnread();
}

/** A room in a given workspace has activity newer than the mark captured while
 * it was last open. The workspace-scoped core shared by roomUnread (open
 * workspace) and workspaceActivity (any workspace's rollup).
 * @param {string} workspaceId @param {RoomSummary} room @returns {boolean} */
function roomUnreadIn(workspaceId, room) {
  const key = readMarkKey(workspaceId, room.id);
  const mark = state.readMarks[key] ?? 0;
  return state.manualUnread[key] === true || (room.lastActivity ?? 0) > mark;
}

/** A room has unread agent activity: newer than what we saw while it was open,
 * or explicitly marked unread from the room context menu.
 * @param {RoomSummary} room @returns {boolean} */
export function roomUnread(room) {
  const snapshot = state.snapshot;
  if (!snapshot) return false;
  return roomUnreadIn(snapshot.workspace.id, room);
}

/**
 * The rolled-up activity of a whole workspace, for the sidebar's workspace-level
 * dots: `running` if any room in it has a turn mid-flight, `unread` if any
 * TOP-LEVEL room has agent activity newer than the mark we captured for it. The
 * open workspace reads its live rooms from the snapshot (correct running + a
 * just-read open room clears); every other workspace reads from
 * state.workspaceRooms, kept fresh by the cross-workspace `rooms` broadcasts.
 * A summon sub-room's own unread is deliberately excluded from the `unread`
 * rollup (though still folded into `running`, which is a live-status signal,
 * not a "read me" one): a summon's delivered result already lands as new
 * activity in its top-level ancestor, which is what should light the dot — not
 * every finished worker underneath it (see roomPending for the same rule on
 * notifications/badge).
 * @param {string} workspaceId @returns {{running: boolean, unread: boolean}}
 */
export function workspaceActivity(workspaceId) {
  const rooms = state.snapshot?.workspace.id === workspaceId ? (state.snapshot.rooms ?? []) : (state.workspaceRooms[workspaceId] ?? []);
  let running = false;
  let unread = false;
  for (const room of rooms) {
    if (room.running) running = true;
    if (!room.parentRoomId && roomUnreadIn(workspaceId, room)) unread = true;
    if (running && unread) break;
  }
  return { running, unread };
}

/** A room has activity awaiting the user's attention — like roomUnread, but the
 * open room counts too when the window isn't focused (an agent that finished
 * while you looked away is exactly what the dock badge / notification is for).
 * syncReadMarks keeps the focused-and-current room's mark level, so this stays
 * false there. Drives the badge count and completion notifications.
 *
 * Summon sub-rooms (room.parentRoomId set — every sub-room today, since that's
 * the only way one gets created) never themselves count: a finished summon
 * already lands its result as a new message in its parent, which is what
 * badges/notifies. Counting the sub-room too would double up — one ping per
 * summon PLUS one for the parent's own reply — exactly the spam this guards
 * against when many summons finish at once. A future user-created sub-room
 * (not a summon) would still want its own notification; that distinction isn't
 * representable yet, so for now this excludes every room with a parent.
 * @param {RoomSummary} room @returns {boolean} */
export function roomPending(room) {
  const snapshot = state.snapshot;
  if (!snapshot) return false;
  if (room.parentRoomId) return false;
  return roomUnreadIn(snapshot.workspace.id, room);
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
