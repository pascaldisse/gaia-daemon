// tmux-flavoured keyboard control. These all use a modifier, so they never
// collide with the composer's bare-key routing (which ignores modified keys).
//   Ctrl/Cmd+T      new room (tab)
//   Alt+1..9        jump to room tab N
//   Ctrl+Tab / Alt+←/→   next / previous tab
//   Ctrl+B          toggle the sessions sidebar
//   Ctrl+G          toggle the room panel
//   Alt+T           theme palette   ·   Alt+Shift+T  cycle theme
//   Esc             close the theme palette
import { addRoom, selectRoom } from "./actions.ts";
import { openThemePalette, closeThemePalette, render } from "./render.ts";
import { state } from "./state.ts";
import { visibleTabs } from "./tabs.ts";
import { cycleTheme } from "./themes.ts";

function jumpTo(index) {
  const tabs = visibleTabs(state.snapshot);
  const room = tabs[index];
  if (room && room.id !== state.snapshot?.room?.id) void selectRoom(state.snapshot.workspace.id, room.id);
}

function step(direction) {
  const tabs = visibleTabs(state.snapshot);
  if (tabs.length < 2) return;
  const current = tabs.findIndex((room) => room.id === state.snapshot?.room?.id);
  const next = tabs[(current + direction + tabs.length) % tabs.length];
  if (next && next.id !== state.snapshot?.room?.id) void selectRoom(state.snapshot.workspace.id, next.id);
}

export function installKeybindings() {
  window.addEventListener(
    "keydown",
    (event) => {
      // Cancel the theme palette first, before anything else claims Escape.
      if (event.key === "Escape" && state.themePaletteOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeThemePalette(false);
        return;
      }

      const meta = event.metaKey || event.ctrlKey;
      const has = state.snapshot;

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
        render();
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        state.rightCollapsed = !state.rightCollapsed;
        render();
        return;
      }
      // Themes.
      if (event.altKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        if (event.shiftKey) {
          cycleTheme(1);
          render();
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
