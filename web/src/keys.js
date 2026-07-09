// Keyboard control — native, OS-standard chords. `mod` is Cmd on macOS and Ctrl
// everywhere else (kept engine/OS-agnostic).
//
// Inside the GAIA shell the *native menu* (src-tauri) owns the window/tab chrome
// chords, so they behave exactly like every other Mac app and appear in the menu
// bar; this handler then only covers the in-web bits below. In a plain browser
// there is no menu, so the same chords are handled here as a fallback.
//   mod+T  new tab / room        mod+Shift+N  new room        mod+N  new window
//   mod+Alt+Shift+N  new incognito room        mod+W  close tab / window
//   mod+1..9  jump to tab N            mod+Shift+] / mod+Shift+[  next / prev tab
//   mod+B  sessions sidebar            mod+Alt+B  room panel
//   mod+K  search all chats            mod+F  search this chat
//   Alt+T  theme palette   Alt+Shift+T  cycle theme   Esc  close overlays
import { deleteRoom, deleteWorkspace, renameRoom } from "./actions.js";
import { jumpTab, newIncognitoRoom, newTab, nextTab, prevTab, togglePanel, toggleSidebar } from "./chrome.js";
import { isNative } from "./native.js";
import { markDirty } from "./render.js";
import { closeSearch, openSearch } from "./search.js";
import { effectiveSidebarFocus, state } from "./state.js";
import { closeBgTasks, closeThemePalette, closeUsagePopover, openThemePalette } from "./statusbar.js";
import { cycleTheme } from "./themes.js";

const IS_MAC = /mac|iphone|ipad/i.test(
  (typeof navigator !== "undefined" &&
    (/** @type {any} */ (navigator).userAgentData?.platform || navigator.platform || navigator.userAgent)) ||
    "",
);

/** The platform's primary modifier: Cmd on macOS, Ctrl elsewhere.
 * @param {KeyboardEvent} event */
function mod(event) {
  return IS_MAC ? event.metaKey : event.ctrlKey;
}

/** The OS-standard "delete this item" chord: ⌘⌫ on macOS (Finder's move-to-trash),
 * the Delete key elsewhere. Bare — no extra modifiers — so it never collides with
 * editing chords like ⌥⌫ or ⇧⌘⌫.
 * @param {KeyboardEvent} event */
function isDeleteChord(event) {
  if (event.altKey || event.shiftKey) return false;
  return IS_MAC ? event.metaKey && !event.ctrlKey && event.key === "Backspace" : !event.metaKey && !event.ctrlKey && event.key === "Delete";
}

/** True while focus is in a text field — where ⌘⌫ is "delete to line start" and
 * Delete removes a character, so the sidebar delete chord must stand down. */
