// chrome.js — window/tab "chrome" actions, shared by the three things that drive
// them so they can never drift apart:
//   * keys.js          keyboard shortcuts (browser fallback + in-web chords)
//   * main.js          the native menu + redock listeners (Tauri)
//   * tabsbar.js       the tab strip (tear-off, dock button)
// Native-window actions degrade to no-ops in a plain browser, keeping the web
// build a working backup.
import { addRoom, closeRoomTab, selectRoom } from "./actions.js";
import { closeCurrentWindow, isMainWindow, isNative, openWindow, redockCurrent } from "./native.js";
import { markDirty } from "./render.js";
import { state } from "./state.js";
import { openTab, visibleTabs } from "./tabs.js";

function workspaceId() {
  return state.snapshot?.workspace.id;
}
function currentRoomId() {
  return state.snapshot?.room?.id;
}

/** New room in the current workspace (auto-named — no dialog). A tab *is* a
 * room here, so this backs both "New Tab" (⌘T) and "New Room" (⌘⇧N) and the
 * "+" button. */
export function newTab() {
  void addRoom();
}

/** New incognito (memory-off) room in the current workspace — auto-named, no
 * dialog. Backs "New Incognito Room" (⌥⌘⇧N) and ⌥-click on the "+" button. */
export function newIncognitoRoom() {
  void addRoom({ incognito: true });
}

/** New native window with the standard view (panels normal). Native only. */
export function newWindow() {
  if (isNative()) void openWindow({ mode: "new" });
}

/**
 * Close the current tab. In a subordinate (torn) native window, there is no tab
 * set to speak of, so this closes the window instead — matching Cmd+W's native
 * "close tab, else close window" behaviour.
 */
export function closeCurrent() {
  if (isNative() && !isMainWindow()) {
    void closeCurrentWindow();
    return;
  }
  const id = currentRoomId();
  if (id) void closeRoomTab(id);
}

export function nextTab() {
  step(1);
}
export function prevTab() {
  step(-1);
}

/** @param {number} direction */
function step(direction) {
  const tabs = visibleTabs(state.snapshot);
  if (tabs.length < 2) return;
  const wsId = workspaceId();
  const currentId = currentRoomId();
  const current = tabs.findIndex((room) => room.id === currentId);
  const next = tabs[(current + direction + tabs.length) % tabs.length];
  if (next && wsId && next.id !== currentId) void selectRoom(wsId, next.id);
}

/** @param {number} index 0-based tab position (Cmd/Ctrl+1..9). */
export function jumpTab(index) {
  const tabs = visibleTabs(state.snapshot);
  const room = tabs[index];
  const wsId = workspaceId();
  if (room && wsId && room.id !== currentRoomId()) void selectRoom(wsId, room.id);
}

/** Toggle the left sessions sidebar. */
export function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  markDirty("layout", "tabs");
}
/** Toggle the right room panel. */
export function togglePanel() {
  state.rightCollapsed = !state.rightCollapsed;
  markDirty("layout", "tabs");
}

/** Merge a subordinate (torn) window's chat back into the main window as a tab.
 *  The shell relays the room to the main window and closes this one. Native only. */
export function dockBack() {
  if (isNative() && !isMainWindow()) {
    const id = currentRoomId();
    if (id) void redockCurrent(id);
  }
}

/**
 * Tear a tab out into its own native window at a screen point (the drop
 * location). Returns true if it handled the tear-off, so the source strip can
 * drop the tab. No-op (false) in a plain browser.
 * @param {string} roomId
 * @param {number} screenX
 * @param {number} screenY
 */
export function tearOff(roomId, screenX, screenY) {
  if (!isNative() || !roomId) return false;
  void openWindow({ mode: "torn", room: roomId, x: Math.round(screenX), y: Math.round(screenY) });
  return true;
}

/** Main window receives a redock from a torn window: adopt the room as a tab and
 *  bring it into view. @param {string} roomId */
export function adoptRoomTab(roomId) {
  const wsId = workspaceId();
  if (!roomId || !wsId) return;
  openTab(roomId, wsId);
  void selectRoom(wsId, roomId);
}
