// tmux-flavoured keyboard control. These all use a modifier, so they never
// collide with the composer's bare-key routing (which ignores modified keys).
//   Ctrl/Cmd+T      new room (tab)
//   Alt+1..9        jump to room tab N
//   Ctrl+Tab / Alt+←/→   next / previous tab
//   Ctrl+B          toggle the sessions sidebar
//   Ctrl+G          toggle the room panel
//   Alt+T           theme palette   ·   Alt+Shift+T  cycle theme
//   Esc             close the theme palette
import { addRoom, selectRoom } from "./actions.js";
import { markDirty } from "./render.js";
import { closeSearch, openSearch } from "./search.js";
import { state } from "./state.js";
import { closeThemePalette, openThemePalette } from "./statusbar.js";
import { visibleTabs } from "./tabs.js";
import { cycleTheme } from "./themes.js";

/** @param {number} index */
function jumpTo(index) {
  const tabs = visibleTabs(state.snapshot);
  const room = tabs[index];
  if (room && state.snapshot && room.id !== state.snapshot.room?.id) void selectRoom(state.snapshot.workspace.id, room.id);
}

/** @param {number} direction */
function step(direction) {
  const tabs = visibleTabs(state.snapshot);
  if (tabs.length < 2) return;
  const current = tabs.findIndex((room) => room.id === state.snapshot?.room?.id);
  const next = tabs[(current + direction + tabs.length) % tabs.length];
  if (next && state.snapshot && next.id !== state.snapshot.room?.id) void selectRoom(state.snapshot.workspace.id, next.id);
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
      // Then the Dario review popup.
      if (event.key === "Escape" && state.dario.open) {
        event.preventDefault();
        event.stopImmediatePropagation();
        state.dario.open = false;
        markDirty("dario");
        return;
      }
      // Then the settings modal.
      if (event.key === "Escape" && state.settingsOpen) {
        event.preventDefault();
        state.settingsOpen = false;
        markDirty("settings");
        return;
      }

      const meta = event.metaKey || event.ctrlKey;
      const has = Boolean(state.snapshot);

      // Chat search palette (Cmd/Ctrl+K). Reachable open or closed so the same
      // chord focuses it; everything else below is suppressed while it's up.
      if (meta && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch("chatwide");
        return;
      }
      // Search the OPEN chat (Cmd/Ctrl+F) — same overlay, pre-scoped to this room.
      if (meta && !event.altKey && event.key.toLowerCase() === "f" && has) {
        event.preventDefault();
        openSearch("room");
        return;
      }
      if (state.search.open) return;

      // New room tab.
      if (meta && !event.altKey && event.key.toLowerCase() === "t" && has) {
        event.preventDefault();
        void addRoom();
        return;
      }
      // Toggle panes.
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        state.sidebarCollapsed = !state.sidebarCollapsed;
        markDirty("layout", "tabs");
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        state.rightCollapsed = !state.rightCollapsed;
        markDirty("layout", "tabs");
        return;
      }
      // Themes.
      if (event.altKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        if (event.shiftKey) {
          cycleTheme(1);
          markDirty("status");
        } else if (state.themePaletteOpen) closeThemePalette(false);
        else openThemePalette();
        return;
      }
      // Cycle tabs.
      if ((event.ctrlKey && event.key === "Tab") || (event.altKey && event.key === "ArrowRight")) {
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
        return;
      }
      // Jump to tab N.
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key) && has) {
        event.preventDefault();
        jumpTo(Number(event.key) - 1);
      }
    },
    true,
  );
}