function isTypingTarget() {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/** Block sidebar destructive/rename chords while typing or with any modal/overlay up — a
 * confirm/prompt dialog (`.modal-backdrop`), search, the theme palette,
 * the Dario/usage/background-tasks popovers. Keeps it from double-firing into, or
 * deleting behind, an open dialog. */
function sidebarActionBlocked() {
  if (isTypingTarget()) return true;
  if (document.querySelector(".modal-backdrop")) return true;
  return state.search.open || state.themePaletteOpen || state.dario.open || state.bgTasksOpen || state.usagePopoverOpen;
}

export function installKeybindings() {
  window.addEventListener(
    "keydown",
    (event) => {
      // Chat search: Escape closes it before panic-stop (composer.js) can claim
      // Escape — a search over the room shouldn't abort the running turn.
      if (event.key === "Escape" && state.search.open) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeSearch();
        return;
      }
      // Cancel the theme palette first, before anything else claims Escape.
      if (event.key === "Escape" && state.themePaletteOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeThemePalette(false);
        return;
      }
      // The background-tasks popover, likewise, before panic-stop can claim Escape.
      if (event.key === "Escape" && state.bgTasksOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeBgTasks();
        return;
      }
      // The usage popover, likewise, before panic-stop can claim Escape.
      if (event.key === "Escape" && state.usagePopoverOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeUsagePopover();
        return;
      }
      // Then the Dario review popup.
      if (event.key === "Escape" && state.dario.open) {
        event.preventDefault();
        event.stopImmediatePropagation();
        state.dario.open = false;
        markDirty("dario");
        return;
      }
      // Delete the focused sidebar item — workspace or room — with the OS-native
      // delete chord (⌘⌫ on macOS, Del elsewhere). This is the ONLY way to delete
      // a workspace or room; there's no per-row button. App-specific (no native
      // menu standard), so it runs in both the shell and a plain browser.
      // Suppressed while typing (⌘⌫ is "delete to line start" in a field) or with
      // any modal/overlay up, so it never fights an open dialog.
      if (isDeleteChord(event) && !sidebarActionBlocked()) {
        const focus = effectiveSidebarFocus();
        if (focus) {
          event.preventDefault();
          if (focus.kind === "workspace") void deleteWorkspace(focus.id);
          else void deleteRoom(focus.id);
          return;
        }
      }

      // Rename the explicitly selected room with Enter. Double-clicking the row
      // does the same thing (sidebar.js); no separate pencil button.
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !sidebarActionBlocked()) {
        const focus = state.sidebarFocus;
        if (focus?.kind === "room") {
          const room = state.snapshot?.rooms.find((item) => item.id === focus.id);
          event.preventDefault();
          void renameRoom(focus.id, room?.title ?? room?.id ?? focus.id);
          return;
        }
      }

      const isMod = mod(event);
      const has = Boolean(state.snapshot);

      // Chat search palette (mod+K). Reachable open or closed so the same chord
      // focuses it; everything else below is suppressed while it's up.
      if (isMod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch("chatwide");
        return;
      }
      // Search the OPEN chat (mod+F) — same overlay, pre-scoped to this room.
      if (isMod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f" && has) {
        event.preventDefault();
        openSearch("room");
        return;
      }
      if (state.search.open) return;

      // Jump to tab N (mod+1..9) — in-web in every host (the menu doesn't carry
      // nine items for this).
      if (isMod && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key) && has) {
        event.preventDefault();
        jumpTab(Number(event.key) - 1);
        return;
      }

      // Theme palette (app-specific; no native-menu standard, so always in-web).
      if (event.altKey && !isMod && event.key.toLowerCase() === "t") {
        event.preventDefault();
        if (event.shiftKey) {
          cycleTheme(1);
          markDirty("status");
        } else if (state.themePaletteOpen) closeThemePalette(false);
        else openThemePalette();
        return;
      }

      // Window/tab chrome chords. Inside the shell the native menu owns these (so
      // they match the rest of macOS); handle them here only in a plain browser.
      if (isNative()) return;

      if (isMod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "t" && has) {
        event.preventDefault();
        newTab();
        return;
      }
      // New incognito (memory-off) room (mod+Alt+Shift+N). Checked before the
      // plain new-room chord since it also carries Shift+N. Code-based, not
      // key-based: on macOS Option composes a dead key, so `event.key` isn't "n".
      if (isMod && event.altKey && event.shiftKey && event.code === "KeyN" && has) {
        event.preventDefault();
        newIncognitoRoom();
        return;
      }
      // New room in the current workspace (mod+Shift+N). A tab is a room here, so
      // this is newTab under an explicit "new room" chord — auto-named, no dialog.
      if (isMod && event.shiftKey && !event.altKey && event.key.toLowerCase() === "n" && has) {
        event.preventDefault();
        newTab();
        return;
      }
      if (isMod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (isMod && event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        togglePanel();
        return;
      }
      // Next / previous tab: mod+Shift+] / mod+Shift+[ (code-based so it's layout
      // independent), plus mod+Alt+Arrows as an alternate.
      if (isMod && event.shiftKey && event.code === "BracketRight") {
        event.preventDefault();
        nextTab();
        return;
      }
      if (isMod && event.shiftKey && event.code === "BracketLeft") {
        event.preventDefault();
        prevTab();
        return;
      }
      if (isMod && event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        nextTab();
        return;
      }
      if (isMod && event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        prevTab();
      }
    },
    true,
  );
}
