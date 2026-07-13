// Entry point. The daemon serves these modules directly (no bundler); they are
// plain browser JavaScript, typechecked via JSDoc (web2/tsconfig.json).
import { loadApp, selectRoom } from "./actions.js";
import { installAttention } from "./attention.js";
import { adoptRoomTab, closeCurrent, dockBack, isOverlayLayout, newIncognitoRoom, newTab, nextTab, prevTab, togglePanel, toggleSidebar } from "./chrome.js";
import { focusComposerFromBackground, initComposer, installComposerRouting } from "./composer.js";
import { $ } from "./dom.js";
import { installKeybindings } from "./keys.js";
import { installOpenModifierTracking } from "./links.js";
import { launchIntent, onNativeEvent } from "./native.js";
import { markDirty, mountApp } from "./render.js";
import { recallLocation, state } from "./state.js";
import { clockText, initStatusbarPref } from "./statusbar.js";
import { initTheme } from "./themes.js";
import { installVoiceLifecycle } from "./voice.js";
import { installDictationLifecycle } from "./dictation.js";
// Region renderers registered by import side effect.
import "./dario.js";
import "./contextgate.js";
import "./panel.js";
import "./search.js";
import "./settings.js";
import "./sidebar.js";
import "./tabsbar.js";
import "./transcript.js";

// Restore the theme, status-bar visibility, and pane widths before the first
// paint so there is no flash.
initTheme();
initStatusbarPref();
restoreColumnWidths();

mountApp();
initComposer();

installOpenModifierTracking();
installComposerRouting();
installKeybindings();
installVoiceLifecycle();
installDictationLifecycle();
installNativeBridge();
installAttention();
window.addEventListener("pointerdown", focusComposerFromBackground);

// First paint of every region (empty states), then load the app.
markDirty();

// Keep the status-bar clock current without re-rendering anything else.
setInterval(() => {
  const clock = $("#statusClock");
  if (clock) clock.textContent = clockText();
}, 15000);

void boot();

/**
 * Restore the workspace + room the user last had open (persisted client-side)
 * so a refresh or daemon restart lands exactly where they were, rather than the
 * server's fallback workspace/room. A torn-off window is pinned to its own room
 * by the launch hash, so it skips the restore and lets applyLaunchIntent drive.
 */


async function boot() {
  const last = launchIntent().mode === "torn" ? null : recallLocation();
  await loadApp(last?.workspaceId);
  if (last && state.snapshot && state.snapshot.room.id !== last.roomId && state.snapshot.rooms.some((room) => room.id === last.roomId)) {
    await selectRoom(state.snapshot.workspace.id, last.roomId);
  }
  if (isOverlayLayout()) {
    // Phones boot showing the room; menus slide in on demand and never block the view.
    state.sidebarCollapsed = true;
    state.rightCollapsed = true;
    markDirty("layout", "tabs");
  }
  await applyLaunchIntent();
}

/**
 * A window spawned by the shell carries its role in the launch hash. A torn-off
 * chat opens as the standard view with both side panels collapsed (reusing the
 * existing collapse state — no new stripped layout) and focused on that room; a
 * "new" window and the primary window keep the normal layout.
 */
async function applyLaunchIntent() {
  const intent = launchIntent();
  if (intent.mode !== "torn") return;
  state.sidebarCollapsed = true;
  state.rightCollapsed = true;
  markDirty("layout", "tabs");
  if (intent.room && state.snapshot && intent.room !== state.snapshot.room?.id) {
    await selectRoom(state.snapshot.workspace.id, intent.room);
    state.sidebarCollapsed = true;
    state.rightCollapsed = true;
    markDirty("layout", "tabs");
  }
}

/**
 * Wire the native shell's cross-window channels. All no-ops in a plain browser.
 * The native menu forwards its chrome actions here (New/Close Window are handled
 * in the shell itself); a torn window merging back re-adopts its chat as a tab.
 */
function installNativeBridge() {
  void onNativeEvent("gaia://menu", (event) => {
    switch (String(event.payload)) {
      case "new_tab":
      case "new_room": // a tab is a room here; both create an auto-named room
        newTab();
        break;
      case "new_incognito_room":
        newIncognitoRoom();
        break;
      case "close_tab":
        closeCurrent();
        break;
      case "next_tab":
        nextTab();
        break;
      case "prev_tab":
        prevTab();
        break;
      case "toggle_sidebar":
        toggleSidebar();
        break;
      case "toggle_panel":
        togglePanel();
        break;
      case "dock_back":
        dockBack();
        break;
    }
  });
  void onNativeEvent("gaia://redock", (event) => adoptRoomTab(String(event.payload)));
}

function restoreColumnWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem("gaia.cols") ?? "{}");
    if (saved.left) document.documentElement.style.setProperty("--w-left", saved.left);
    if (saved.right) document.documentElement.style.setProperty("--w-right", saved.right);
  } catch {
    // no saved widths — defaults from the stylesheet apply.
  }
}

// Live-reload while the daemon runs in dev mode is provided by a server-injected
// snippet (see devReloadSnippet in src/server/http.ts), added to index.html only
// in dev — so it never fires, or connects to a non-existent route, outside dev.
